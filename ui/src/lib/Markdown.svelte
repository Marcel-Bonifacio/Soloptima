<!-- A Markdown text (markdown.js) rendered without HTML strings. `class` goes on the wrapper (md, legal, up-notes ...). -->
<script>
  import { parse } from './markdown.js';
  import Inline from './Inline.svelte';
  let { text, class: cls = 'md', ...rest } = $props();
  let box;
  const blocks = $derived(parse(text));
  // in-page jumps (a #hash would trigger the app's router)
  const jump = (id) => { const t = box.querySelector('#md-' + CSS.escape(id)); if (t) t.scrollIntoView({ behavior: 'smooth' }); };
</script>

<div class={cls} bind:this={box} {...rest}>
  {#each blocks as b, i (i)}
    {#if b.t === 'p'}<p><Inline tokens={b.inl} {jump} /></p>
    {:else if b.t === 'h'}<svelte:element this={'h' + b.level} id={b.id}><Inline tokens={b.inl} {jump} /></svelte:element>
    {:else if b.t === 'code'}<pre><code>{b.text}</code></pre>
    {:else if b.t === 'quote'}<blockquote><Inline tokens={b.inl} {jump} /></blockquote>
    {:else if b.t === 'table'}
      <table class="data">
        <thead><tr>{#each b.head as c, j (j)}<th><Inline tokens={c} {jump} /></th>{/each}</tr></thead>
        <tbody>{#each b.rows as r, j (j)}<tr>{#each r as c, n (n)}<td><Inline tokens={c} {jump} /></td>{/each}</tr>{/each}</tbody>
      </table>
    {:else if b.t === 'list'}
      <svelte:element this={b.ordered ? 'ol' : 'ul'}>
        {#each b.items as it, j (j)}<li>{#each it as line, n (n)}{#if n}<br>{/if}<Inline tokens={line} {jump} />{/each}</li>{/each}
      </svelte:element>
    {/if}
  {/each}
</div>
