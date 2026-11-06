<!-- The interface's root: top bar, sign-in or landing page, and the dialogs. The workspace (web/index.html .shell) is still
     the old one; it shows while app.screen is 'workspace' (body class home-mode off). -->
<script>
  import { app } from './lib/state.svelte.js';
  import TopBar from './screens/TopBar.svelte';
  import SignIn from './screens/SignIn.svelte';
  import Home from './screens/Home.svelte';
  import Settings from './screens/Settings.svelte';
  import UpdateDialog from './screens/UpdateDialog.svelte';
  import LegalDialog from './screens/LegalDialog.svelte';

  // to the main content of whatever shows
  function skip(e) {
    e.preventDefault();
    const m = [...document.querySelectorAll('main')].find((x) => x.offsetParent !== null);
    if (m) { m.tabIndex = -1; m.focus(); }
  }
</script>

<a class="skip" href="#mainContent" onclick={skip}>Skip to content</a>
<TopBar />
{#if app.screen === 'signin'}
  {#key app.signin}<SignIn />{/key}
{:else if app.screen === 'home' && app.user}
  <Home />
{/if}
{#if app.dialog === 'settings' && app.user}<Settings />{/if}
{#if app.dialog === 'update'}<UpdateDialog />{/if}
{#if app.dialog === 'legal'}<LegalDialog />{/if}
