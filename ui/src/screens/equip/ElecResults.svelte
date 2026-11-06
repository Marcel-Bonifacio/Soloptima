<!-- Design basis, string sizing, transformers and the loss summary of the electrical design -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { fmtNum, fmtPct, fmtMoney } from '../../lib/format.js';
  import { HOURS } from '../../lib/series.js';
  import { design, apply } from '../../lib/equip/electrical.svelte.js';
  import ElecBasis from './ElecBasis.svelte';

  const D = $derived(design());
  const s = $derived(D.str);
  const P = $derived.by(() => { design(); return W.P; });
  const L = $derived(D.loss);
  const pct = (a, b) => (a != null && b ? fmtPct(a / b, 2) : '–');
  const mwh = (x, d = 1) => fmtNum(x / 1000, d);
</script>

<div class="grid-3">
  <div class="card"><h3>Design basis</h3><ElecBasis /></div>
  <div class="card"><h3>PV string sizing</h3>
    {#if s}
      <table class="data"><tbody>
        <tr><td>Modules per string</td><td><b>{s.ns}</b> (allowed {s.nMin}–{Math.min(s.nMax, s.nMppt)})</td></tr>
        <tr><td>Voc at {D.tmin} °C</td><td>{fmtNum(s.vocMax)} V ≤ {fmtNum(Math.min(s.inv.vdc_max, s.pv.vsys || 1e9))} V</td></tr>
        <tr><td>Vmp at {s.tHot} °C / {D.tmin} °C</td><td>{fmtNum(s.vmpHot)} / {fmtNum(s.vmpCold)} V (MPPT {s.inv.vmppt_min}–{s.inv.vmppt_max} V)</td></tr>
        <tr><td>Temp. coeff. Vmp</td><td>{fmtNum(s.bVmp, 3)} %/°C ({s.bVmpSrc})</td></tr>
        <tr><td>Max cell temperature</td><td>{s.tHot} °C{s.tModel != null ? ` (thermal model P99.9: ${fmtNum(s.tModel, 1)} °C)` : ''}</td></tr>
        <tr><td>Strings / modules</td><td>{fmtNum(s.nStrings)} / {fmtNum(s.nModules)}</td></tr>
        <tr><td>DC capacity (built)</td><td>{fmtNum(s.kwp, 1)} kWp</td></tr>
        <tr><td>Inverters</td><td>{fmtNum(s.nInv)} × {fmtNum(s.inv.pac_kw)} kW → DC/AC {s.dcac.toFixed(3)}</td></tr>
        <tr><td>Strings per inverter / per MPPT</td><td>{fmtNum(s.spi, 1)} / {s.spm}</td></tr>
      </tbody></table>
    {:else}<p class="hint">Select module and inverter datasheets.</p>{/if}
  </div>

  <div class="card"><h3>Losses &amp; feedback to the model</h3>
    {#if D.hasProfiles}
      <table class="data"><tbody>
        <tr><td>PV DC cables</td><td>{mwh(L.pv_dc)} MWh</td><td>{pct(L.pv_dc, L.pvDc)} of DC</td></tr>
        <tr><td>PV AC (LV + trafo load loss + MV)</td><td>{mwh(L.pv_ac_ll)} MWh</td><td>{pct(L.pv_ac_ll, L.pvAc)} of AC</td></tr>
        <tr><td>BESS path (both directions, trafo load loss)</td><td>{mwh(L.bess_ll)} MWh</td><td>{pct(L.bess_ll, L.bessThroughput)} of throughput</td></tr>
        <tr><td>PV + BESS trafo no-load</td><td>{fmtNum(L.noload_kw * HOURS / 1000, 1)} MWh</td><td>{fmtNum(L.noload_kw, 1)} kW auxiliary load (PV {fmtNum(L.noload_pv_kw, 1)} kW, BESS {fmtNum(L.noload_bess_kw, 1)} kW)</td></tr>
        <tr><td>Genset path</td><td>{mwh(L.gen)} MWh</td><td>{pct(L.gen, L.genEnergy)} of output</td></tr>
        <tr><td>Load feeder</td><td>{mwh(L.load)} MWh</td><td></td></tr>
        <tr><td><b>Cables + transformers capex</b></td><td colspan="2"><b>{fmtMoney(D.cost, P.econ.currency)}</b></td></tr>
      </tbody></table>
      <p class="hint">Model currently uses DC wiring {fmtPct(P.pv.dc_wiring, 2)}{P.pv.dc_wiring_basis === 'stc' ? ' at STC' : ''}, AC losses {fmtPct(P.pv.ac_losses, 2)}, DC/AC {P.pv.dc_ac_ratio}, transformer no-load PV {fmtNum(+P.aux.trafo_noload_kw || 0, 1)} kW and BESS {fmtNum(+P.aux.bess_trafo_noload_kw || 0, 1)} kW.{P.pv.dc_wiring_basis === 'stc' && P.electrical.applied && P.electrical.applied.dc_wiring === P.pv.dc_wiring ? ' This DC wiring value came from the cable design as a constant fraction: set the DC wiring loss basis back to Constant fraction (annual).' : ''}</p>
    {:else}<p class="hint">Calculate the PV yield (tab 4) and run a simulation to integrate losses over the hourly profiles.</p>{/if}
    <div class="row gap"><button class="btn primary small" onclick={apply}>Apply losses to the model</button></div>
  </div>
</div>

<div class="card"><h3>Transformers</h3>
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>Role</th><th>Transformer</th><th>Units</th><th>Rating</th><th>Z %</th><th>Peak loading</th><th>No-load loss MWh/yr</th><th>Load loss MWh/yr</th><th>Total MWh/yr</th></tr></thead>
      <tbody>
        {#each D.trafos as t}
          <tr><td>{t.role}</td><td>{t.t.name}</td><td>{t.n}</td><td>{fmtNum(t.t.kva)} kVA {t.t.lv_kv}/{t.t.hv_kv} kV</td><td>{t.t.z}</td>
            <td>{fmtPct(t.loading, 0)}</td><td>{mwh(t.noLoad)}</td><td>{t.loadLoss != null ? mwh(t.loadLoss) : '–'}</td><td>{t.annual_kwh != null ? mwh(t.annual_kwh) : '–'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
