// The electrical design calculation: PV string sizing, transformer selection, cable sizing (current rating, voltage drop, I²R
// loss) and the annual losses integrated over the hourly profiles. Plain functions of the project and the last results
// (ctx = { PVR, SIM }), no browser. The design feeds the screen, the single-line diagram, the load flow and the report.
import { fmtNum, fmtPct } from '../format.js';
import { maxOf } from '../ws/util.js';
import { HOURS, sum } from '../series.js';
import { findIn, selectedIn } from './library.js';
import { plantLengths } from './siteplan.js';

const SQ3 = Math.sqrt(3);
const alpha = (mat) => (/al/i.test(mat || '') ? 0.00403 : 0.00393);
export const rHot = (c) => c.r20 * (1 + alpha(c.material) * 50) / 1000;   // Ω/m at 70 °C
export const cableClass = (c) => (/dc/i.test(c.rating || '') ? 'dc' : /0\.6\/1|1 kv|0,6/i.test(c.rating || '') ? 'lv' : 'mv');
const vdrop = (c, cab, runs) => { const R = rHot(cab), X = (cab.x || 0) / 1000, pf = c.pf || 1; return (c.kind === 'dc' ? 2 * c.I * R * c.L / runs / c.V : SQ3 * c.I * (R * pf + X * Math.sqrt(1 - pf * pf)) * c.L / runs / c.V) * (c.dvF || 1); };
const dvLimit = (P, cls) => (cls === 'dc' ? P.electrical.dv_dc : cls === 'lv' ? P.electrical.dv_lv : P.electrical.dv_mv);

// hourly per-unit profiles of PV, battery, gensets and load
function profiles(P, { PVR, SIM }) {
  const H = SIM && SIM.result && SIM.result.hourly;
  const pv = PVR ? PVR.ac_per_kwp.map((x) => x * P.pv.dc_ac_ratio) : (H ? H.pv_avail.map((x) => x / Math.max(1, P.pv.capacity_kwp / P.pv.dc_ac_ratio)) : null);
  const Pb = Math.max(1, P.bess.power_kw);
  const bess = H ? H.bess_dis.map((d, t) => (d + H.pv_to_bess[t] + (H.wind_to_bess ? H.wind_to_bess[t] : 0) + H.gen_to_bess[t]) / Pb) : null;
  const genU = H ? H.gen_units : null;
  const genLf = H ? H.gen_units.map((u, t) => (u ? (H.gen_to_load[t] + H.gen_to_bess[t] + H.gen_dump[t]) / (u * P.diesel.unit_kw) : 0)) : null;
  const pk = P.load.kw ? maxOf(P.load.kw) : 1;
  const load = P.load.kw ? P.load.kw.map((x) => x / pk) : null;
  return { pv, bess, genU, genLf, load };
}
const sumSq = (a) => (a ? a.reduce((s, x) => s + x * x, 0) : null);

