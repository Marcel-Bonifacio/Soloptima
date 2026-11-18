<!-- AC load flow of the design over year 1: run, worst-case hour selector, tiles, voltage charts and the bus table -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import { fmtNum, fmtPct, fmtEnergy } from '../../lib/format.js';
  import { HOURS, dateOfHour } from '../../lib/series.js';
  import { el, loadFlow, lfBuses, runLf } from '../../lib/equip/electrical.svelte.js';

  // the week of hours around hour t, inside the year
  const weekAround = (t) => { const s0 = Math.max(0, Math.min(t - 84, HOURS - 168)); return Array.from({ length: 168 }, (_, i) => s0 + i); };

  const LF = $derived(loadFlow());
  const tiles = $derived(LF ? [
    ['Network losses (load flow)', fmtEnergy(LF.lossTot), LF.simple != null ? `simplified method: ${fmtEnergy(LF.simple)} (incl. no-load)` : '', true],
    ['Loss share of load', fmtPct(LF.lossTot / LF.loadTotal, 2), 'MV + LV cables and transformer copper'],
    ['Min / max bus voltage', `${Math.min(...LF.vmin).toFixed(3)} / ${Math.max(...LF.vmax).toFixed(3)} pu`, ''],
    ['Mean voltage deviation', LF.vdMean.toFixed(4), 'Σ|V−1| per hour'],
    ['Voltage limit violations', fmtNum(LF.viol), 'bus-hours outside MV ±5 % / LV ±10 %'],
    ...(LF.reactive ? [['Reactive energy from the plant', fmtNum(LF.reactive.kvarh / 1000, 0) + ' Mvarh',
      LF.reactive.shortH ? `power factor ${LF.reactive.pf} not held in ${fmtNum(LF.reactive.shortH)} h` : `power factor ${LF.reactive.pf} held every hour`]] : []),
  ] : []);
  // the bus names come with the voltages of the hour shown (the engine keeps the network)
  const B = $derived(LF ? lfBuses() : null);

  function profile(c) {
    el.lfHour;
    const B = lfBuses();
    if (!B) return null;
    const vm = B.vm;
    return {
      traces: [{ type: 'bar', x: B.names, y: vm, marker: { color: B.kinds.map((k) => (k === 'mv' ? c.gen : c.bess)), cornerradius: 3 }, hovertemplate: '%{x}: %{y:.4f} pu<extra></extra>' }],
      layout: { yaxis: { title: { text: 'Voltage (pu)' }, range: [Math.min(0.9, ...vm) - 0.01, Math.max(1.1, ...vm) + 0.01] }, xaxis: { tickangle: -35 }, showlegend: false,
        shapes: [0.95, 1.05].map((y) => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y, line: { color: c.unmet, dash: 'dot', width: 1 } })), margin: { l: 56, r: 10, t: 10, b: 110 } },
    };
  }
  function time(c) {
    const t = el.lfHour;
    if (!loadFlow()) return null;
    const idx = weekAround(t), days = idx.filter((h) => h % 24 === 0);
    return {
      traces: [{ type: 'scatter', mode: 'lines', name: 'PV feeder end voltage (pu)', x: idx, y: idx.map((h) => LF.vEnd[h]), line: { color: c.pv, width: 2 } }],
      layout: { yaxis: { title: { text: 'pu' } }, xaxis: { tickvals: days, ticktext: days.map(dateOfHour) }, showlegend: false,
        shapes: [{ type: 'line', x0: t, x1: t, yref: 'paper', y0: 0, y1: 1, line: { color: c.text2, dash: 'dot' } }] },
    };
  }
</script>

<div class="card">
  <div class="row space"><h3>AC load flow (backward/forward sweep, {fmtNum(HOURS)} h)</h3>
    <div class="row gap">
      <button class="btn small primary" disabled={el.busy} onclick={runLf}>Run load flow</button>
      <select aria-label="Hour shown" value={el.lfHour} onchange={(e) => { el.lfHour = +e.currentTarget.value; }}>
        {#if LF}{#each LF.hours as h}<option value={h.h}>{h.label}</option>{/each}{/if}
      </select>
    </div>
  </div>
  <p class="hint">Radial network: MV main bus (slack, 1.00 pu, held by the gensets) → MV feeders and step-up transformers → LV terminals of inverters, PCS and gensets, and the load feeder. Impedances from the cable and transformer datasheets; injections from the year-1 hourly dispatch. PV, PCS and gensets run at unity power factor, unless a power factor is asked at the grid connection: then they supply the reactive power that holds it, within their spare kVA. Voltage deviation VD = Σ|V − 1| over buses (Suresh Babu et al. 2025, Eq. 18).</p>
  <Kpis items={tiles} />
  <div class="grid-2"><Chart id="chLfProfile" build={profile} /><Chart id="chLfTime" build={time} /></div>
  {#if LF && B}
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Bus</th><th>Level</th><th>Min V (pu)</th><th>Max V (pu)</th></tr></thead>
        <tbody>
          {#each B.names as name, i}
            <tr><td>{name}</td><td>{B.kinds[i].toUpperCase()}</td>
              <td style:color={LF.vmin[i] < LF.lims[i][0] ? 'var(--danger)' : null}>{LF.vmin[i].toFixed(4)}</td>
              <td style:color={LF.vmax[i] > LF.lims[i][1] ? 'var(--danger)' : null}>{LF.vmax[i].toFixed(4)}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
