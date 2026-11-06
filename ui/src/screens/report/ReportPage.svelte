<!-- Report & export page: the buttons, the figures for the report and the preview -->
<script>
  import { exportProject } from '../../lib/ws/project.js';
  import { W } from '../../lib/ws/state.js';
  import { tick } from 'svelte';
  import { rep, preview, exportHtml, printPdf, exportXlsx } from '../../lib/report.svelte.js';
  import { addFigures, setImagery, setField, move, remove } from '../../lib/report-figs.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { figList, FIG_PLACES, DATA_IMG } from '../../lib/report/figures.js';

  let picker = $state(null), addBtn = $state(null);
  // read again whenever the project changes under the page (forms.rev) or a figure is changed here (rep.rev)
  const view = $derived.by(() => {
    void forms.rev; void rep.rev;
    const P = W.P, r = P && P.report;
    return { list: r ? figList(P).slice() : [], imagery: !!(r && r.imagery) };
  });
  const list = $derived(view.list), imagery = $derived(view.imagery);

  // keep the focus on a control of the row the figure moved to (the first that can take it), or on Add figures
  async function act(fn, i, ...controls) {
    fn();
    await tick();
    const row = document.querySelector(`#figList .fig-row[data-i="${i}"]`);
    const target = row && controls.map((c) => row.querySelector(c)).find((el) => el && !el.disabled);
    (target || addBtn)?.focus();
  }
</script>

<h1>Report &amp; export</h1>
<p class="lead">An engineering report (executive summary, resource, load, PV yield and losses, equipment schedule, electrical design with SLD and cable schedule, simulation, economics, optimisation, forecasting, method) and an Excel workbook with every input and result table, including the 8760-hour time series.</p>
<div class="row gap">
  <button id="btnRepPreview" class="btn" onclick={preview}>Refresh preview</button>
  <button id="btnRepHtml" class="btn primary" disabled={rep.busy} onclick={exportHtml}>Download report (HTML)</button>
  <button id="btnPrint" class="btn primary" disabled={rep.busy} onclick={printPdf}>Print / Save as PDF</button>
  <button id="btnXlsx" class="btn primary" disabled={rep.busy} onclick={exportXlsx}>Export Excel workbook (.xlsx)</button>
  <button id="btnRepJson" class="btn ghost" onclick={() => exportProject()}>Export project (.json)</button>
</div>
<div class="card" id="figCard">
  <div class="row space">
    <h3>Figures for the report</h3>
    <button type="button" class="btn small" id="figAddBtn" bind:this={addBtn} onclick={() => picker.click()}>Add figures</button>
    <input type="file" id="figAdd" accept="image/png,image/jpeg,image/webp" multiple hidden bind:this={picker} onchange={(e) => { addFigures([...e.currentTarget.files]); e.currentTarget.value = ''; }}>
  </div>
  <p class="hint">Site photos, drawings or diagrams for the report, each with a caption: up to 12 figures, PNG, JPEG or WebP, scaled to 1,800 px on the long side and saved in the project file. A figure placed under Energy simulation prints under Additional figures until a simulation has run. The report also draws the PV areas and the layout from the Site &amp; layout page.</p>
  <label class="check"><input type="checkbox" id="figImagery" checked={imagery} onchange={(e) => setImagery(e.currentTarget.checked)}><span>Satellite image under the layout drawing (Esri World Imagery, fetched for the preview when this page opens and for the report; needs internet)</span></label>
  <div id="figList">
    {#each list as f, i (f.id)}
      <div class="fig-row" data-i={i}>
        <img src={DATA_IMG.test(f.src) ? f.src : ''} alt="">
        <div class="fig-fields">
          <label>Caption<input maxlength="300" value={f.caption || ''} onchange={(e) => setField(i, 'caption', e.currentTarget.value)}></label>
          <label>Place in the report
            <select value={FIG_PLACES[f.place] ? f.place : 'appendix'} onchange={(e) => setField(i, 'place', e.currentTarget.value)}>
              {#each Object.entries(FIG_PLACES) as [k, t]}<option value={k}>{t}</option>{/each}
            </select>
          </label>
        </div>
        <div class="fig-btns">
          <button class="btn ghost small" disabled={!i} aria-label="Move figure {i + 1} up" onclick={() => act(() => move(i, -1), i - 1, '[data-mv="-1"]', '[data-mv="1"]')} data-mv="-1">↑</button>
          <button class="btn ghost small" disabled={i >= list.length - 1} aria-label="Move figure {i + 1} down" onclick={() => act(() => move(i, 1), i + 1, '[data-mv="1"]', '[data-mv="-1"]')} data-mv="1">↓</button>
          <button class="btn ghost small danger" aria-label="Remove figure {i + 1}" data-rm onclick={() => act(() => remove(i), Math.min(i, list.length - 2), '[data-rm]')}>Remove</button>
        </div>
      </div>
    {:else}
      <p class="hint">No figures yet.</p>
    {/each}
  </div>
</div>
<div id="report" class="report">
  {#if rep.building && !rep.html}<p class="hint">Building preview…</p>{/if}
  {#if rep.html}<iframe class="report-frame" sandbox="" title="Report preview" srcdoc={rep.html}></iframe>{/if}
</div>