// The design of the open project: strings, transformers, cable circuits, losses and warnings.
export function computeDesign(P, ctx) {
  const { PVR, SIM } = ctx;
  const E = P.electrical, pv = selectedIn(P, 'pv'), inv = selectedIn(P, 'inverter'), bat = selectedIn(P, 'battery'), dg = selectedIn(P, 'genset');
  const tr = (id) => findIn(P.equipment.lib, 'transformer', id), cb = (id) => findIn(P.equipment.lib, 'cable', id);
  const warn = [], out = { warn, circuits: [], trafos: [] };
  const tmin = E.t_min != null ? E.t_min : (P.weather && P.weather.tamb ? Math.floor(Math.min(...P.weather.tamb)) - 2 : 10);
  out.tmin = tmin;

  // --- PV strings ---
  if (pv && inv) {
    const voc = (T) => pv.voc * (1 + pv.beta_voc / 100 * (T - 25));
    // Vmp falls faster than Voc. Without a datasheet value, γPmax − αIsc is slightly steeper than the true
    // coefficient, so it is conservative at both ends of the MPPT window. A blank αIsc takes 0.05 %/°C, the high end of
    // real values, so the estimate stays steeper.
    const num = (x) => typeof x === 'number' && isFinite(x);
    const bVmpGiven = num(pv.beta_vmp), gGiven = num(pv.gamma_p), aGiven = num(pv.alpha_isc);
    const bVmp = bVmpGiven ? pv.beta_vmp : gGiven ? pv.gamma_p - (aGiven ? pv.alpha_isc : 0.05) : pv.beta_voc;
    if (!bVmpGiven && !gGiven) warn.push('Temp. coeff. Vmp and Temp. coeff. Pmax are blank in the module datasheet: Vmp uses Temp. coeff. Voc, which is flatter than the true coefficient and not conservative.');
    else if (!bVmpGiven && !aGiven) warn.push('Temp. coeff. Isc is blank in the module datasheet: the Vmp coefficient is estimated as Temp. coeff. Pmax − 0.05 %/°C.');
    const vmp = (T) => pv.vmp * (1 + bVmp / 100 * (T - 25));
    const tHot = E.t_cell_max != null ? E.t_cell_max : 70;
    // hourly cell temperature of the yield model at useful irradiance, 99.9th percentile
    let tModel = null;
    if (PVR && PVR.tcell && PVR.poa) {
      const tc = PVR.tcell.filter((_, i) => PVR.poa[i] > 200).sort((a, b) => a - b);
      if (tc.length) { const k = (tc.length - 1) * 0.999, lo = Math.floor(k), hi = Math.ceil(k); tModel = tc[lo] + (tc[hi] - tc[lo]) * (k - lo); }
    }
    if (tModel != null && tHot < tModel + 5) warn.push(`Max cell temperature ${tHot} °C is less than 5 °C above the thermal model's 99.9th percentile (${fmtNum(tModel, 1)} °C). Hourly means miss short peaks: use at least ${Math.ceil(tModel + 5)} °C.`);
    const vmax = Math.min(inv.vdc_max, pv.vsys || inv.vdc_max);
    const nMax = Math.floor(vmax / voc(tmin));
    const nMin = Math.ceil(inv.vmppt_min / vmp(tHot));
    const nMppt = Math.floor(inv.vmppt_max / vmp(tmin));
    let ns = E.modules_per_string > 0 ? E.modules_per_string : Math.min(nMax, nMppt);
    if (ns > nMax) warn.push(`String of ${ns} modules exceeds the maximum ${nMax} (Voc at ${tmin} °C = ${fmtNum(ns * voc(tmin))} V > ${vmax} V).`);
    if (ns < nMin) warn.push(`String of ${ns} modules is below the MPPT minimum (${nMin}) at ${tHot} °C cell temperature.`);
    const nModTarget = P.pv.capacity_kwp * 1000 / pv.pmax;
    const nStrings = Math.max(1, Math.round(nModTarget / ns));
    const kwp = nStrings * ns * pv.pmax / 1000;
    const nInv = Math.max(1, Math.ceil(kwp / P.pv.dc_ac_ratio / inv.pac_kw));
    const spi = nStrings / nInv;
    const spm = Math.ceil(spi / Math.max(1, inv.n_mppt));
    const iMppt = spm * pv.isc * 1.25;
    if (iMppt > inv.imax_mppt) warn.push(`${spm} strings per MPPT draw up to ${fmtNum(iMppt, 0)} A (1.25 × Isc) > inverter limit ${inv.imax_mppt} A. Add inverters or use string combiners.`);
    if (kwp / nInv > inv.pdc_max_kw) warn.push(`DC power per inverter ${fmtNum(kwp / nInv)} kW exceeds the datasheet maximum ${inv.pdc_max_kw} kW.`);
    out.str = { ns, nMin, nMax, nMppt, nStrings, nModules: nStrings * ns, kwp, nInv, spi, spm, iMppt, vocMax: ns * voc(tmin), vmpHot: ns * vmp(tHot), vmpCold: ns * vmp(tmin), dcac: kwp / (nInv * inv.pac_kw), pv, inv,
      tHot, tModel, bVmp, bVmpSrc: bVmpGiven ? 'datasheet' : !gGiven ? 'Temp. coeff. Voc (Temp. coeff. Pmax blank)' : aGiven ? 'estimated: γPmax − αIsc' : 'estimated: γPmax − 0.05 (Temp. coeff. Isc blank)' };
  } else warn.push('Select a PV module and an inverter in Equipment datasheets (tab 8).');

  // --- transformers ---
  const prof = profiles(P, ctx);
  const trPV = tr(E.trafo_pv), trB = tr(E.trafo_bess), trG = tr(E.trafo_gen), trL = tr(E.trafo_load);
  const addTrafo = (role, t, n, sLoadPu, energizedHours, peakKva) => {
    if (!t || n <= 0) return null;
    const loadLoss = sLoadPu ? t.pk * sLoadPu : null;           // Σ (S/Sn)² over the year × Pk
    const noLoad = t.p0 * energizedHours;
    const r = { role, t, n, loading: peakKva / (n * t.kva), annual_kwh: loadLoss != null ? noLoad + loadLoss : null, noLoad, loadLoss };
    if (r.loading > 1.0) warn.push(`${role}: ${n} × ${fmtNum(t.kva)} kVA transformer(s) loaded to ${fmtPct(r.loading, 0)} at peak.`);
    out.trafos.push(r);
    return r;
  };
  let nTrPV = 0, invPerTr = 1;
  if (out.str && trPV) {
    invPerTr = Math.max(1, Math.floor(trPV.kva / out.str.inv.pac_kw));
    nTrPV = Math.ceil(out.str.nInv / invPerTr);
    const sn = nTrPV * trPV.kva;
    const s2 = prof.pv ? prof.pv.reduce((a, p) => a + Math.pow(p * out.str.nInv * out.str.inv.pac_kw / sn, 2), 0) * nTrPV : null;
    addTrafo('PV step-up', trPV, nTrPV, s2, HOURS * nTrPV, out.str.nInv * out.str.inv.pac_kw);
  }
  out.nTrPV = nTrPV; out.invPerTr = invPerTr;
  const Pb = P.bess.power_kw, hasB = P.bess.energy_kwh > 0 && Pb > 0;
  let nB = 0, nTrB = 0;
  if (hasB) {
    nB = bat && bat.power_kw ? Math.max(1, Math.ceil(Pb / bat.power_kw)) : 1;
    if (trB) {
      nTrB = Math.ceil(Pb / trB.kva);
      const s2 = prof.bess ? prof.bess.reduce((a, p) => a + Math.pow(p * Pb / (nTrB * trB.kva), 2), 0) * nTrB : null;
      addTrafo('BESS step-up', trB, nTrB, s2, HOURS * nTrB, Pb);
    }
  }
  out.nB = nB; out.nTrB = nTrB;
  const nG = P.diesel.units, gKva = dg ? dg.kva : P.diesel.unit_kw / 0.8, gpt = Math.max(1, E.gens_per_trafo);
  let nTrG = 0;
  if (!E.gen_mv && trG && nG > 0) {
    nTrG = Math.ceil(nG / gpt);
    let s2 = null, hrs = HOURS * nTrG;
    if (prof.genU) {
      s2 = 0; hrs = 0;
      for (let t = 0; t < HOURS; t++) {
        const u = prof.genU[t]; if (!u) continue;
        const on = Math.ceil(u / gpt);
        hrs += on;
        s2 += on * Math.pow((u / on) * prof.genLf[t] * P.diesel.unit_kw / 0.8 / trG.kva, 2);
      }
    }
    addTrafo('Genset step-up', trG, nTrG, s2, hrs, gpt * gKva * nTrG);
  }
  out.nTrG = nTrG; out.nG = nG; out.gKva = gKva; out.gpt = gpt;
  const peak = P.load.kw ? maxOf(P.load.kw) : 0;
  if (trL) { const nL = Math.ceil(peak / E.pf_load / trL.kva); addTrafo('Load step-down', trL, nL, prof.load ? prof.load.reduce((a, p) => a + Math.pow(p * peak / E.pf_load / (nL * trL.kva), 2), 0) * nL : null, HOURS * nL, peak / E.pf_load); }

  // --- cables ---
  const Vmv = E.mv_kv * 1000;
  const nFeed = nTrPV ? Math.ceil(nTrPV / Math.max(1, E.pv_per_feeder)) : 0;
  const trPerFeed = nFeed ? nTrPV / nFeed : 1;
  const dist = (n) => ({ loss: n > 1 ? (n + 1) * (2 * n + 1) / (6 * n * n) : 1, dv: n > 1 ? (n + 1) / (2 * n) : 1 });
  const def = [];
  if (out.str) {
    const s = out.str;
    def.push({ key: 'dc', name: 'PV string cables (DC, per string, both poles)', kind: 'dc', V: s.vmpHot, I: s.pv.isc * 1.25, Iop: s.pv.imp, count: s.nStrings, pu: prof.pv ? prof.pv.map((p) => p / P.pv.dc_ac_ratio / Math.max(0.5, P.pv.inverter_eff)) : null, cls: 'dc' });
    def.push({ key: 'lv_pv', name: 'Inverter → PV transformer (LV AC, per inverter)', kind: 'ac', V: s.inv.vac, I: s.inv.pac_kw * 1000 / (SQ3 * s.inv.vac), count: s.nInv, pu: prof.pv, cls: 'lv' });
    if (nFeed) {
      const f = dist(Math.round(trPerFeed));
      def.push({ key: 'mv_pv', name: `PV MV collector feeder (${fmtNum(trPerFeed, 1)} transformers each)`, kind: 'ac', V: Vmv, I: trPerFeed * invPerTr * s.inv.pac_kw * 1000 / (SQ3 * Vmv), count: nFeed, pu: prof.pv, cls: 'mv', lossF: f.loss, dvF: f.dv });
    }
  }
  if (hasB) {
    def.push({ key: 'lv_bess', name: 'PCS → BESS transformer (LV AC, per PCS)', kind: 'ac', V: bat ? bat.vac : 690, I: (Pb / nB) * 1000 / (SQ3 * (bat ? bat.vac : 690)), count: nB, pu: prof.bess, cls: 'lv' });
    def.push({ key: 'mv_bess', name: 'BESS MV feeder', kind: 'ac', V: Vmv, I: Pb * 1000 / (SQ3 * Vmv), count: 1, pu: prof.bess, cls: 'mv' });
  }
  if (nG > 0) {
    const gV = dg ? dg.voltage : 400;
    if (!E.gen_mv) def.push({ key: 'lv_gen', name: 'Genset → transformer (LV, per genset)', kind: 'ac', V: gV, I: gKva * 1000 / (SQ3 * gV), count: nG, gen: true, cls: 'lv' });
    def.push({ key: 'mv_gen', name: E.gen_mv ? 'Genset MV feeder (per genset)' : 'Genset transformer → MV bus', kind: 'ac', V: Vmv, I: (E.gen_mv ? gKva : gpt * gKva) * 1000 / (SQ3 * Vmv), count: E.gen_mv ? nG : nTrG, gen: true, genGroup: E.gen_mv ? 1 : gpt, cls: 'mv' });
  }
  if (peak > 0) def.push({ key: 'load', name: 'MV feeder to plant load', kind: 'ac', V: Vmv, I: peak / E.pf_load * 1000 / (SQ3 * Vmv), count: 1, pu: prof.load, cls: 'mv', pf: E.pf_load });

  const PL = plantLengths(P);   // lengths measured on the layout map, for the circuits that can be (siteplan.js)
  for (const c of def) {
    const cab = cb(E.cable[c.key]);
    const m = PL && PL[c.key];
    const L = m ? m.len : E.len[c.key] || 0, runs = Math.max(1, E.runs[c.key] || 1);
    /** @type {any} */
    const r = { ...c, cab, L, runs };
    if (m) Object.assign(r, { fromLayout: true, Lmax: m.max, lenFrom: m.from });
    if (cab) {
      const R = rHot(cab);
      r.amp = cab.ampacity * runs * E.derate;
      r.util = c.I / r.amp;
      r.dv = vdrop(r, cab, runs);
      if (m && m.max > L) r.dvMax = vdrop({ ...r, L: m.max }, cab, runs);   // the longest run: the string or feeder that drops most
      const Iloss = c.Iop || c.I;
      r.ploss = (c.kind === 'dc' ? 2 : 3) * Iloss * Iloss * R * L / runs * (c.lossF || 1) / 1000;   // kW per circuit at rated
      // annual energy: rated loss × Σ (per-unit current)² for each circuit
      if (c.gen) {
        if (prof.genU) {
          let s2 = 0;
          for (let t = 0; t < HOURS; t++) {
            const u = prof.genU[t]; if (!u) continue;
            if (c.key === 'lv_gen' || c.genGroup === 1) s2 += u * prof.genLf[t] * prof.genLf[t];
            else { const on = Math.ceil(u / c.genGroup); s2 += on * Math.pow((u / on / c.genGroup) * prof.genLf[t], 2); }
          }
          r.annual = r.ploss * s2;
        } else r.annual = null;
      } else r.annual = c.pu ? r.ploss * c.count * sumSq(c.pu) : null;
      r.cost = (cab.price || 0) * L * runs * (c.kind === 'dc' ? 2 : cab.cores >= 3 ? 1 : 3) * c.count;
      const lim = dvLimit(P, c.cls);
      r.lim = lim;
      if (r.util > 1) warn.push(`${c.name}: ${fmtNum(c.I, 0)} A exceeds the derated rating ${fmtNum(r.amp, 0)} A. Use a larger cable or more parallel runs.`);
      if (r.dv * 100 > lim) warn.push(`${c.name}: voltage drop ${(r.dv * 100).toFixed(2)} % exceeds the ${lim} % limit.`);
      else if (r.dvMax != null && r.dvMax * 100 > lim) warn.push(`${c.name}: the longest run (${fmtNum(m.max, 0)} m) drops ${(r.dvMax * 100).toFixed(2)} %, over the ${lim} % limit; the average run is within it.`);
    } else warn.push(`${c.name}: no cable selected.`);
    out.circuits.push(r);
  }

  // --- loss summary (year 1) ---
  const annual = (keys) => out.circuits.filter((c) => keys.includes(c.key)).reduce((a, c) => a + (c.annual || 0), 0);
  const trA = (role, k = 'annual_kwh') => out.trafos.filter((t) => t.role === role).reduce((a, t) => a + (t[k] || 0), 0);
  const noload = (role) => out.trafos.filter((t) => t.role === role).reduce((a, t) => a + t.t.p0 * t.n, 0);
  const pvAc = PVR ? sum(PVR.ac_per_kwp) * P.pv.capacity_kwp : null;
  const pvDc = pvAc != null ? pvAc / Math.max(0.5, P.pv.inverter_eff) : null;
  const cabPv = annual(['lv_pv', 'mv_pv']), cabBess = annual(['lv_bess', 'mv_bess']), nlPv = noload('PV step-up'), nlBess = noload('BESS step-up');
  out.loss = {
    pv_dc: annual(['dc']), pv_ac: cabPv + trA('PV step-up'),
    bess: cabBess + trA('BESS step-up'), gen: annual(['lv_gen', 'mv_gen']) + trA('Genset step-up'),
    load: annual(['load']) + trA('Load step-down'), pvAc, pvDc,
    // fed back to the model: PV and BESS paths with the transformer load loss only; their no-load loss is an auxiliary load
    pv_ac_ll: cabPv + trA('PV step-up', 'loadLoss'), bess_ll: cabBess + trA('BESS step-up', 'loadLoss'),
    // no-load by component: the PV transformers run with PV, the BESS ones only with a battery
    noload_pv_kw: nlPv, noload_bess_kw: nlBess, noload_kw: nlPv + nlBess,
    bessThroughput: SIM ? SIM.result.years[0].bess_dis + SIM.result.years[0].bess_ch : null,
    genEnergy: SIM ? SIM.result.years[0].gen_kwh : null,
  };
  out.cost = out.circuits.reduce((a, c) => a + (c.cost || 0), 0) + out.trafos.reduce((a, t) => a + (t.t.price || 0) * t.n, 0);
  out.hasProfiles = !!(PVR || SIM);
  return out;
}

