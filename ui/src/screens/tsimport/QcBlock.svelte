<!-- The Data checks block under the annual summary (Solar resource) or the load statistics (a measured load). The flags and notes come
     from the engine's data_qc and the project; they are shown as text. -->
<script>
  import { ts, runQc, fixWeather } from '../../lib/tsimport.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { legacy } from '../../lib/legacy.js';
  import { hasHelp } from '../../lib/help/index.js';
  import { pageView, days } from '../../lib/tsimport/texts.js';
  import { fmtNum, fmtPct } from '../../lib/format.js';

  let { kind } = $props();
  let pending = $state(false);
  $effect(() => { ts.qcRev; pending = false; });
  const v = $derived.by(() => { forms.rev; ts.qcRev; return pageView(kind, legacy.project()); });
</script>

{#if v}
  <h3 class="mt">Data checks{#if hasHelp('qc.' + kind)}<button type="button" class="info" data-k={'qc.' + kind} data-title="Data checks" aria-label="About Data checks" aria-expanded="false">i</button>{/if}</h3>
  {#if v.line}<p class="hint">{v.line}</p>{/if}
  {#if !v.Q}
    <p class="hint">Not run for these data. <button type="button" class="btn small" disabled={pending} onclick={() => { pending = true; runQc(kind); }}>Run data checks</button></p>
  {:else}
    {#if v.flags.length}
      <div class="table-wrap"><table class="data qc-table"><thead><tr><th>Flag</th><th>Hours</th><th>Days</th>{#if v.weather}<th>Share of GHI</th>{/if}</tr></thead>
        <tbody>{#each v.flags as f (f.id)}<tr><td>{f.label}</td><td>{fmtNum(f.hours)}</td><td>{fmtNum(f.days)}</td>{#if v.weather}<td>{fmtPct(f.ghi_share, 2)}</td>{/if}</tr>{/each}</tbody></table></div>
      <p class="hint">{fmtNum(v.Q.n_flagged)} h flagged on {days(v.Q.days.length)} (outlined in the heatmap below); {fmtPct(v.Q.score)} of the days have no flag{v.weather ? `, and the flagged hours hold ${fmtPct(v.Q.ghi_share, 2)} of the year's GHI` : ''}. The flags are for information only: the data are used unchanged.</p>
    {:else}<p class="hint">No hour flagged.</p>{/if}
    {#each v.notes as t (t)}<p class="hint">{t}</p>{/each}
    {#if v.timing}
      <div class="{v.timing.ok ? 'hint' : 'warnbox'} qc-timing">{v.timing.text}{#each v.timing.fix as [l, a, x] (a)} <button type="button" class="btn small" onclick={() => fixWeather(a, x)}>{l}</button>{/each}</div>
    {/if}
    {#if v.hours.length}
      <details class="qc-hours"><summary>Flagged hours{v.Q.n_list > v.hours.length ? ` (the first ${v.hours.length} of ${fmtNum(v.Q.n_list)})` : ''}</summary>
        <div class="table-wrap"><table class="data"><thead><tr><th>Local time</th><th>Flag</th><th>Value</th></tr></thead>
          <tbody>{#each v.hours as x, i (i)}<tr><td>{x.when}</td><td>{x.flag}</td><td>{x.value}</td></tr>{/each}</tbody></table></div></details>
    {/if}
  {/if}
{/if}
