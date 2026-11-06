<!-- The interface's root: top bar, sign-in or landing page, and the dialogs. The workspace shows while app.screen is
     'workspace' (body class home-mode off). -->
<script>
  import { app } from './lib/state.svelte.js';
  import TopBar from './screens/TopBar.svelte';
  import SignIn from './screens/SignIn.svelte';
  import Home from './screens/Home.svelte';
  import Workspace from './screens/workspace/Workspace.svelte';
  import ReportForm from './screens/reports/ReportForm.svelte';
  import ReportList from './screens/reports/ReportList.svelte';
  import AskDialog from './screens/AskDialog.svelte';

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
<Workspace />
{#if app.dialog === 'settings' && app.user}{#await import('./screens/Settings.svelte') then m}<m.default />{/await}{/if}
{#if app.dialog === 'update'}{#await import('./screens/UpdateDialog.svelte') then m}<m.default />{/await}{/if}
{#if app.dialog === 'legal'}{#await import('./screens/LegalDialog.svelte') then m}<m.default />{/await}{/if}
<ReportForm />
<ReportList />
<AskDialog />
