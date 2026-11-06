<!-- The question of lib/ask.js: one at a time; a new question answers the one before with Cancel. Close and Escape are Cancel. -->
<script>
  import { onMount } from 'svelte';
  import Dialog from '../lib/Dialog.svelte';
  import { setAsker } from '../lib/ask.js';

  let q = $state(null);   // {text, yes, done}
  const answer = (v) => { const cur = q; q = null; if (cur) cur.done(v); };

  onMount(() => {
    setAsker((text, yes) => new Promise((done) => { answer(false); q = { text, yes, done }; }));
    return () => { setAsker(null); answer(false); };
  });
</script>

<Dialog open={!!q} onclose={() => answer(false)} title="Please confirm" label="Please confirm">
  {#if q}
    <p>{q.text}</p>
    <div class="row gap">
      <button type="button" class="btn primary" onclick={() => answer(true)}>{q.yes}</button>
      <button type="button" class="btn ghost" onclick={() => answer(false)}>Cancel</button>
    </div>
  {/if}
</Dialog>
