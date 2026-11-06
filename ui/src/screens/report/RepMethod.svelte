<!-- Additional figures and the method and assumptions -->
<script>
  import Fig from './Fig.svelte';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { FIG_PLACES } from '../../lib/report/figures.js';
  let { D } = $props();
  const { P, h, cur } = D;
  // figures whose section is not in this report (no electrical design, no simulation) and those placed under Additional figures
  const rest = D.userFigs.filter((f) => !D.places.has(FIG_PLACES[f.place] ? f.place : 'appendix')), pv = P.pv, bess = P.bess, dsl = P.diesel, econ = P.econ;
  const aux = P.aux || {}, parts = [];
  if (aux.bess_kw_per_mwh > 0) parts.push(`battery HVAC, BMS and fire system ${fmtNum(aux.bess_kw_per_mwh, 2)} kW per MWh of nameplate energy${aux.bess_temp_coeff > 0 ? `, rising ${fmtPct(aux.bess_temp_coeff)}/°C above ${+aux.ref_c} °C ambient` : ''}`);
  if (aux.pcs_kw_per_mw > 0) parts.push(`battery inverter (PCS) no-load ${fmtNum(aux.pcs_kw_per_mw, 2)} kW per MW of PCS rating (with a battery)`);
  if (aux.plant_kw > 0) parts.push(`plant auxiliaries ${fmtNum(aux.plant_kw, 1)} kW (with PV, wind or a battery)`);
  if (aux.trafo_noload_kw > 0) parts.push(`PV step-up transformer no-load ${fmtNum(aux.trafo_noload_kw, 1)} kW (with PV)`);
  if (aux.bess_trafo_noload_kw > 0) parts.push(`BESS step-up transformer no-load ${fmtNum(aux.bess_trafo_noload_kw, 1)} kW (with a battery)`);
  const auxText = parts.length ? `Auxiliary loads: ${parts.join('; ')}. They are served every hour like the site load and do not grow with it; LCOE, COE and billed renewable energy count only the energy served to the site.`
    : 'Auxiliary loads (battery HVAC and BMS, battery inverter no-load, plant auxiliaries, transformer no-load): none modelled.';
</script>

{#if rest.length}
  <h2>Additional figures</h2>
  {#each rest as f}<Fig src={f.src} cap={f.caption || 'Figure supplied with the project.'} cls="user" />{/each}
{/if}
<h2>Method and assumptions</h2>
<ul>
  <li>Hourly chronological simulation over {P.sim.all_years ? 'every project year (PV degradation, battery ageing and replacement, load growth)' : 'year 1, repeated'}.</li>
  <li>PV: {pv.transposition === 'perez' ? 'Perez' : 'Hay-Davies'} transposition, infinite-row beam shading{pv.row_shading && pv.diffuse_shading ? ' and diffuse row shading by 2-D view factors' : ''}{pv.bifaciality > 0 ? `, bifacial rear side (${fmtPct(pv.bifaciality, 0)} bifaciality)` : ''}, {{ martin_ruiz: 'Martin-Ruiz', physical: 'physical glass' }[pv.iam_model] || 'ASHRAE'} IAM,{pv.spectral && pv.spectral !== 'none' ? ' PVSPEC spectral correction,' : ''}{Array.isArray(pv.horizon) && pv.horizon.length ? ' terrain horizon,' : ''}{Array.isArray(pv.snow_monthly) ? ' monthly snow loss,' : ''}{Array.isArray(pv.soiling_monthly) && pv.soiling_monthly.length === 12 ? ' monthly soiling,' : ''} {pv.thermal_model === 'noct' ? 'NOCT' : 'heat-loss factor (Uc/Uv)'} thermal model, DC/AC loss chain with {pv.inverter_model === 'curve' ? 'an inverter part-load curve and' : ''} inverter clipping, {pv.degradation_model === 'linear' ? 'linear' : 'compound'} degradation; DC wiring loss {pv.dc_wiring_basis === 'stc' ? 'stated at STC power and scaled with the hourly string current over voltage (I²R)' : 'as a constant fraction'}.</li>
  <li>Diesel: unit commitment with spinning reserve and minimum loading, at most {+dsl.units} units online; {bess.provides_reserve ? `spare battery power counts as reserve up to what its stored energy sustains for ${+bess.reserve_duration_h} h` : 'the battery does not count as reserve'}; fuel from part-load curve.</li>
  <li>Battery: SOC window, round-trip efficiency{bess.self_discharge ? `, self-discharge ${fmtPct(bess.self_discharge, 3)}/h` : ''}; calendar fade {fmtPct(bess.calendar_fade)}/yr plus cycle fade, with cycles counted at the cells (DC) against {fmtNum(bess.cycle_life)} cycles at {fmtPct(bess.cycle_life_dod, 0)} depth of discharge to {fmtPct(bess.eol_soh, 0)}; replacement at {fmtPct(h.bessThreshold(), 0)} state of health{bess.soh_init < 1 ? `, initial state of health ${fmtPct(bess.soh_init, 0)}` : ''}.</li>
  <li>{auxText}</li>
  <li>Economics: nominal discounted cash flow, {+econ.lifetime} years, discount rate {fmtPct(econ.discount_rate)}, diesel {cur} {+econ.fuel_price}/L escalating {fmtPct(econ.fuel_escalation)}/yr. NPV, IRR and payback of the hybrid on the incremental cash flow against diesel only; the battery's own value on the same cash flow against the same PV and wind without a battery.</li>
  <li>Equipment marked "Generic" uses typical values, not manufacturer data. Results are for feasibility assessment, not construction.</li>
</ul>
