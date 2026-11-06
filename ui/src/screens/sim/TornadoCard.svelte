<!-- What drives the result: the design simulated at the low and high value of one input at a time -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { tor, runTornado, changed, addInput, removeInput, resetInputs } from '../../lib/tornado.svelte.js';
  import { projectKey } from '../../lib/ws/keys.js';
  import { engineProject } from '../../lib/ws/core.js';
  import { TORNADO_METRICS, summarize, tornadoPathList, applyEdit, varRows, tornadoFig, tornadoHeight, tableHeads, tableRows, tornadoNotes } from '../../lib/tornado-view.js';

  const paths = tornadoPathList();
  const cfg = $derived.by(() => { tor.rev; forms.rev; return W.P ? W.P.tornado : null; });
  const cur = $derived.by(() => { forms.rev; return W.P ? W.P.econ.currency : ''; });
  const vars = $derived.by(() => { tor.rev; forms.rev; return W.P ? varRows(W.P) : []; });

  // Does the last run still match the inputs? The fingerprint stringifies the project, so it waits for a pause in editing.
  let stale = $state(false);
  $effect(() => {
    forms.rev; tor.rev;
    const t = setTimeout(() => { stale = !!W.TORNADO && W.TORNADO.key !== projectKey(engineProject()); }, 250);
    return () => clearTimeout(t);
  });

  const S = $derived.by(() => { tor.rev; forms.rev; return W.TORNADO && W.P ? summarize(W.TORNADO, W.P.tornado.metric, stale) : null; });
  const rows = $derived(S ? tableRows(cur, S) : []);
  const notes = $derived(S ? tornadoNotes(cur, S) : []);

  const setMetric = (e) => { W.P.tornado.metric = e.target.value; changed(); };
  const setFast = (e) => { W.P.tornado.fast = e.target.checked; changed(); };
  const setTogether = (e) => { W.P.tornado.bess_together = e.target.checked; changed(); };
  const edit = (i, k, e) => { if (applyEdit(W.P, W.P.tornado.vars[i], k, e.target.value)) changed(); };

  // The chart is as tall as it has bars.
  function build(c) {
    tor.rev; forms.rev;
    if (!S) return null;
    const el = document.getElementById('chTornado');
    if (el) el.style.height = tornadoHeight(S) + 'px';
    return tornadoFig(cur, S, c);
  }
</script>

<div class="card">
  <div class="row space"><h3>What drives the result (tornado)</h3>
    <div class="row gap"><label class="hint inline">Result <select id="tornadoMetric" aria-label="Result shown in the tornado" value={cfg ? cfg.metric : 'npv'} onchange={setMetric}>
        {#each Object.entries(TORNADO_METRICS) as [k, [name]]}<option value={k}>{name}</option>{/each}</select><button type="button" class="info" data-k="tornado.metric" data-title="Result" aria-label="About Result" aria-expanded="false">i</button></label>
      <label class="hint inline"><input type="checkbox" id="tornadoTogether" checked={!!(cfg && cfg.bess_together)} onchange={setTogether}> Battery prices move together<button type="button" class="info" data-k="tornado.bess_together" data-title="Battery prices move together" aria-label="About Battery prices move together" aria-expanded="false">i</button></label>
      <label class="hint inline"><input type="checkbox" id="tornadoFast" checked={!!(cfg && cfg.fast)} onchange={setFast}> Fast (year 1 only)<button type="button" class="info" data-k="tornado.fast" data-title="Fast (year 1 only)" aria-label="About Fast (year 1 only)" aria-expanded="false">i</button></label>
      <button id="btnTornado" class="btn" disabled={tor.busy} onclick={runTornado}>{tor.busy ? '… Run tornado' : 'Run tornado'}</button></div></div>
  <p class="hint">Simulates the design as it is set now once at the low and once at the high value of each input below, one input at a time, and shows how far the result moves from its base value. Unlike the sensitivity cases of Optimise sizing, the sizes stay fixed.</p>
  <div id="tornadoVars" class="table-wrap">
    <table class="data tornado-vars">
      <thead><tr><th>Input</th><th>Path</th><th>Change<button type="button" class="info" data-k="tornado.mode" data-title="Tornado inputs" aria-label="About Tornado inputs" aria-expanded="false">i</button></th>
        <th>Low</th><th>High</th><th>Low · base · high</th><th></th></tr></thead>
      <tbody>
        {#each vars as r, i}
          <tr>
            <td>{r.label}{#if r.together}<span class="close">with power and replacement prices</span>{/if}</td>
            <td><input class="path" list="tornadoPaths" value={r.path} onchange={(e) => edit(i, 'path', e)} aria-label="Input path"></td>
            <td><select value={r.mode} disabled={r.isArray} onchange={(e) => edit(i, 'mode', e)} aria-label="Change">
              {#each [['x', '× base'], ['+', '+ base'], ['=', 'set to']] as [k, l]}<option value={k}>{l}</option>{/each}</select></td>
            <td><input type="number" step="any" value={r.lo} onchange={(e) => edit(i, 'lo', e)} aria-label="Low"><span class="u">{r.unit}</span></td>
            <td><input type="number" step="any" value={r.hi} onchange={(e) => edit(i, 'hi', e)} aria-label="High"><span class="u">{r.unit}</span></td>
            <td>{r.range}</td>
            <td><button class="btn small ghost" onclick={() => removeInput(i)} aria-label="Remove input">✕</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <datalist id="tornadoPaths">{#each paths as [k, l]}<option value={k}>{l}</option>{/each}</datalist>
  <div class="row gap"><button id="tornadoAdd" class="btn small ghost" onclick={addInput}>+ input</button><button id="tornadoReset" class="btn small ghost" onclick={resetInputs}>Default inputs</button><span id="tornadoStatus" class="status inline {tor.kind}" role="status">{tor.status}</span></div>
  <div id="tornadoBody" hidden={!S}>
    <Chart id="chTornado" {build} />
    <p class="hint">Bars start at the base value: blue for the low input value, amber for the high one. Cycle life and calendar fade move the battery replacement year in whole-year steps, so their bars can be lumpy and asymmetric.</p>
    {#if S}
      <div id="tornadoTable" class="table-wrap">
        <table class="data">
          <thead><tr>{#each tableHeads(S) as h}<th>{h}</th>{/each}</tr></thead>
          <tbody>
            {#each rows as x}
              <tr><td>{x.label}</td><td>{x.vals[0]}</td><td>{x.vals[1]}</td>
                {#if x.err}<td colspan="3"><span class="why">{x.err}</span></td>{:else}{#each x.cells as c}<td>{c}</td>{/each}{/if}</tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p id="tornadoNote" class="hint">{notes.join(' ')}</p>
    {/if}
  </div>
</div>
