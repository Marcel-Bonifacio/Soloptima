<!-- Script console: a numeric workspace (JavaScript with numeric helpers, plots, tables and engine calls). The output and the
     figures are drawn as elements, so nothing a script prints is read as HTML. -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { EXAMPLES } from '../../lib/console/examples.js';
  import { sc, saved, open, example, save, clear, run } from '../../lib/console/console.svelte.js';
  import { con, lines, figs, print } from '../../lib/console/output.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { onMount } from 'svelte';

  let out, name = $state('analysis'), exSel = $state('');
  const rows = $derived.by(() => { con.rev; return lines.slice(); });
  const figures = $derived.by(() => { con.rev; return figs; });
  const list = $derived.by(() => { forms.rev; return saved(); });

  onMount(() => { if (!lines.length) print('Soloptima script console. Type help() for the function list, or pick an example.', 'info'); });
  $effect(() => { rows; if (out) out.scrollTop = out.scrollHeight; });

  function keys(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const t = e.currentTarget, s = t.selectionStart;
      sc.code = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
      queueMicrotask(() => { t.selectionStart = t.selectionEnd = s + 2; });
    }
  }
  function doSave() { if (save(name)) sc.naming = false; }
</script>

<div class="grid-2 script-grid">
  <div class="card"><div class="row space"><h3>Editor</h3>
      <div class="row gap">
        <select id="scExamples" aria-label="Examples" bind:value={exSel} onchange={() => { if (exSel) { example(exSel); exSel = ''; } }}>
          <option value="">Examples…</option>{#each Object.keys(EXAMPLES) as k (k)}<option value={k}>{k}</option>{/each}</select>
        <button id="scRun" class="btn primary small" disabled={sc.busy} onclick={run}>▶ Run (Ctrl+Enter)</button>
        <button id="scSave" class="btn small ghost" onclick={() => (sc.naming = !sc.naming)}>Save script</button></div></div>
    {#if sc.naming}
      <div class="row gap"><input id="scName" aria-label="Script name" bind:value={name} onkeydown={(e) => { if (e.key === 'Enter') doSave(); }}>
        <button type="button" class="btn small primary" onclick={doSave}>Save</button><button type="button" class="btn small ghost" onclick={() => (sc.naming = false)}>Cancel</button></div>
    {/if}
    <div id="scSaved" class="chips">{#each list as s, i (s.name)}<button type="button" class="chip" onclick={() => open(i)}>{s.name}</button>{/each}</div>
    <textarea id="scCode" spellcheck="false" bind:value={sc.code} onkeydown={keys}></textarea></div>
  <div class="card"><div class="row space"><h3>Output</h3><button id="scClear" class="btn small ghost" onclick={clear}>Clear</button></div>
    <div id="scOut" class="console" bind:this={out}>
      {#each rows as r, i (i)}
        {#if r.k === 'table'}
          <div><table><thead><tr>{#each r.cols as c (c)}<th>{c}</th>{/each}</tr></thead><tbody>{#each r.rows as row, j (j)}<tr>{#each row as x, k (k)}<td>{x}</td>{/each}</tr>{/each}</tbody></table></div>
        {:else if r.k === 'help'}
          <div class={r.cls}>{#each r.rows as [l, t] (l)}<div><b>{l}</b> {t}</div>{/each}</div>
        {:else}<div class={r.cls}>{r.text}</div>{/if}
      {/each}
    </div></div>
</div>
<div id="scFigs">{#each figures as f, i (i)}
  <div class="card fig-card"><h3>{f.title}</h3><Chart id="chScript{i}" cls="tall" build={() => ({ traces: f.traces, layout: f.layout })} /></div>
{/each}</div>
