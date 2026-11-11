<!-- Report a problem or send feedback: saved as a file pair in the reports folder (lib/reports.svelte.js) -->
<script>
  import Dialog from '../../lib/Dialog.svelte';
  import { rp, closeForm, submit, infoNow, recentCount, trailCount, inHome } from '../../lib/reports.svelte.js';
  import { KINDS, SEVERITY } from '../../lib/reports/doc.js';

  const LABEL = { bug: 'What happened', feedback: 'Your feedback', feature: 'What you would like Soloptima to do, and why' };
  let title = $state(''), what = $state(''), steps = $state(''), expected = $state(''), severity = $state('medium');
  let withErrors = $state(true), withProject = $state(false), withDiag = $state(true), titleEl;
  const info = $derived(infoNow()), errors = $derived(recentCount());
  $effect(() => { if (rp.form) { title = what = steps = expected = ''; severity = 'medium'; withErrors = recentCount() > 0; withProject = false; withDiag = true; } });

  function send(e) {
    e.preventDefault();
    if (!title.trim()) { titleEl.focus(); return; }
    submit({ title, what, steps, expected, severity, recent: withErrors && errors > 0, diag: withDiag, project: withProject && !inHome() });
  }
</script>

<Dialog open={rp.form} onclose={closeForm} title="Report a problem or send feedback" label="Report a problem">
  <form onsubmit={send} class="dlg-form">
    <div class="seg" role="group" aria-label="Kind of report">
      {#each ['bug', 'feedback', 'feature'] as k (k)}
        <button type="button" class:on={k === rp.kind} onclick={() => (rp.kind = k)}>{KINDS[k]}</button>
      {/each}
    </div>
    <label>Title<input bind:this={titleEl} bind:value={title} maxlength="120" required placeholder="Short summary, for example: Optimiser stops at 40 %"></label>
    <label><span>{LABEL[rp.kind]}</span><textarea bind:value={what} rows="4"></textarea></label>
    {#if rp.kind === 'bug'}
      <div class="grid-2">
        <label>Steps to reproduce<textarea bind:value={steps} rows="3" placeholder={'1. Open the example study\n2. ...'}></textarea></label>
        <label>What you expected<textarea bind:value={expected} rows="3"></textarea></label>
      </div>
      <label>Severity
        <select bind:value={severity}>{#each Object.entries(SEVERITY) as [k, t] (k)}<option value={k}>{t}</option>{/each}</select>
      </label>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={withErrors} disabled={!errors}><span>Attach the errors of this session ({errors})</span></label>
    <label class="check"><input type="checkbox" bind:checked={withDiag}><span>Attach the diagnostic log: the last {trailCount()} steps of this session (pages, clicks, changed fields, engine calls and their times), the computer and an outline of the open project</span></label>
    <label class="check"><input type="checkbox" bind:checked={withProject} disabled={inHome()}><span>Attach the open project's inputs</span></label>
    <p class="hint">The report is saved in {info.reports_dir || 'the reports folder'} with a dated history. Nothing is sent anywhere.</p>
    <div class="dlg-foot"><button type="button" class="btn" onclick={closeForm}>Cancel</button><button type="submit" class="btn primary" disabled={rp.saving}>Save report</button></div>
  </form>
</Dialog>
