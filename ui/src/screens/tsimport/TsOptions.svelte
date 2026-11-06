<!-- The options of the CSV import dialog: time columns, date order, basis, year, units and the load or weather columns -->
<script>
  import { W } from '../../lib/ws/state.js';
  import TsField from './TsField.svelte';
  import { ts, setOpt, toggleCol, clockAllowed } from '../../lib/tsimport.svelte.js';
  import { fmtNum, fmtOffset } from '../../lib/format.js';
  import { LOAD_UNITS, IRR_UNITS, TEMP_UNITS, WIND_UNITS, LABELS, ORDERS, WX } from '../../lib/tsimport/guess.js';

  const S = $derived(ts.dlg), o = $derived(S.opt);
  const num = (k) => (v) => setOpt(k, +v), txt = (k) => (v) => setOpt(k, v);
  const colName = (i) => `${i + 1}${S.names[i] ? ': ' + S.names[i].slice(0, 28) : ''}`;
  const P = $derived.by(() => { ts.rev; return W.P; });
  const cols = $derived(Array.from({ length: S.ncol }, (_, i) => [i, colName(i)]));
  const timed = $derived(o.time_col >= 0);
  const clock = $derived(timed && clockAllowed(o.time_col));
  const tz = $derived(P.location.tz || '');
  const years = $derived([['auto', 'The year with most data']].concat(S.kind === 'load' ? [['last12', 'The last 12 months']] : [], (S.years || []).map(([y, h]) => [y, `${y} (${fmtNum(h)} h)`])));
</script>

<div class="ts-opts" id="tsOpts">
  <TsField help="import.time_col" label="Time column" value={o.time_col} list={[[-1, 'None: one row per interval from 1 January'], ...cols]} onpick={num('time_col')} />
  <TsField help="import.time2_col" label="Time of day" value={o.time2_col} disabled={!timed} list={[[-1, 'In the time column'], ...cols.filter(([i]) => i !== o.time_col)]} onpick={num('time2_col')} />
  <TsField help="import.date_order" label="Date order" value={o.date_order} disabled={!timed} list={ORDERS} onpick={txt('date_order')} />
  <TsField help="import.basis" label="Time basis" value={o.basis} onpick={txt('basis')}
    list={[['utc', 'UTC'], ['local_standard', `Local standard time (${fmtOffset(P.location.utc_offset)})`], ['local_clock', `Local clock time with daylight saving${tz ? ` (${tz})` : ''}`, !clock]]} />
  <TsField help="import.label" label="Timestamps mark" value={o.label} disabled={!timed} list={LABELS} onpick={txt('label')} />
  <TsField help="import.year" label="Year" value={o.year} disabled={!timed} list={years} onpick={txt('year')} />
  {#if S.kind === 'load'}
    <TsField help="import.units" label="Load unit" value={o.units} list={LOAD_UNITS} onpick={txt('units')} />
    <TsField help="import.cols" label="Load columns (summed)" wide>
      <div class="chips">{#each cols.filter(([i]) => i !== o.time_col && i !== o.time2_col) as [i, l] (i)}
        <label class="check"><input type="checkbox" checked={o.cols.includes(i)} onchange={(e) => toggleCol(i, e.currentTarget.checked)}><span>{l}</span></label>{/each}</div>
    </TsField>
  {:else}
    {#each WX as [k, l] (k)}<TsField help="import.wcols" label={l} value={o[k]} list={[[-1, 'None'], ...cols]} onpick={num(k)} />{/each}
    <TsField help="import.irr_units" label="Irradiance unit" value={o.irr_units} list={IRR_UNITS} onpick={txt('irr_units')} />
    <TsField help="import.temp_units" label="Temperature unit" value={o.temp_units} list={TEMP_UNITS} onpick={txt('temp_units')} />
    <TsField help="import.wind_units" label="Wind speed unit" value={o.wind_units} list={WIND_UNITS} onpick={txt('wind_units')} />
  {/if}
</div>
