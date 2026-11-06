<!-- Live what-if: sliders bound directly to the project values, and the dispatch strategy -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { autosave } from '../../lib/ws/core.js';
  import { forms, refreshForms } from '../../lib/state.svelte.js';
  import { data, runSim } from '../../lib/results.svelte.js';
  import { fmtNum } from '../../lib/format.js';
  import { whatIfRanges, cRateOf } from '../../lib/sim-extra.js';

  const STRATS = [['load_following', 'Load following'], ['cycle_charging', 'Cycle charging'], ['predictive', 'Predictive EMS']];

  const v = $derived.by(() => {
    forms.rev;
    const P = W.P, cr = cRateOf(P.bess);
    return { r: whatIfRanges(P), pv: P.pv.capacity_kwp, be: P.bess.energy_kwh, cr, fp: P.econ.fuel_price, cur: P.econ.currency, strategy: P.diesel.strategy };
  });

  // a change to the project: the other forms and the autosave follow, and the run again while live
  function changed() {
    refreshForms(); autosave();
    if (ws.live && data.sim) runSim(true);
  }
  const setPv = (e) => { W.P.pv.capacity_kwp = +e.currentTarget.value; changed(); };
  const setBe = (e) => { const P = W.P, x = +e.currentTarget.value, cr = cRateOf(P.bess); P.bess.energy_kwh = x; P.bess.power_kw = Math.round(x * cr); changed(); };
  const setCr = (e) => { const P = W.P; P.bess.power_kw = Math.round(P.bess.energy_kwh * +e.currentTarget.value); changed(); };
  const setFp = (e) => { W.P.econ.fuel_price = +e.currentTarget.value; changed(); };
  function setStrategy(s) {
    W.P.diesel.strategy = s; refreshForms(); autosave();
    runSim(!!data.sim);
  }
</script>

<div class="card">
  <div class="row space"><h3>Live what-if</h3><label class="hint inline"><input type="checkbox" id="liveSim" bind:checked={ws.live}> re-simulate while dragging</label></div>
  <div class="whatif">
    <label>PV capacity <b id="wiPvV">{fmtNum(v.pv)} kWp</b><input type="range" id="wiPv" min="0" max={v.r.pv.max} step={v.r.pv.step} value={v.pv} oninput={setPv}></label>
    <label>Battery energy <b id="wiBeV">{fmtNum(v.be)} kWh</b><input type="range" id="wiBe" min="0" max={v.r.be.max} step={v.r.be.step} value={v.be} oninput={setBe}></label>
    <label>Battery C-rate <b id="wiCrV">{v.cr.toFixed(2)} C</b><input type="range" id="wiCr" min="0.1" max="2" step="0.05" value={v.cr} oninput={setCr}></label>
    <label>Diesel price <b id="wiFpV">{v.cur} {(+v.fp).toFixed(2)}/L</b><input type="range" id="wiFp" min={v.r.fp.min} max={v.r.fp.max} step={v.r.fp.step} value={v.fp} oninput={setFp}></label>
    <div class="seg" id="wiStrat">{#each STRATS as [k, label]}<button class:on={v.strategy === k} data-v={k} onclick={() => setStrategy(k)}>{label}</button>{/each}</div>
  </div>
  <p class="hint">KPI tiles show the change against the previous run (▲ better / ▼ worse).</p>
</div>
