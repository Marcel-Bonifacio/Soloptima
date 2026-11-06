<!-- A form of FORMS (lib/schema) (`name`), bound to the open project. Mounted by main.js into
     <div class="form" data-ui-form="name">; later sessions use it inside their own screens. -->
<script>
  import Field from './Field.svelte';
  import { forms } from './state.svelte.js';
  import { legacy } from './legacy.js';
  import { FORMS } from './schema/index.js';
  import { setPath } from './path.js';

  let { name } = $props();
  const fields = $derived(FORMS[name] || []);
  const project = $derived.by(() => { forms.rev; return legacy.project(); });

  function onchange(key, v) {
    setPath(project, key, v);
    legacy.onFieldChange(key);   // other forms showing the key, visibility, autosave and recalculation (web/js/app.js)
  }
</script>

{#if project}
  {#each fields as f (f.k)}
    <Field {f} form={name} {project} rev={forms.rev} {onchange} />
  {/each}
{/if}
