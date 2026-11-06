<!-- Terms, licence and third-party notices (Markdown; the licence is plain text) -->
<script>
  import { app } from '../lib/state.svelte.js';
  import { call } from '../lib/ipc.js';
  import Dialog from '../lib/Dialog.svelte';
  import Markdown from '../lib/Markdown.svelte';

  const TITLES = { terms: 'Terms of use', license: 'Licence', notices: 'Third-party notices' };
  let text = $state(null), error = $state('');
  $effect(() => {
    const doc = app.legalDoc;
    text = null; error = '';
    call('legal', { doc }).then((t) => { if (app.legalDoc === doc) text = t; })
      .catch((e) => { error = e.message || 'Cannot reach the Soloptima engine.'; });
  });
  const close = () => { app.dialog = null; };
</script>

<Dialog open={text != null || !!error} onclose={close} title={TITLES[app.legalDoc]}>
  {#if error}<p class="si-error">{error}</p>
  {:else if app.legalDoc === 'license'}<div class="md legal"><pre>{text}</pre></div>
  {:else}<Markdown class="md legal" {text} />{/if}
</Dialog>
