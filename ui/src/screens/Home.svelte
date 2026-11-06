<!-- The landing page: greeting, totals, new project from a template, import, and the profile's projects -->
<script>
  import { app } from '../lib/state.svelte.js';
  import { TEMPLATES, EXAMPLE_NAME, createProject, importProject } from '../lib/projects.svelte.js';
  import { legacy } from '../lib/legacy.js';
  import { fmtNum, relTime } from '../lib/format.js';
  import { firstName } from '../lib/profile.js';
  import { welcomeLine } from '../lib/welcome.js';
  import ProjectCard from './ProjectCard.svelte';
  import Footer from './Footer.svelte';

  let newOpen = $state(false), tpl = $state('blank'), npName = $state(''), npStatus = $state(''), npErr = $state(false);
  let query = $state(''), sort = $state('updated'), newBox = $state();

  const hr = new Date().getHours();
  const greeting = $derived(`${hr < 11 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}, ${firstName(app.user.name)}`);
  const list = $derived.by(() => {
    const q = query.toLowerCase();
    const l = app.projects.filter((p) => !q || (p.name || '').toLowerCase().includes(q));
    if (sort === 'name') l.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (sort === 'pv') l.sort((a, b) => (b.pv_kwp || 0) - (a.pv_kwp || 0));
    return l;
  });
  const totPv = $derived(app.projects.reduce((a, p) => a + (p.pv_kwp || 0), 0));
  const totBess = $derived(app.projects.reduce((a, p) => a + (p.bess_kwh || 0), 0));
  const last = $derived(app.projects[0]);

  function showNew() {
    newOpen = true; npName = ''; npStatus = '';
    requestAnimationFrame(() => { if (newBox) { newBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); newBox.querySelector('input').focus(); } });
  }
  async function create(kind, name) {
    npStatus = 'Creating…'; npErr = false;
    try { await createProject(kind, name); newOpen = false; npStatus = ''; } catch (e) { npStatus = e.message; npErr = true; legacy.toast(e.message, true); }
  }
  const createFromForm = () => create(tpl, npName.trim() || TEMPLATES[tpl].name);
  const openExample = () => create('example', EXAMPLE_NAME);
  function onFile(e) {
    const f = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (f) importProject(f);
  }
</script>

<div class="home">
  <main class="home-main">
    <section class="home-band">
      <div class="sunlight" aria-hidden="true"></div>
      <div class="home-hero">
        <div>
          <p class="eyebrow">Local workspace · your data stays on this computer</p>
          <h1>{greeting}</h1>
          <p class="lead">{welcomeLine(app.user.id)}</p>
        </div>
        <div class="hero-actions">
          <button class="btn primary lg" onclick={showNew}><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> New project</button>
          <button class="btn lg" onclick={openExample}>Open the example study</button>
          <label class="btn ghost lg">Import .json<input type="file" accept=".json" hidden onchange={onFile}></label>
        </div>
      </div>
      <div class="home-stats">
        <div><b>{app.projects.length}</b>saved project{app.projects.length === 1 ? '' : 's'}</div>
        <div><b>{fmtNum(totPv / 1000, 1)} MWp</b>PV across projects</div><div><b>{fmtNum(totBess / 1000, 1)} MWh</b>storage across projects</div>
        {#if last}<div><b>{relTime(last.updated)}</b>last edit · {last.name}</div>{/if}
      </div>
    </section>
    {#if newOpen}
      <section class="card" bind:this={newBox}>
        <div class="new-form">
          <div class="row space"><h2>New project</h2><button class="btn ghost small" onclick={() => { newOpen = false; }}>Cancel</button></div>
          <label>Project name <input bind:value={npName} placeholder="e.g. 5 MW PV + Storage Facility" style="width:100%;margin-top:6px"
            onkeydown={(e) => { if (e.key === 'Enter') createFromForm(); }}></label>
          <div><div class="hint" style="margin:0 0 8px">Start from</div>
            <div class="tpl-grid">
              {#each Object.entries(TEMPLATES) as [k, t] (k)}
                <button class="tpl" class:on={k === tpl} onclick={() => { tpl = k; }}><b>{t.name}</b><span>{t.desc}</span></button>
              {/each}
            </div></div>
          <div class="row gap"><button class="btn primary" onclick={createFromForm}>Create project</button>
            <span class="status inline" class:err={npErr} role="status">{npStatus}</span></div>
        </div>
      </section>
    {/if}
    <section>
      <div class="home-tools"><h2>Projects <span class="tag">{app.projects.length}</span></h2>
        <input type="search" bind:value={query} placeholder="Search projects" aria-label="Search projects">
        <select bind:value={sort} aria-label="Sort projects"><option value="updated">Last edited</option><option value="name">Name</option><option value="pv">PV size</option></select></div>
      <div class="project-grid">
        {#if !app.projects.length}
          <div class="home-empty" style="grid-column:1/-1">
            <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.4"><rect x="3" y="11" width="18" height="8" rx="1"/><path d="M6 11l2-6h8l2 6M12 5v14M3 15h18"/></svg>
            <h3>No projects yet</h3><p>Start a blank project for your site, or open the example study to see a complete PV, battery and diesel analysis.</p>
            <div class="row" style="gap:8px;justify-content:center"><button class="btn primary" onclick={showNew}>New project</button><button class="btn" onclick={openExample}>Open the example study</button></div>
          </div>
        {:else if !list.length}
          <p class="hint" style="grid-column:1/-1">No project matches "{query}".</p>
        {:else}
          {#each list as p (p.id)}<ProjectCard {p} />{/each}
        {/if}
      </div>
    </section>
  </main>
  <Footer list />
</div>
