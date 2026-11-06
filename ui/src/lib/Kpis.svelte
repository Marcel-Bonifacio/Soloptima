<!-- KPI tiles. items: [label, value, subtitle, hero (true, or 'bad' for a value in red), change since the last run] -->
<script>
  let { items } = $props();

  // the number large; a leading currency code and the unit after the last digit small, on one line
  function split(v) {
    const t = String(v == null ? '' : v), last = t.search(/\d[^\d]*$/);
    if (last < 0) return { cur: '', num: t, unit: '' };
    const cur = (t.match(/^[A-Z]{3}\s/) || [''])[0];
    return { cur: cur.trim(), num: t.slice(cur.length, last + 1), unit: t.slice(last + 1) };
  }
</script>

<div class="kpis">
  {#each items as [label, value, sub, hero, change]}
    {@const v = split(value)}
    <div class="kpi" class:bad={hero === 'bad'} class:hero={hero && hero !== 'bad'}>
      <div class="l">{label}</div>
      <div class="v" title={String(value ?? '')}>{#if v.cur}<span class="u">{v.cur}</span>{' '}{/if}{v.num}{#if v.unit}<span class="u">{v.unit}</span>{/if}</div>
      <div class="s">{sub || ''}</div>
      {#if change}<div class="d" class:up={change.startsWith('▲')} class:down={change.startsWith('▼')}>{change}</div>{/if}
    </div>
  {/each}
</div>
