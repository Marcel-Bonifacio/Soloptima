<!-- The top bar. #projName, #btnSave and #btnRunTop belong to the old workspace (web/js/app.js wires them) until it is ported. -->
<script>
  import { app } from '../lib/state.svelte.js';
  import { goHome } from '../lib/session.svelte.js';
  import { upd, openUpdate } from '../lib/update.svelte.js';
  import { openForm, openList } from '../lib/reports.svelte.js';
  import { avatarPic, colorOf, initials } from '../lib/profile.js';
  import UserMenu from './UserMenu.svelte';

  const pic = $derived(avatarPic(app.user));
  const saveText = $derived({ saving: 'Saving…', dirty: 'Unsaved changes', error: 'Save failed' }[app.save.state] || `Saved ${app.save.at}`);
  const saveClass = $derived(app.save.state === 'saving' ? 'saving' : app.save.state === 'saved' ? '' : 'unsaved');
</script>

<header class="topbar">
  <button class="brand" title="All projects" onclick={goHome}><img src="img/logo.svg" alt="Soloptima" width="142" height="27"></button>
  <nav class="crumbs ws-only" aria-label="Breadcrumb">
    <a href="#top" onclick={(e) => { e.preventDefault(); goHome(); }}>Projects</a><span aria-hidden="true">/</span>
    <input id="projName" class="proj-name" placeholder="Project name" aria-label="Project name">
    <span class="save-state {saveClass}">{saveText}</span>
  </nav>
  <div class="top-actions">
    <button id="btnSave" class="btn ghost small ws-only" title="Download the project as a .json file">Export .json</button>
    <button id="btnRunTop" class="btn primary small ws-only"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l12 7-12 7z"/></svg> Run simulation</button>
    {#if upd.button}
      <button class="btn small update" title="A new version of Soloptima is available" onclick={openUpdate}>Update to {upd.button}</button>
    {/if}
    <button class="btn ghost small" title="Report a problem or send feedback" onclick={() => openForm()}><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7V5a4 4 0 0 1 8 0v2M6 9h12v5a6 6 0 0 1-12 0zM3 13h3M18 13h3M4 7l2.5 2M20 7l-2.5 2M5 19l2-1.5M19 19l-2-1.5M12 9v11"/></svg> Report</button>
    <div class="user-menu">
      <button class="avatar" class:pic aria-haspopup="true" aria-expanded={app.menuOpen}
        style:background={pic ? '' : app.user ? colorOf(app.user.id) : 'var(--muted)'}
        title={app.user ? `Switch user (${app.user.name})` : 'Create a profile'}
        onclick={(e) => { e.stopPropagation(); app.menuOpen = !app.menuOpen; }}>
        {#if pic}<img src={pic} alt="">{:else}{app.user ? initials(app.user.name) : '+'}{/if}
      </button>
      {#if app.menuOpen}<UserMenu />{/if}
    </div>
  </div>
</header>
