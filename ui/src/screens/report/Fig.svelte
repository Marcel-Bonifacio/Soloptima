<!-- A figure with its caption; the number is added when the report is put together. Nothing is drawn without a picture. -->
<script>
  let { src, cap, cls = undefined } = $props();
</script>

{#if src}<figure class={cls}><img {src} alt=""><figcaption>{cap}</figcaption></figure>{/if}
