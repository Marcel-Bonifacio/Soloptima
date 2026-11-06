<!-- Settings: the profile (name, picture, organisation, email), the projects folder, updates and the caches -->
<script>
  import { clearImageryCache } from '../lib/report/layout-geom.js';
  import { toast } from '../lib/toast.js';
  import { app } from '../lib/state.svelte.js';
  import { updateProfile, folderChanged } from '../lib/session.svelte.js';
  import { flush } from '../lib/projects.svelte.js';
  import { check } from '../lib/update.svelte.js';
  import { call } from '../lib/ipc.js';
  import { STORE_KEY, storeGet, storeRemove } from '../lib/storage.js';
  import { fmtNum, plural } from '../lib/format.js';
  import { avatarPic, avatarImage } from '../lib/profile.js';
  import Avatar from '../lib/Avatar.svelte';
  import Dialog from '../lib/Dialog.svelte';

  let S = $state(null);
  let name = $state(app.user.name), organisation = $state(app.user.organisation || ''), email = $state(app.user.email || '');
  let pic = $state(avatarPic(app.user)), profileMsg = $state(['', '']);
  let dir = $state(''), mode = $state('move'), dirMsg = $state(['', '']), dirBusy = $state(false), browsing = $state(false);
  let cacheMsg = $state(['', '']), clearing = $state(false), fileInput, nameInput = $state();
  const close = () => { app.dialog = null; };

  call('settings').then((s) => { S = s; requestAnimationFrame(() => nameInput && nameInput.focus()); })
    .catch((e) => { toast(e.message, true); close(); });

  async function choosePic(e) {
    const f = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!f) return;
    try { pic = await avatarImage(f); profileMsg = ['Save the profile to keep the new picture.', '']; } catch (err) { profileMsg = [`${f.name}: the image could not be read.`, 'err']; }
  }
  async function saveProfile() {
    if (!name.trim()) { profileMsg = ['Enter a name.', 'err']; nameInput.focus(); return; }
    try {
      await updateProfile({ name: name.trim(), organisation: organisation.trim(), email: email.trim(), avatar: pic });
      profileMsg = ['Profile saved.', 'ok'];
    } catch (err) { profileMsg = [err.message, 'err']; }
  }
  async function browse() {
    browsing = true;
    dirMsg = ['Choose a folder in the window that opened.', ''];
    try {
      const r = await call('settings_pick_folder');
      dirMsg = ['', ''];
      if (r.path) dir = r.path;
    } catch (err) { dirMsg = [err.message, 'err']; }
    browsing = false;
  }
  async function changeFolder() {
    dirBusy = true;
    dirMsg = [mode === 'move' ? 'Copying…' : 'Opening the folder…', ''];
    try {
      await flush();   // the open project is saved to the current folder first
      const r = await call('settings_data_dir', { body: { path: dir.trim(), mode } });
      if (!(await folderChanged())) { toast(`Projects folder changed to ${r.data_dir}. Choose a profile.`); return; }
      S.data_dir = r.data_dir;
      dir = '';
      dirMsg = [mode === 'move' ? `Copied ${fmtNum(r.copied)} files. The previous folder ${r.previous} is unchanged.` : 'Now using this folder.', 'ok'];
    } catch (err) { dirMsg = [err.message, 'err']; }
    dirBusy = false;
  }
  async function clearCache() {
    clearing = true;
    try {
      const r = await call('cache_clear', { body: {} });
      const imgs = clearImageryCache();
      // a project kept in this browser before profiles existed, already moved to the projects folder
      if (storeGet('soloptima.migrated') && storeGet(STORE_KEY)) storeRemove(STORE_KEY);
      const n = (k, one, many) => (k ? plural(k, one, many) : '');
      const parts = [n(r.weather_sets, 'weather data set'), n(r.yield_checks, 'PV yield check'), n(r.results, 'finished run'),
        n(imgs, 'satellite image'), n(r.temp_files, 'leftover file')].filter(Boolean);
      cacheMsg = [parts.length ? `Cleared ${parts.join(', ')}.` : 'The cache was already empty.', 'ok'];
    } catch (err) { cacheMsg = [err.message, 'err']; }
    clearing = false;
  }
  const setAuto = (e) => call('settings_update', { body: { auto: e.currentTarget.checked } }).catch((err) => toast(err.message, true));
