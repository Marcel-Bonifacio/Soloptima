<!-- Sign-in: choose a profile, create one, or accept changed terms of use. No password: projects are plain files in the
     data folder, so a password would protect nothing. A new profile first accepts the licence and the terms of use
     (step 1), then enters its name (step 2). Both texts are local files, so this works without an internet connection.
     Each text opens in a pop-up from its link; its tick box unlocks only once that pop-up has been scrolled to the end
     (lib/read-to-end.js). -->
<script>
  import { toast } from '../lib/toast.js';
  import { app, accepted } from '../lib/state.svelte.js';
  import { chooseProfile, createProfile, acceptTerms, toSignIn } from '../lib/session.svelte.js';
  import { firstName } from '../lib/profile.js';
  import Avatar from '../lib/Avatar.svelte';
  import Markdown from '../lib/Markdown.svelte';
  import Dialog from '../lib/Dialog.svelte';
  import Footer from './Footer.svelte';

  import { readToEnd } from '../lib/read-to-end.js';
  let name = $state(''), organisation = $state(''), email = $state(''), busy = $state(false);
  // read: the text was scrolled to its end; ok: its box is ticked
  let readLicence = $state(false), readTerms = $state(false), okLicence = $state(false), okTerms = $state(false);
  let reading = $state(null);   // 'license' | 'terms': the text open in the pop-up
  let agreed = $state(false);   // a new profile: the licence and the terms were accepted, so the profile form shows
  const mode = $derived(app.signin.mode), who = $derived(app.signin.who), terms = $derived(app.terms);
  const legalReady = $derived(!!terms.version && (mode === 'terms' || !!app.license));
  const accept = $derived(okTerms && (mode === 'terms' || okLicence));
  const ready = $derived(accept && !busy && (mode !== 'new' || name.trim() !== ''));
  const focus = (el) => { el.focus(); };
  // Each page starts unticked: an acceptance never carries over from another profile or page
  $effect(() => { void app.signin; readLicence = readTerms = okLicence = okTerms = agreed = false; reading = null; });
  const isRead = (doc) => (doc === 'license' ? readLicence : readTerms);
  const markRead = (doc) => () => { if (doc === 'license') readLicence = true; else readTerms = true; };

  async function go() {
    busy = true;
    try {
      if (mode === 'terms') await acceptTerms(who);
      else await createProfile({ name: name.trim(), organisation: organisation.trim(), email: email.trim() });
    } catch (e) { toast(e.message, true); }
    busy = false;
  }
  const open = (doc) => (e) => { e.preventDefault(); reading = doc; };
  const projectsText = (u) => `${u.projects} project${u.projects === 1 ? '' : 's'}`;
</script>

