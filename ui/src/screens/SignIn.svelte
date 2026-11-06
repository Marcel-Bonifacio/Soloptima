<!-- Sign-in: choose a profile, create one, or accept changed terms of use. No password: projects are plain files in the
     data folder, so a password would protect nothing. -->
<script>
  import { toast } from '../lib/toast.js';
  import { app, accepted, openDialog } from '../lib/state.svelte.js';
  import { chooseProfile, createProfile, acceptTerms, toSignIn } from '../lib/session.svelte.js';
  import { firstName } from '../lib/profile.js';
  import Avatar from '../lib/Avatar.svelte';
  import Markdown from '../lib/Markdown.svelte';
  import Footer from './Footer.svelte';

  let name = $state(''), organisation = $state(''), email = $state(''), accept = $state(false), busy = $state(false);
  const mode = $derived(app.signin.mode), who = $derived(app.signin.who), terms = $derived(app.terms);
  const ready = $derived(accept && !busy && (mode !== 'new' || name.trim() !== ''));
  const focus = (el) => { el.focus(); };

  async function go() {
    busy = true;
    try {
      if (mode === 'terms') await acceptTerms(who);
      else await createProfile({ name: name.trim(), organisation: organisation.trim(), email: email.trim() });
    } catch (e) { toast(e.message, true); }
    busy = false;
  }
  const projectsText = (u) => `${u.projects} project${u.projects === 1 ? '' : 's'}`;
</script>

{#snippet termsBlock()}
  {#if terms.version}
    <Markdown class="terms-box md" text={terms.md} tabindex="0" aria-label="Terms of use" />
    <label class="check accept"><input type="checkbox" bind:checked={accept}><span>I have read and accept the
      <a href="#terms" onclick={(e) => { e.preventDefault(); openDialog('legal', 'terms'); }}>terms of use</a> (version {terms.version}).</span></label>
  {:else}
    <p class="si-error">The terms of use (TERMS.md) are missing next to the web folder, so no profile can be created or opened. Reinstall Soloptima.</p>
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
      {:else}
        <h2>Create your profile</h2><p class="hint">Stored only on this computer. No account or internet connection is needed.</p>
        <div class="grid-2 si-fields"><label>Name<input bind:value={name} maxlength="60" autocomplete="name" use:focus></label>
          <label><span>Organisation <small>optional</small></span><input bind:value={organisation} maxlength="120" autocomplete="organization"></label></div>
        <label class="si-fields"><span>Email <small>optional, added to the bug reports you write</small></span><input bind:value={email} type="email" maxlength="120" autocomplete="email"></label>
        {@render termsBlock()}
        <div class="row gap">{#if app.users.length}<button class="btn" onclick={() => toSignIn('choose')}>Back</button>{/if}
          {#if terms.version}<button class="btn primary" disabled={!ready} onclick={go}>Create profile and continue</button>{/if}</div>
      {/if}
    </section>
  </main>
  <Footer />
</div>