</script>

<Dialog open={!!S} onclose={close} title="Settings" label="Settings" class="settings">
  {@const fixed = S.source === 'option'}
  <section class="set-sec"><h3>Profile</h3>
    <div class="set-profile"><Avatar user={{ id: app.user.id, name: name.trim() || app.user.name, avatar: pic }} class="big" />
      <div class="row gap"><button type="button" class="btn small" onclick={() => fileInput.click()}>Change picture…</button>
        {#if pic}<button type="button" class="btn ghost small" onclick={() => { pic = ''; profileMsg = ['Save the profile to remove the picture.', '']; }}>Remove picture</button>{/if}
        <input type="file" bind:this={fileInput} accept="image/png,image/jpeg,image/webp" hidden onchange={choosePic}></div></div>
    <div class="grid-2"><label>Name<input bind:this={nameInput} bind:value={name} maxlength="60" autocomplete="name"></label>
      <label><span>Organisation <small>optional</small></span><input bind:value={organisation} maxlength="120" autocomplete="organization"></label></div>
    <label><span>Email <small>optional, added to the bug reports you write</small></span><input bind:value={email} type="email" maxlength="120" autocomplete="email"></label>
    <div class="row gap"><button type="button" class="btn primary small" onclick={saveProfile}>Save profile</button><span class="status inline {profileMsg[1]}" role="status">{profileMsg[0]}</span></div>
  </section>
  <section class="set-sec"><h3>Projects folder</h3>
    <p class="hint">The profiles, projects and bug reports of everyone using Soloptima on this computer are kept in this folder.</p>
    <code class="set-path">{S.data_dir}</code>
    <div class="row gap"><button type="button" class="btn ghost small"
      onclick={() => call('open_folder', { which: 'data' }).catch((err) => toast(err.message || 'Cannot open the folder.', true))}>Open folder</button></div>
    {#if S.note}<p class="status err inline">{S.note}</p>{/if}
    {#if fixed}
      <p class="hint">Soloptima was started with the --data option, which sets the folder for this run.</p>
    {:else}
      <label>New folder<span class="set-pick"><input bind:value={dir} placeholder="Full path of a folder" spellcheck="false" autocomplete="off">
        <button type="button" class="btn small" disabled={browsing} onclick={browse}>Browse…</button></span></label>
      <fieldset class="set-mode"><legend>What to do with it</legend>
        <label class="check"><input type="radio" bind:group={mode} value="move"><span><b>Move my data there.</b> Everything is copied to the new folder. The current folder stays as it is, as a backup you can delete later.</span></label>
        <label class="check"><input type="radio" bind:group={mode} value="use"><span><b>Open the data already in that folder</b>, for example a backup or a folder synced from another computer.</span></label></fieldset>
      <div class="row gap"><button type="button" class="btn small" disabled={dirBusy || !dir.trim()} onclick={changeFolder}>Change folder</button>
        {#if S.source !== 'default'}<button type="button" class="btn ghost small" onclick={() => { dir = S.default_dir; }}>Use the default folder</button>{/if}
        <span class="status inline {dirMsg[1]}" role="status">{dirMsg[0]}</span></div>
    {/if}
  </section>
  <section class="set-sec"><h3>Updates</h3>
    <p class="hint">Soloptima {S.version}. After sign-in, Soloptima looks for a newer version on GitHub at most once a day. It asks before it downloads anything.</p>
    <label class="check"><input type="checkbox" checked={S.update_auto} onchange={setAuto}><span>Check for updates automatically</span></label>
    <div class="row gap"><button type="button" class="btn small" onclick={() => check(true)}>Check now</button></div>
  </section>
  <section class="set-sec"><h3>Cache</h3>
    <p class="hint">Clears the weather data and PV yield checks downloaded since Soloptima started, finished optimisation and variability runs held by the engine, the satellite images of the report and files left by interrupted saves. Profiles, projects, reports and the results on screen are not touched; data is downloaded again when needed.</p>
    <div class="row gap"><button type="button" class="btn small" disabled={clearing} onclick={clearCache}>Clear cache</button><span class="status inline {cacheMsg[1]}" role="status">{cacheMsg[0]}</span></div>
  </section>
</Dialog>
