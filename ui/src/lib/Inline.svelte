<!-- Inline Markdown tokens (markdown.js). Text is always auto-escaped; links open in the user's browser. -->
<script>
  import { openExternal } from './ipc.js';
  let { tokens, jump } = $props();
</script>

{#each tokens as k, i (i)}
  {#if k.t === 'code'}<code>{k.text}</code>
  {:else if k.t === 'bi'}<b><i>{k.text}</i></b>
  {:else if k.t === 'b'}<b>{k.text}</b>
  {:else if k.t === 'link'}<a href={k.href} onclick={(e) => { e.preventDefault(); openExternal(k.href); }}>{k.text}</a>
  {:else if k.t === 'jump'}<a href="#md-{k.href}" onclick={(e) => { e.preventDefault(); jump(k.href); }}>{k.text}</a>
  {:else}{k.text}{/if}
{/each}