// The smallest cable (and fewest parallel runs) of each circuit that meets its current rating and voltage-drop limit. Writes the
// choices into P.electrical; returns how many circuits changed.
export function autoSize(P, ctx) {
  const E = P.electrical, lib = P.equipment.lib.cable;
  let changed = 0;
  for (const c of computeDesign(P, ctx).circuits) {
    const cands = lib.filter((x) => cableClass(x) === c.cls).sort((a, b) => a.csa - b.csa);
    const lim = dvLimit(P, c.cls) / 100;
    let pick = null;
    for (let runs = 1; runs <= 12 && !pick; runs++)
      for (const x of cands) {
        const dv = vdrop(c.Lmax > c.L ? { ...c, L: c.Lmax } : c, x, runs);   // the longest run measured on the layout, else the length
        if (c.I <= x.ampacity * runs * E.derate && dv <= lim) { pick = { x, runs }; break; }
      }
    if (pick) { E.cable[c.key] = pick.x.id; E.runs[c.key] = pick.runs; changed++; }
  }
  return changed;
}

// Feeds the losses of the design back into the model inputs. `base` holds the battery efficiency before the first application, so
// repeated applications do not compound it ({ rte, set }); it is returned. Throws a message when there is nothing to apply.
export function applyLosses(P, D, base) {
  if (!D || !D.hasProfiles || !D.loss.pvAc) throw new Error('Calculate the PV yield first (tab 4).');
  const L = D.loss, E = P.electrical;
  P.pv.dc_wiring = +(L.pv_dc / L.pvDc).toFixed(5);
  P.pv.dc_wiring_basis = 'annual';   // an energy-weighted loss over the year, not the loss at STC power
  P.pv.ac_losses = +(L.pv_ac_ll / L.pvAc).toFixed(5);   // cables + transformer load loss
  P.aux.trafo_noload_kw = +L.noload_pv_kw.toFixed(3);          // no-load loss is drawn day and night: an auxiliary load,
  P.aux.bess_trafo_noload_kw = +L.noload_bess_kw.toFixed(3);   // each part counted only with the asset it serves
  if (D.str) { P.pv.dc_ac_ratio = +D.str.dcac.toFixed(3); P.pv.capacity_kwp = Math.round(D.str.kwp); }
  // values set here, so the report can tell them from typed ones
  E.applied = { dc_wiring: P.pv.dc_wiring, ac_losses: P.pv.ac_losses, dc_ac_ratio: P.pv.dc_ac_ratio, trafo_noload_kw: P.aux.trafo_noload_kw,
    bess_trafo_noload_kw: P.aux.bess_trafo_noload_kw };
  let next = base;
  if (L.bessThroughput) {
    if (!next || next.set !== P.bess.rte) next = { rte: P.bess.rte };
    const f = L.bess_ll / L.bessThroughput;  // fraction lost per pass through the BESS path (charge + discharge)
    P.bess.rte = next.set = +(next.rte * (1 - f) * (1 - f)).toFixed(4);
  }
  return next || null;
}

export const applyText = (P, D) => `Model updated: DC wiring ${fmtPct(P.pv.dc_wiring, 2)} (annual basis), AC losses ${fmtPct(P.pv.ac_losses, 2)} (cables and transformer load loss), DC/AC ${P.pv.dc_ac_ratio}, PV ${fmtNum(P.pv.capacity_kwp)} kWp${D.loss.bessThroughput ? ', BESS RTE ' + fmtPct(P.bess.rte, 1) : ''}. Transformer no-load loss PV ${fmtNum(P.aux.trafo_noload_kw, 1)} kW and BESS ${fmtNum(P.aux.bess_trafo_noload_kw, 1)} kW set as auxiliary loads (Battery tab). Re-run the simulation.`;
