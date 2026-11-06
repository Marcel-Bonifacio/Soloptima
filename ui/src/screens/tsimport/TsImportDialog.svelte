<!-- The import dialog of a timestamped load or weather file: preview, options, the engine's import report, then "Use these data".
     Every cell, name and message is shown as text (Svelte escapes it); nothing of the file is read as markup. -->
<script>
  import { W } from '../../lib/ws/state.js';
  import TsOptions from './TsOptions.svelte';
  import { ts, result, closeImport, check, use, canUse, fillLong, clockAllowed } from '../../lib/tsimport.svelte.js';
  import { reportRows, unitHints, KIND_TEXT } from '../../lib/tsimport/texts.js';
  import { cells, WX } from '../../lib/tsimport/guess.js';
  import { fmtNum } from '../../lib/format.js';

  let d;
  const S = $derived(ts.dlg);
  $effect(() => {
    if (S && !d.open) d.showModal();
    else if (!S && d.open) d.close();
  });

  const res = $derived(ts.rev >= 0 ? result() : null);
  const idx = $derived(S ? Array.from({ length: S.ncol }, (_, i) => i) : []);
  const vals = $derived(S ? (S.kind === 'load' ? S.opt.cols : WX.map(([k]) => S.opt[k]).filter((i) => i >= 0)) : []);
  const cls = (i) => (S && (i === S.opt.time_col || i === S.opt.time2_col) ? 'c-time' : vals.includes(i) ? 'c-val' : '');
  const rows = $derived(S ? S.lines.map((l) => cells(S, l)) : []);
  const R = $derived(res ? res.report : null);
  const hints = $derived(res ? unitHints(S.kind, res, W.P.diesel) : []);
  const usable = $derived.by(() => { ts.rev; return S ? canUse() : false; });
</script>

<dialog bind:this={d} class="dlg wide ts" aria-label="Import a CSV file" onclose={() => { if (ts.dlg) closeImport(); }}>
  {#if S}
    <div class="dlg-body ts">
      <div class="dlg-head"><h2>Import {KIND_TEXT[S.kind]} data: {S.file}</h2><button type="button" class="btn ghost small" onclick={closeImport}>Close</button></div>
      <p class="hint">{fmtNum(S.nlines)} lines. The first {S.lines.length} non-blank lines are shown; the time column is highlighted in blue and the {S.kind === 'load' ? 'load columns' : 'value columns'} in amber. Check the file to see how it is read before its data replace the project's.</p>
      <div class="table-wrap ts-preview" id="tsPreview">
        <table class="data"><thead><tr><th>Row</th>{#each idx as i (i)}<th class={cls(i)}>{i + 1}</th>{/each}</tr></thead>
          <tbody>{#each rows as r, k (k)}<tr class:ts-hdr={k < S.hdr}><td>{k + 1}</td>{#each idx as i (i)}<td class={cls(i)}>{(r[i] || '').slice(0, 40)}</td>{/each}</tr>{/each}</tbody></table>
      </div>
      <TsOptions />
      <div id="tsReport" class="ts-report">
        {#if S.stale}<p class="status">The options changed: check the file again.</p>
        {:else if S.err}<div class="warnbox">{S.err}</div>
        {:else if !res}<p class="status">Reading the file…</p>
        {:else}
          <h3>Import report</h3>
          <table class="data ts-rep"><tbody>{#each reportRows(R) as [l, v] (l)}<tr><td>{l}</td><td>{v}</td></tr>{/each}</tbody></table>
          {#each R.notes || [] as n (n)}<p class="hint">{n}</p>{/each}
          {#if res.long_gap}<div class="warnbox">No load for {fmtNum(res.long_gap.hours)} h in a row from {res.long_gap.from}: gaps over 72 h are not filled unless you ask for it. <button type="button" class="btn small" onclick={fillLong}>Fill long gaps from adjacent weeks</button></div>{/if}
          {#if R.dst_suspect}<div class="warnbox">One hour is missing in spring and one doubled in autumn: the file looks like clock time with daylight saving. Choose <b>Local clock time with daylight saving</b>{clockAllowed(S.opt.time_col) ? '' : ' (set the site first, on Site & layout, so its time zone is known)'}.</div>{/if}
          {#if R.clock_skipped}<div class="warnbox">{fmtNum(R.clock_skipped)} stamps fall in the hour skipped when the clocks went forward; they were read with the offset before the change.</div>{/if}
          {#each hints as h (h)}<div class="warnbox">{h}</div>{/each}
        {/if}
      </div>
      <div class="dlg-foot"><button type="button" class="btn" onclick={closeImport}>Cancel</button><button type="button" class="btn" id="tsCheck" disabled={S.busy} onclick={check}>Check file</button><button type="button" class="btn primary" id="tsUse" disabled={!usable} onclick={use}>Use these data</button></div>
    </div>
  {/if}
</dialog>
