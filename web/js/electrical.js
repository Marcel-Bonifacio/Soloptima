// Electrical design: PV string sizing, transformer selection, cable sizing (ampacity, voltage drop, I²R loss)
// and annual losses integrated over the hourly profiles. Results feed the single-line diagram and the report.
'use strict';

const Electrical = (() => {
  let P, onChange, D = null;
  let rteBase = null;   // BESS RTE before the cable/transformer derating, so repeated Apply does not compound it
  const SQ3 = Math.sqrt(3);
  const alpha = (mat) => (/al/i.test(mat || '') ? 0.00403 : 0.00393);
  const rHot = (c) => c.r20 * (1 + alpha(c.material) * 50) / 1000;   // Ω/m at 70 °C
  const cableClass = (c) => (/dc/i.test(c.rating || '') ? 'dc' : /0\.6\/1|1 kv|0,6/i.test(c.rating || '') ? 'lv' : 'mv');
  const vdrop = (c, cab, runs) => { const R = rHot(cab), X = (cab.x || 0) / 1000, pf = c.pf || 1; return (c.kind === 'dc' ? 2 * c.I * R * c.L / runs / c.V : SQ3 * c.I * (R * pf + X * Math.sqrt(1 - pf * pf)) * c.L / runs / c.V) * (c.dvF || 1); };
  const dvLimit = (cls) => (cls === 'dc' ? P.electrical.dv_dc : cls === 'lv' ? P.electrical.dv_lv : P.electrical.dv_mv);

  function init(project, changed) {
    P = project; onChange = changed;
    $('#elAuto').onclick = autoSize;
    $('#elApply').onclick = applyLosses;
    $('#sldCables').onchange = () => SLD.render(D, P);
    $('#sldSvg').onclick = () => SLD.exportSvg();
    $('#sldPng').onclick = () => SLD.exportPng();
    $('#lfRun').onclick = runLoadFlow;
    $('#lfHour').onchange = drawLf;
  }
  function reload(project) { P = project; rteBase = null; }

  // ------------------------------------------------------------------ hourly per-unit profiles
  function profiles() {
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

  // ------------------------------------------------------------------ design calculation
  function compute() {
    const E = P.electrical, pv = Equipment.selected('pv'), inv = Equipment.selected('inverter'), bat = Equipment.selected('battery'), dg = Equipment.selected('genset');
    const tr = (id) => Equipment.find('transformer', id), cb = (id) => Equipment.find('cable', id);
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
    const prof = profiles();
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

    for (const c of def) {
      const cab = cb(E.cable[c.key]);
      const L = E.len[c.key] || 0, runs = Math.max(1, E.runs[c.key] || 1);
      const r = { ...c, cab, L, runs };
      if (cab) {
        const R = rHot(cab);
        r.amp = cab.ampacity * runs * E.derate;
        r.util = c.I / r.amp;
        r.dv = vdrop(r, cab, runs);
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
        const lim = dvLimit(c.cls);
        r.lim = lim;
        if (r.util > 1) warn.push(`${c.name}: ${fmtNum(c.I, 0)} A exceeds the derated rating ${fmtNum(r.amp, 0)} A. Use a larger cable or more parallel runs.`);
        if (r.dv * 100 > lim) warn.push(`${c.name}: voltage drop ${(r.dv * 100).toFixed(2)} % exceeds the ${lim} % limit.`);
      } else warn.push(`${c.name}: no cable selected.`);
      out.circuits.push(r);
    }

    // --- loss summary (year 1) ---
    const annual = (keys) => out.circuits.filter((c) => keys.includes(c.key)).reduce((a, c) => a + (c.annual || 0), 0);
    const trA = (role, k = 'annual_kwh') => out.trafos.filter((t) => t.role === role).reduce((a, t) => a + (t[k] || 0), 0);
    const noload = (role) => out.trafos.filter((t) => t.role === role).reduce((a, t) => a + t.t.p0 * t.n, 0);
    const pvAc = PVR ? sum(PVR.ac_per_kwp) * P.pv.capacity_kwp : null;
    const pvDc = pvAc != null ? pvAc / Math.max(0.5, P.pv.inverter_eff) : null;
    out.loss = {
      pv_dc: annual(['dc']), pv_ac: annual(['lv_pv', 'mv_pv']) + trA('PV step-up'),
      bess: annual(['lv_bess', 'mv_bess']) + trA('BESS step-up'), gen: annual(['lv_gen', 'mv_gen']) + trA('Genset step-up'),
      load: annual(['load']) + trA('Load step-down'), pvAc, pvDc,
      // fed back to the model: PV and BESS paths with the transformer load loss only; their no-load loss is an auxiliary load
      pv_ac_ll: annual(['lv_pv', 'mv_pv']) + trA('PV step-up', 'loadLoss'), bess_ll: annual(['lv_bess', 'mv_bess']) + trA('BESS step-up', 'loadLoss'),
      // no-load by component: the PV transformers run with PV, the BESS ones only with a battery
      noload_pv_kw: noload('PV step-up'), noload_bess_kw: noload('BESS step-up'), noload_kw: noload('PV step-up') + noload('BESS step-up'),
      bessThroughput: SIM ? SIM.result.years[0].bess_dis + SIM.result.years[0].bess_ch : null,
      genEnergy: SIM ? SIM.result.years[0].gen_kwh : null,
    };
    out.cost = out.circuits.reduce((a, c) => a + (c.cost || 0), 0) + out.trafos.reduce((a, t) => a + (t.t.price || 0) * t.n, 0);
    out.hasProfiles = !!(PVR || SIM);
    return out;
  }

  // ------------------------------------------------------------------ UI
  function basisForm() {
    const E = P.electrical, lib = P.equipment.lib;
    const trOpts = (sel, none) => (none ? '<option value="">None (load at MV)</option>' : '') + lib.transformer.map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === sel ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
    const num = (k, l, u, step = 'any', ph = '') => `<label>${l}${infoBtn('el.' + k, l)}</label><div class="field"><input type="number" step="${step}" data-el="${k}" value="${escapeHtml(E[k] ?? '')}" placeholder="${ph}">${u ? `<span class="unit">${u}</span>` : ''}</div>`;
    $('#elBasis').innerHTML = [
      num('mv_kv', 'MV collector voltage', 'kV'),
      num('t_min', 'Site minimum temperature', '°C', 'any', 'from weather data'),
      num('t_cell_max', 'Max cell temperature', '°C'),
      num('modules_per_string', 'Modules per string (0 = auto)', '', 1),
      `<label>PV transformer</label><div class="field"><select data-el="trafo_pv">${trOpts(E.trafo_pv)}</select></div>`,
      num('pv_per_feeder', 'PV transformers per MV feeder', '', 1),
      `<label>BESS transformer</label><div class="field"><select data-el="trafo_bess">${trOpts(E.trafo_bess)}</select></div>`,
      `<label>Gensets connected at MV${infoBtn('el.gen_mv', 'Gensets connected at MV')}</label><div class="field"><input type="checkbox" data-el="gen_mv" ${E.gen_mv ? 'checked' : ''}></div>`,
      `<label>Genset transformer</label><div class="field"><select data-el="trafo_gen">${trOpts(E.trafo_gen)}</select></div>`,
      num('gens_per_trafo', 'Gensets per transformer', '', 1),
      `<label>Load transformer</label><div class="field"><select data-el="trafo_load">${trOpts(E.trafo_load, true)}</select></div>`,
      num('pf_load', 'Load power factor', ''),
      num('derate', 'Cable derating factor', ''),
      num('dv_dc', 'Max voltage drop DC', '%'), num('dv_lv', 'Max voltage drop LV', '%'), num('dv_mv', 'Max voltage drop MV', '%'),
    ].join('');
    $$('[data-el]', $('#elBasis')).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.el;
      E[k] = inp.type === 'checkbox' ? inp.checked : inp.tagName === 'SELECT' ? inp.value : (inp.value === '' ? null : +inp.value);
      onChange('electrical.' + k); render(true);
    }));
  }

  function render(keepBasis) {
    if (!keepBasis) basisForm();
    D = compute();
    const s = D.str, cur = P.econ.currency;
    $('#elStrings').innerHTML = s ? `<table class="data">
      <tr><td>Modules per string</td><td><b>${s.ns}</b> (allowed ${s.nMin}–${Math.min(s.nMax, s.nMppt)})</td></tr>
      <tr><td>Voc at ${escapeHtml(D.tmin)} °C</td><td>${fmtNum(s.vocMax)} V ≤ ${fmtNum(Math.min(s.inv.vdc_max, s.pv.vsys || 1e9))} V</td></tr>
      <tr><td>Vmp at ${escapeHtml(s.tHot)} °C / ${escapeHtml(D.tmin)} °C</td><td>${fmtNum(s.vmpHot)} / ${fmtNum(s.vmpCold)} V (MPPT ${escapeHtml(s.inv.vmppt_min)}–${escapeHtml(s.inv.vmppt_max)} V)</td></tr>
      <tr><td>Temp. coeff. Vmp</td><td>${fmtNum(s.bVmp, 3)} %/°C (${escapeHtml(s.bVmpSrc)})</td></tr>
      <tr><td>Max cell temperature</td><td>${escapeHtml(s.tHot)} °C${s.tModel != null ? ` (thermal model P99.9: ${fmtNum(s.tModel, 1)} °C)` : ''}</td></tr>
      <tr><td>Strings / modules</td><td>${fmtNum(s.nStrings)} / ${fmtNum(s.nModules)}</td></tr>
      <tr><td>DC capacity (built)</td><td>${fmtNum(s.kwp, 1)} kWp</td></tr>
      <tr><td>Inverters</td><td>${fmtNum(s.nInv)} × ${fmtNum(s.inv.pac_kw)} kW → DC/AC ${s.dcac.toFixed(3)}</td></tr>
      <tr><td>Strings per inverter / per MPPT</td><td>${fmtNum(s.spi, 1)} / ${s.spm}</td></tr></table>` : '<p class="hint">Select module and inverter datasheets.</p>';
    $('#elTrafos').innerHTML = `<table class="data"><tr><th>Role</th><th>Transformer</th><th>Units</th><th>Rating</th><th>Z %</th><th>Peak loading</th><th>No-load loss MWh/yr</th><th>Load loss MWh/yr</th><th>Total MWh/yr</th></tr>${
      D.trafos.map((t) => `<tr><td>${t.role}</td><td>${escapeHtml(t.t.name)}</td><td>${t.n}</td><td>${fmtNum(t.t.kva)} kVA ${escapeHtml(t.t.lv_kv)}/${escapeHtml(t.t.hv_kv)} kV</td><td>${escapeHtml(t.t.z)}</td>
        <td>${fmtPct(t.loading, 0)}</td><td>${fmtNum(t.noLoad / 1000, 1)}</td><td>${t.loadLoss != null ? fmtNum(t.loadLoss / 1000, 1) : '–'}</td><td>${t.annual_kwh != null ? fmtNum(t.annual_kwh / 1000, 1) : '–'}</td></tr>`).join('')}</table>`;
    const lib = P.equipment.lib.cable;
    $('#elCables').innerHTML = `<table class="data"><tr><th>Circuit</th><th>No.</th><th>Cable</th><th>Runs</th><th>Length m</th><th>I design A</th><th>Rating A</th><th>Use</th><th>ΔV %</th><th>Loss @ rated kW</th><th>Annual MWh</th><th>Cost ${cur}</th></tr>${
      D.circuits.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${fmtNum(c.count)}</td>
        <td><select data-cab="${c.key}">${lib.filter((x) => cableClass(x) === c.cls).map((x) => `<option value="${escapeHtml(x.id)}" ${c.cab && c.cab.id === x.id ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select></td>
        <td><input type="number" min="1" step="1" style="width:56px" data-runs="${c.key}" value="${c.runs}"></td>
        <td><input type="number" min="0" step="1" style="width:72px" data-len="${c.key}" value="${escapeHtml(c.L)}"></td>
        <td>${fmtNum(c.I, 0)}</td><td>${c.amp ? fmtNum(c.amp, 0) : '–'}</td>
        <td style="color:${c.util > 1 ? 'var(--danger)' : 'inherit'}">${c.util != null ? fmtPct(c.util, 0) : '–'}</td>
        <td style="color:${c.dv * 100 > c.lim ? 'var(--danger)' : 'inherit'}">${c.dv != null ? (c.dv * 100).toFixed(2) : '–'}</td>
        <td>${c.ploss != null ? fmtNum(c.ploss * c.count, 1) : '–'}</td><td>${c.annual != null ? fmtNum(c.annual / 1000, 1) : '–'}</td><td>${fmtNum(c.cost || 0)}</td></tr>`).join('')}</table>`;
    $$('[data-cab]').forEach((x) => (x.onchange = () => { P.electrical.cable[x.dataset.cab] = x.value; onChange('electrical'); render(true); }));
    $$('[data-runs]').forEach((x) => (x.onchange = () => { P.electrical.runs[x.dataset.runs] = Math.max(1, +x.value | 0); onChange('electrical'); render(true); }));
    $$('[data-len]').forEach((x) => (x.onchange = () => { P.electrical.len[x.dataset.len] = Math.max(0, +x.value); onChange('electrical'); render(true); }));

    const L = D.loss;
    const pct = (a, b) => (a != null && b ? fmtPct(a / b, 2) : '–');
    $('#elLoss').innerHTML = D.hasProfiles ? `<table class="data">
      <tr><td>PV DC cables</td><td>${fmtNum(L.pv_dc / 1000, 1)} MWh</td><td>${pct(L.pv_dc, L.pvDc)} of DC</td></tr>
      <tr><td>PV AC (LV + trafo load loss + MV)</td><td>${fmtNum(L.pv_ac_ll / 1000, 1)} MWh</td><td>${pct(L.pv_ac_ll, L.pvAc)} of AC</td></tr>
      <tr><td>BESS path (both directions, trafo load loss)</td><td>${fmtNum(L.bess_ll / 1000, 1)} MWh</td><td>${pct(L.bess_ll, L.bessThroughput)} of throughput</td></tr>
      <tr><td>PV + BESS trafo no-load</td><td>${fmtNum(L.noload_kw * HOURS / 1000, 1)} MWh</td><td>${fmtNum(L.noload_kw, 1)} kW auxiliary load (PV ${fmtNum(L.noload_pv_kw, 1)} kW, BESS ${fmtNum(L.noload_bess_kw, 1)} kW)</td></tr>
      <tr><td>Genset path</td><td>${fmtNum(L.gen / 1000, 1)} MWh</td><td>${pct(L.gen, L.genEnergy)} of output</td></tr>
      <tr><td>Load feeder</td><td>${fmtNum(L.load / 1000, 1)} MWh</td><td></td></tr>
      <tr><td><b>Cables + transformers capex</b></td><td colspan="2"><b>${fmtMoney(D.cost, cur)}</b></td></tr></table>
      <p class="hint">Model currently uses DC wiring ${fmtPct(P.pv.dc_wiring, 2)}${P.pv.dc_wiring_basis === 'stc' ? ' at STC' : ''}, AC losses ${fmtPct(P.pv.ac_losses, 2)}, DC/AC ${escapeHtml(P.pv.dc_ac_ratio)}, transformer no-load PV ${fmtNum(+P.aux.trafo_noload_kw || 0, 1)} kW and BESS ${fmtNum(+P.aux.bess_trafo_noload_kw || 0, 1)} kW.${P.pv.dc_wiring_basis === 'stc' && P.electrical.applied && P.electrical.applied.dc_wiring === P.pv.dc_wiring ? ' This DC wiring value came from the cable design as a constant fraction: set the DC wiring loss basis back to Constant fraction (annual).' : ''}</p>`
      : '<p class="hint">Calculate the PV yield (tab 4) and run a simulation to integrate losses over the hourly profiles.</p>';
    $('#elWarn').hidden = !D.warn.length;
    $('#elWarn').innerHTML = D.warn.map((w) => '⚠ ' + escapeHtml(w)).join('<br>');
    SLD.render(D, P);
  }

  function autoSize() {
    const E = P.electrical, lib = P.equipment.lib.cable;
    let changed = 0;
    for (const c of compute().circuits) {
      const cands = lib.filter((x) => cableClass(x) === c.cls).sort((a, b) => a.csa - b.csa);
      const lim = dvLimit(c.cls) / 100;
      let pick = null;
      for (let runs = 1; runs <= 12 && !pick; runs++)
        for (const x of cands) {
          const dv = vdrop(c, x, runs);
          if (c.I <= x.ampacity * runs * E.derate && dv <= lim) { pick = { x, runs }; break; }
        }
      if (pick) { E.cable[c.key] = pick.x.id; E.runs[c.key] = pick.runs; changed++; }
    }
    onChange('electrical'); render(true);
    toast(`Auto-sized ${changed} circuit(s): smallest cable meeting current rating and voltage-drop limits, fewest parallel runs.`);
  }

  function applyLosses() {
    if (!D || !D.hasProfiles || !D.loss.pvAc) { toast('Calculate the PV yield first (tab 4).', true); return; }
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
    if (L.bessThroughput) {
      if (!rteBase || rteBase.set !== P.bess.rte) rteBase = { rte: P.bess.rte };
      const f = L.bess_ll / L.bessThroughput;  // fraction lost per pass through the BESS path (charge + discharge)
      P.bess.rte = rteBase.set = +(rteBase.rte * (1 - f) * (1 - f)).toFixed(4);
    }
    syncForms(P); onChange('electrical.apply'); render(true);
    toast(`Model updated: DC wiring ${fmtPct(P.pv.dc_wiring, 2)} (annual basis), AC losses ${fmtPct(P.pv.ac_losses, 2)} (cables and transformer load loss), DC/AC ${P.pv.dc_ac_ratio}, PV ${fmtNum(P.pv.capacity_kwp)} kWp${L.bessThroughput ? ', BESS RTE ' + fmtPct(P.bess.rte, 1) : ''}. Transformer no-load loss PV ${fmtNum(P.aux.trafo_noload_kw, 1)} kW and BESS ${fmtNum(P.aux.bess_trafo_noload_kw, 1)} kW set as auxiliary loads (Battery tab). Re-run the simulation.`);
  }

  // ------------------------------------------------------------------ radial AC load flow (backward/forward sweep)
  // Complex helpers on [re, im].
  const cx = { add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]], mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
    div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; }, conj: (a) => [a[0], -a[1]], abs: (a) => Math.hypot(a[0], a[1]) };
  let LF = null;

  // Build the per-unit network (S_base = 1 MVA) from the design. Identical parallel items are lumped (Z / n).
  function network() {
    const E = P.electrical, Sb = 1000;   // kVA
    const nodes = [{ name: 'MV main bus', parent: -1, z: [0, 0], kind: 'mv' }];
    const add = (name, parent, z, kind, inj) => { nodes.push({ name, parent, z, kind, inj }); return nodes.length - 1; };
    const cabZ = (key, Vll) => {
      const c = D.circuits.find((k) => k.key === key);
      if (!c || !c.cab) return [0, 0];
      const zb = (Vll * Vll) / (Sb * 1000);
      const R = rHot(c.cab) * c.L / c.runs, X = (c.cab.x || 0) / 1000 * c.L / c.runs;
      return [R / zb, X / zb];
    };
    const trZ = (t, n) => {
      const r = t.pk / t.kva, zt = t.z / 100, x = Math.sqrt(Math.max(0, zt * zt - r * r));
      return [r * Sb / t.kva / n, x * Sb / t.kva / n];
    };
    const scale = (z, k) => [z[0] * k, z[1] * k];
    const Vmv = E.mv_kv * 1000;
    // PV: one representative feeder with its transformers along it; results scaled by the number of feeders
    const pvF = D.circuits.find((c) => c.key === 'mv_pv');
    const nFeed = pvF ? pvF.count : 1;
    const trPV = Equipment.find('transformer', E.trafo_pv);
    if (D.str && trPV && D.nTrPV) {
      const per = Math.max(1, Math.round(D.nTrPV / nFeed));
      const zFeed = cabZ('mv_pv', Vmv);
      const zLv = scale(cabZ('lv_pv', D.str.inv.vac), 1 / D.invPerTr);
      let prev = 0;
      for (let k = 0; k < per; k++) {
        const mv = add(`PV feeder node ${k + 1}`, prev, scale(zFeed, 1 / per), 'mv');
        const lv = add(`PV transformer ${k + 1} LV`, mv, trZ(trPV, 1), 'lv');
        add(`PV inverters ${k + 1} (×${D.invPerTr})`, lv, zLv, 'lv', { type: 'pv', share: 1 / (per * nFeed) });
        prev = mv;
      }
    }
    const trB = Equipment.find('transformer', E.trafo_bess);
    if (P.bess.energy_kwh > 0 && trB && D.nTrB) {
      const mv = add('BESS MV node', 0, cabZ('mv_bess', Vmv), 'mv');
      const lv = add('BESS transformer LV', mv, trZ(trB, D.nTrB), 'lv');
      const bat = Equipment.selected('battery');
      add(`BESS PCS (×${D.nB})`, lv, scale(cabZ('lv_bess', bat ? bat.vac : 690), 1 / D.nB), 'lv', { type: 'bess' });
    }
    const trG = Equipment.find('transformer', E.trafo_gen), dg = Equipment.selected('genset');
    if (D.nG > 0) {
      const nGrp = E.gen_mv ? D.nG : D.nTrG;
      const mv = add('Genset MV node', 0, scale(cabZ('mv_gen', Vmv), 1 / Math.max(1, nGrp)), 'mv');
      if (!E.gen_mv && trG) {
        const lv = add('Genset transformer LV', mv, trZ(trG, D.nTrG), 'lv');
        add(`Genset terminals (×${D.nG})`, lv, scale(cabZ('lv_gen', dg ? dg.voltage : 400), 1 / D.nG), 'lv', { type: 'gen' });
      } else nodes[mv].inj = { type: 'gen' };
    }
    const trL = Equipment.find('transformer', E.trafo_load);
    const lm = add('Load feeder end', 0, cabZ('load', Vmv), 'mv', trL ? null : { type: 'load' });
    if (trL) { const n = Math.ceil(maxOf(P.load.kw) / E.pf_load / trL.kva); add('Load LV bus', lm, trZ(trL, n), 'lv', { type: 'load' }); }
    return { nodes, nFeed, Sb, order: topo(nodes) };
  }

  // depth-first order so that parents come before children
  function topo(nodes) { const children = nodes.map(() => []); nodes.forEach((nd, i) => { if (nd.parent >= 0) children[nd.parent].push(i); }); const order = [], st = [0]; while (st.length) { const i = st.pop(); order.push(i); children[i].forEach((c) => st.push(c)); } return order; }

  function sweep(nodes, order, S) {   // S: complex power drawn at each node (pu, load convention). Returns voltages and branch losses.
    const n = nodes.length;
    const V = nodes.map(() => [1, 0]);
    let Ib;
    for (let it = 0; it < 30; it++) {
      const Ii = S.map((s, i) => cx.conj(cx.div(s, V[i])));
      Ib = nodes.map(() => [0, 0]);
      for (let k = order.length - 1; k >= 0; k--) {        // backward: accumulate branch currents
        const i = order[k];
        Ib[i] = cx.add(Ib[i], Ii[i]);
        if (nodes[i].parent > 0) Ib[nodes[i].parent] = cx.add(Ib[nodes[i].parent], Ib[i]);
      }
      let dmax = 0;
      for (const i of order) {                              // forward: voltage drops from the slack
        if (i === 0) continue;
        const nv = cx.sub(V[nodes[i].parent], cx.mul(nodes[i].z, Ib[i]));
        dmax = Math.max(dmax, cx.abs(cx.sub(nv, V[i])));
        V[i] = nv;
      }
      if (dmax < 1e-7) break;
    }
    let loss = 0;
    for (let i = 1; i < n; i++) loss += nodes[i].z[0] * (Ib[i][0] ** 2 + Ib[i][1] ** 2);
    return { V, loss };
  }

  function inject(nodes, H, t, tanL, Sb) {
    const pvKw = H.pv_to_load[t] + H.pv_to_bess[t] + (H.wind_to_load ? H.wind_to_load[t] + H.wind_to_bess[t] : 0);
    const bessKw = H.bess_dis[t] - H.pv_to_bess[t] - H.gen_to_bess[t] - (H.wind_to_bess ? H.wind_to_bess[t] : 0);
    const genKw = H.gen_to_load[t] + H.gen_to_bess[t];
    const siteKw = H.load[t] - (H.aux ? H.aux[t] : 0);   // the load feeder carries the site load; plant auxiliaries are drawn at the plant
    return nodes.map((nd) => (!nd.inj ? [0, 0] : nd.inj.type === 'load' ? [siteKw / Sb, siteKw * tanL / Sb] : nd.inj.type === 'pv' ? [-pvKw * nd.inj.share / Sb, 0]
      : nd.inj.type === 'bess' ? [-bessKw / Sb, 0] : [-genKw / Sb, 0]));
  }

  function runLoadFlow() {
    if (!SIM) { toast('Run a simulation first: the load flow uses the hourly dispatch.', true); return; }
    if (!D) render();
    const H = SIM.result.hourly, net = network(), nodes = net.nodes, Sb = net.Sb;
    const tanL = Math.tan(Math.acos(Math.min(1, P.electrical.pf_load)));
    const nh = H.load.length, vmin = new Array(nodes.length).fill(9), vmax = new Array(nodes.length).fill(0);
    const lossH = new Array(nh), vdH = new Array(nh), vEnd = new Array(nh);
    let viol = 0, lossTot = 0;
    const pvIdx = nodes.map((nd, i) => (nd.inj && nd.inj.type === 'pv' ? i : -1)).filter((i) => i >= 0);
    const endPV = pvIdx.length ? pvIdx[pvIdx.length - 1] : -1;
    const lims = nodes.map((nd) => (nd.kind === 'mv' ? [0.95, 1.05] : [0.9, 1.1]));
    for (let t = 0; t < nh; t++) {
      const S = inject(nodes, H, t, tanL, Sb);
      const r = sweep(nodes, net.order, S);
      // the PV feeder is modelled once: scale its losses by the number of identical feeders
      let lossKw = r.loss * Sb;
      if (net.nFeed > 1) {
        const pvOnly = sweep(nodes, net.order, S.map((s, i) => (nodes[i].inj && nodes[i].inj.type === 'pv' ? s : [0, 0])));
        lossKw += pvOnly.loss * Sb * (net.nFeed - 1);
      }
      lossH[t] = lossKw; lossTot += lossKw;
      let vd = 0;
      r.V.forEach((v, i) => {
        const m = cx.abs(v);
        vmin[i] = Math.min(vmin[i], m); vmax[i] = Math.max(vmax[i], m);
        vd += Math.abs(m - 1);
        if (m < lims[i][0] || m > lims[i][1]) viol++;
      });
      vdH[t] = vd;
      vEnd[t] = endPV >= 0 ? cx.abs(r.V[endPV]) : 1;
    }
    LF = { net, nodes, vmin, vmax, lossH, vdH, vEnd, lossTot, viol };
    // hour selector: worst-case hours
    const argmax = (a) => a.reduce((b, x, i) => (x > a[b] ? i : b), 0);
    const hours = { 'Peak PV hour': argmax(H.pv_avail), 'Peak load hour': argmax(H.load), 'Highest voltage deviation': argmax(vdH), 'Highest network loss': argmax(lossH) };
    $('#lfHour').innerHTML = Object.entries(hours).map(([k, h]) => `<option value="${h}">${k}: ${dateOfHour(h)} ${String(h % 24).padStart(2, '0')}:00</option>`).join('');
    const simple = D.loss ? D.loss.pv_ac + D.loss.bess + D.loss.gen + D.loss.load : null;
    $('#lfKpis').innerHTML = kpis([
      ['Network losses (load flow)', fmtEnergy(lossTot), simple != null ? `simplified method: ${fmtEnergy(simple)} (incl. no-load)` : '', true],
      ['Loss share of load', fmtPct(lossTot / sum(H.load), 2), 'MV + LV cables and transformer copper'],
      ['Min / max bus voltage', `${Math.min(...vmin).toFixed(3)} / ${Math.max(...vmax).toFixed(3)} pu`, ''],
      ['Mean voltage deviation', (sum(vdH) / nh).toFixed(4), 'Σ|V−1| per hour'],
      ['Voltage limit violations', fmtNum(viol), 'bus-hours outside MV ±5 % / LV ±10 %'],
    ]);
    $('#lfTable').innerHTML = `<table class="data"><tr><th>Bus</th><th>Level</th><th>Min V (pu)</th><th>Max V (pu)</th></tr>${nodes.map((nd, i) =>
      `<tr><td>${escapeHtml(nd.name)}</td><td>${nd.kind.toUpperCase()}</td><td style="color:${vmin[i] < (nd.kind === 'mv' ? 0.95 : 0.9) ? 'var(--danger)' : 'inherit'}">${vmin[i].toFixed(4)}</td><td style="color:${vmax[i] > (nd.kind === 'mv' ? 1.05 : 1.1) ? 'var(--danger)' : 'inherit'}">${vmax[i].toFixed(4)}</td></tr>`).join('')}</table>`;
    drawLf();
  }
  function drawLf() {
    if (!LF || !SIM) return;
    const t = +$('#lfHour').value, H = SIM.result.hourly, c = COL();
    const net = LF.net, tanL = Math.tan(Math.acos(Math.min(1, P.electrical.pf_load)));
    const r = sweep(net.nodes, net.order, inject(net.nodes, H, t, tanL, net.Sb));
    const names = net.nodes.map((n) => n.name), vm = r.V.map((v) => cx.abs(v));
    plot('chLfProfile', [{ type: 'bar', x: names, y: vm, marker: { color: net.nodes.map((n) => (n.kind === 'mv' ? c.gen : c.bess)), cornerradius: 3 }, hovertemplate: '%{x}: %{y:.4f} pu<extra></extra>' }],
      { yaxis: { title: { text: 'Voltage (pu)' }, range: [Math.min(0.9, ...vm) - 0.01, Math.max(1.1, ...vm) + 0.01] }, xaxis: { tickangle: -35 }, showlegend: false,
        shapes: [0.95, 1.05].map((y) => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y, line: { color: c.unmet, dash: 'dot', width: 1 } })), margin: { l: 56, r: 10, t: 10, b: 110 } });
    const s0 = Math.max(0, Math.min(t - 84, HOURS - 168)), idx = Array.from({ length: 168 }, (_, i) => s0 + i);
    plot('chLfTime', [
      { type: 'scatter', mode: 'lines', name: 'PV feeder end voltage (pu)', x: idx, y: idx.map((h) => LF.vEnd[h]), line: { color: c.pv, width: 2 } },
    ], { yaxis: { title: { text: 'pu' } }, xaxis: { tickvals: idx.filter((h) => h % 24 === 0), ticktext: idx.filter((h) => h % 24 === 0).map(dateOfHour) }, showlegend: false,
         shapes: [{ type: 'line', x0: t, x1: t, yref: 'paper', y0: 0, y1: 1, line: { color: c.text2, dash: 'dot' } }] });
  }

  return { init, reload, render, get design() { return D; } };
})();
