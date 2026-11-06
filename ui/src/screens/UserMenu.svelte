<!-- The profile menu of the top bar: switch, add, sign out, remove; settings, reports, terms, quit -->
<script>
  import { app, openDialog } from '../lib/state.svelte.js';
  import { switchUser, signOut, removeProfile, toSignIn } from '../lib/session.svelte.js';
  import { flush, readyToClose } from '../lib/projects.svelte.js';
  import { call } from '../lib/ipc.js';
  import { legacy } from '../lib/legacy.js';
  import Avatar from '../lib/Avatar.svelte';

  let menu, dataDir = $state('');
  call('info').then((i) => { dataDir = i.data_dir; }).catch(() => {});

  // a click anywhere else closes the menu
  $effect(() => {
    const out = (e) => { if (!menu.contains(e.target)) app.menuOpen = false; };
    document.addEventListener('click', out, true);
    return () => document.removeEventListener('click', out, true);
  });
  const close = () => { app.menuOpen = false; };
  async function quit() {
    if (await readyToClose()) call('quit_ready').catch(() => {});
  }
</script>

<div class="menu" bind:this={menu}>
  <h4>Profiles on this computer</h4>
  {#each app.users as u (u.id)}
    <button class="menu-item" class:active={app.user && u.id === app.user.id} onclick={() => switchUser(u.id)}>
      <Avatar user={u} />{u.name}<span class="spacer"></span><small style="color:var(--muted)">{u.projects}</small>
    </button>
  {/each}
  <button class="menu-item" onclick={async () => { close(); await flush(); toSignIn('new'); }}>Add a profile…</button>
  {#if app.user}
    <button class="menu-item" onclick={() => { close(); signOut(); }}>Sign out</button>
    <button class="menu-item" style="color:var(--danger)" onclick={removeProfile}>Remove profile "{app.user.name}"…</button>
  {/if}
  <hr>
  {#if app.user}<button class="menu-item" onclick={() => openDialog('settings')}>Settings…</button>{/if}
  <button class="menu-item" onclick={() => { close(); legacy.reports('list'); }}>Bug reports and feedback</button>
  <button class="menu-item" onclick={() => openDialog('legal', 'terms')}>Terms of use and licence</button>
  <hr>
  {#if dataDir}<div class="hint" style="margin:4px 8px 6px;font-size:12px;word-break:break-all">Projects are saved in {dataDir}</div>{/if}
  <button class="menu-item" onclick={quit}>Quit Soloptima</button>
</div>
