<!-- The daily shape (24 values) and the monthly scaling of the synthetic load. Every value is a number field under its label; an edit
     makes the profile synthetic again and generates it. Twenty-four numbers pasted into a field fill the hours from there on. -->
<script>
  import { forms } from '../../lib/state.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { MONTHS } from '../../lib/series.js';
  import { dat, setDaily, pasteDaily, setMonthly } from '../../lib/data.svelte.js';

  // the values come from the project; they are read again after every change of it
  const L = $derived.by(() => { forms.rev; dat.rev; return W.P ? { daily: W.P.load.daily.slice(), monthly: W.P.load.monthly.slice() } : { daily: [], monthly: [] }; });

  const shown = (v) => +(+v).toFixed(2);
  function daily(e, h) { e.currentTarget.value = String(shown(setDaily(h, e.currentTarget.value))); }
  function paste(e, h) {
    if (pasteDaily(h, e.clipboardData.getData('text'))) e.preventDefault();
  }
  function monthly(e, m) { e.currentTarget.value = String(setMonthly(m, e.currentTarget.value)); }
</script>

<h3>Daily shape (kW, local time) <span class="hint inline">edit values or paste 24 numbers</span></h3>
<div id="dailyEditor" class="daily-editor">
  {#each L.daily as v, h (h)}
    <div><span>{String(h).padStart(2, '0')}:00</span><input type="number" step="any" value={shown(v)} data-h={h} onchange={(e) => daily(e, h)} onpaste={(e) => paste(e, h)}></div>
  {/each}
</div>
<h3 class="mt">Monthly scaling</h3>
<div id="monthlyEditor" class="daily-editor months">
  {#each L.monthly as v, m (m)}
    <div><span>{MONTHS[m]}</span><input type="number" step="0.01" value={+v} data-m={m} onchange={(e) => monthly(e, m)}></div>
  {/each}
</div>