{#snippet missing()}
  <p class="si-error">{terms.version ? 'The licence (LICENSE)' : 'The terms of use (TERMS.md)'} is missing next to the web folder,
    so no profile can be created or opened. Reinstall Soloptima.</p>
{/snippet}

{#snippet termsDoc()}
  <label class="check accept" class:locked={!readTerms}><input type="checkbox" bind:checked={okTerms} disabled={!readTerms}
    aria-describedby="read-terms"><span>I have read and accept the <a href="#terms" onclick={open('terms')}>terms of use</a>
    (version {terms.version}).</span></label>
  <p class="hint si-read" id="read-terms">{readTerms ? 'Read to the end.' : 'Open the terms of use and read them to the end to tick this box.'}</p>
{/snippet}

{#snippet termsBlock()}
  {#if terms.version}
    {@render termsDoc()}
  {:else}
    {@render missing()}
  {/if}
{/snippet}

<div class="signin">
  <main class="si-main">
    <section class="si-intro"><h1>Welcome to Soloptima</h1>
      <p class="lead">Soloptima sizes PV and battery capacity for a site with diesel generators and simulates the plant's hourly operation and finances.</p>
      <p class="hint">Projects and reports are kept on this computer; no online account is needed.</p></section>
    <section class="si-panel card">
      {#if mode === 'choose'}
        <h2>Choose your profile</h2><p class="hint">Profiles keep each person's projects apart on this computer.</p>
        <div class="si-users">
          {#each app.users as u (u.id)}
            <button class="si-user" onclick={() => chooseProfile(u)}><Avatar user={u} />
              <span><b>{u.name}</b><small>{u.organisation || ''}{u.organisation ? ' · ' : ''}{projectsText(u)}{accepted(u) || !terms.version ? '' : ' · must accept the terms'}</small></span></button>
          {/each}
        </div>
        <button class="btn" onclick={() => toSignIn('new')}>Create a new profile</button>
      {:else if mode === 'terms'}
        <h2>Welcome back, {who ? firstName(who.name) : ''}</h2>
        {#if terms.version}
          <p class="hint">{#if who && who.terms_version}You accepted version {who.terms_version} on {String(who.terms_accepted || '').slice(0, 10)}; the terms have changed since.{:else}Accept the terms of use to continue.{/if}</p>
        {/if}
        {@render termsBlock()}
        <div class="row gap"><button class="btn" onclick={() => toSignIn('choose')}>Back</button>
          {#if terms.version}<button class="btn primary" disabled={!ready} onclick={go}>Accept and continue</button>{/if}</div>
      {:else if !agreed}
        <p class="si-steps">Step 1 of 2</p>
        <h2>Licence agreement</h2>
        <p class="hint">Please read the licence and the terms of use. Soloptima is free, open source software and works on this computer without an internet connection.</p>
        {#if legalReady}
          <label class="check accept" class:locked={!readLicence}><input type="checkbox" bind:checked={okLicence} disabled={!readLicence}
            aria-describedby="read-licence"><span>I have read and accept the <a href="#license" onclick={open('license')}>licence</a>
            (Apache License 2.0).</span></label>
          <p class="hint si-read" id="read-licence">{readLicence ? 'Read to the end.' : 'Open the licence and read it to the end to tick this box.'}</p>
          {@render termsDoc()}
        {:else}
          {@render missing()}
        {/if}
        <div class="row gap">{#if app.users.length}<button class="btn" onclick={() => toSignIn('choose')}>Back</button>{/if}
          {#if legalReady}<button class="btn primary" disabled={!accept} onclick={() => { agreed = true; }}>Accept and continue</button>{/if}</div>
      {:else}
        <p class="si-steps">Step 2 of 2</p>
        <h2>Create your profile</h2><p class="hint">Stored only on this computer. No account or internet connection is needed.</p>
        <div class="grid-2 si-fields"><label>Name<input bind:value={name} maxlength="60" autocomplete="name" use:focus></label>
          <label><span>Organisation <small>optional</small></span><input bind:value={organisation} maxlength="120" autocomplete="organization"></label></div>
        <label class="si-fields"><span>Email <small>optional, added to the bug reports you write</small></span><input bind:value={email} type="email" maxlength="120" autocomplete="email"></label>
        <p class="si-done">You accepted the licence (Apache License 2.0) and the terms of use (version {terms.version}).</p>
        <div class="row gap"><button class="btn" onclick={() => { agreed = false; }}>Back</button>
          <button class="btn primary" disabled={!ready} onclick={go}>Create profile and continue</button></div>
      {/if}
    </section>
  </main>
  <Footer />
</div>

<Dialog open={reading != null} onclose={() => (reading = null)} wide noclose
  title={reading === 'license' ? 'Licence: Apache License, Version 2.0' : `Terms of use, version ${terms.version}`}>
  {#if reading}
    {#key reading}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrolled text must take the focus, so keyboard users can read it to the end) -->
      <div class="terms-box popup" class:licence={reading === 'license'} tabindex="0" role="region"
        aria-label={reading === 'license' ? 'Licence' : 'Terms of use'} use:readToEnd={markRead(reading)}>
        {#if reading === 'license'}<pre>{app.license}</pre>{:else}<Markdown text={terms.md} />{/if}</div>
    {/key}
    <div class="dlg-foot"><span class="hint si-pop">{isRead(reading) ? 'Read to the end: you can now tick the box.' : 'Scroll to the end to read it all.'}</span>
      <button type="button" class="btn primary" onclick={() => (reading = null)}>{isRead(reading) ? 'Done' : 'Close'}</button></div>
  {/if}
</Dialog>

