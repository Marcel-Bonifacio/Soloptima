<!-- The side navigation of the workspace: the pages, a mark for each key input that is done, the progress and the engine state -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { ws, showTab } from '../../lib/ws/tabs.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { res } from '../../lib/results.svelte.js';
  import { checks } from '../../lib/ws/checks.js';
  import { GROUPS } from '../../lib/ws/nav.js';

  let { engine } = $props();
  const DOTS = new Set(['site', 'resource', 'load', 'pv']);
  const c = $derived.by(() => { forms.rev; res.rev; return W.P ? checks(W.P, W.PVR, W.SIM) : null; });
</script>

<nav class="sidebar" id="nav" aria-label="Project steps">
  {#each GROUPS as [title, items] (title)}
    <div class="nav-title">{title}</div>
    {#each items as [tab, icon, label] (tab)}
      <!-- svelte-ignore a11y_missing_attribute -->
      <a class:active={ws.tab === tab} data-tab={tab} onclick={() => showTab(tab)} role="link" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') showTab(tab); }}>
        {#if /^\d$/.test(icon)}<b>{icon}</b>{:else}
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            {#if tab === 'opt'}<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>
            {:else if tab === 'report'}<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>
            {:else if tab === 'sim'}<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-4 3 2 5-6"/>
            {:else}<path d={icon}/>{/if}
          </svg>
        {/if}
        {' '}{label}
        {#if DOTS.has(tab) && c}<i class="dot" class:ok={c.ok[tab]} class:warn={tab === 'site' && c.tzWarn} title={tab === 'site' && c.tzWarn ? 'Check the UTC offset of the site' : ''}></i>{/if}
      </a>
    {/each}
  {/each}
  <div class="nav-progress"><div class="bar"><div style:width={c ? (100 * c.done / c.total) + '%' : '0%'}></div></div><span>{c ? `${c.done} of ${c.total} key steps done` : ''}</span></div>
  <div class="nav-foot">{engine}</div>
</nav>
