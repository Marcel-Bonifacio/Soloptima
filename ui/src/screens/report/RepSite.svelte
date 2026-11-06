<!-- Site and solar resource: layout, weather, inter-annual variability and P50/P90 -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import Quality from './Quality.svelte';
  import RepLayout from './RepLayout.svelte';
  import UserFigs from './UserFigs.svelte';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { tableRows, HEADS } from '../../lib/ry-view.js';
  let { D } = $props();
  const { P, ry: S, cur, IMG } = D;
  const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const H = D.h.HOURS;
</script>

<h2>Site and solar resource</h2>
<RepLayout {D} />
{#if P.weather}
  <p>Hourly meteorological data: <b>{P.weather.source}</b>. {P.weather.note || ''} Annual global horizontal irradiation {fmtNum(sum(P.weather.ghi) / 1000)} kWh/m², mean temperature {fmtNum(sum(P.weather.tamb) / H, 1)} °C.</p>
  <Fig src={IMG.chWxMonthly} cap="Monthly global horizontal irradiation." />
  <Quality {D} kind="weather" />
{/if}
{#if S}
  {@const X = S.X}{@const b = X.budget || {}}{@const st = X.stats}
  <h3>Inter-annual variability and P50/P90</h3>
  {#if S.stale}<div class="warn">The inputs changed after this run. Run it again on the Solar resource page for current figures.</div>{/if}
  <p>Year 1 of the plant was simulated with each of the {X.years.length} historical weather years of {X.database} {String(X.range.from)}–{String(X.range.to)}, with the sizes and settings unchanged.
    The spread across these years is used only as ratios{#if S.devNote}. {S.devNote}{:else}: P50 is the result with the project's weather, {X.weather || '–'}.{/if}
    The one-year uncertainty of each result combines its year-to-year spread with the systematic uncertainty of irradiance, {fmtPct(X.sigma_sys)} (dataset {fmtPct(b.dataset)}, transposition and PV model {fmtPct(b.model)}, soiling and availability {fmtPct(b.soiling)}, root-sum-square), scaled by the result's elasticity to irradiance; the 10-year values assume independent years.{P.wind && P.wind.units > 0 ? ' With wind turbines, each weather year also brings its own wind speeds, but the systematic uncertainty and the elasticity cover irradiance only, so the P90 leaves out the uncertainty of the long-term wind resource.' : ''}
    A 1 % change in irradiance changes the specific yield by {fmtNum(st.yield.elasticity, 2)} % and the fuel saved by {fmtNum(st.fuel_saved.elasticity, 2)} %.
    {#if S.f1 != null}Revenue P90 ÷ P50 is {fmtNum(S.f1, 3)} for one year and {fmtNum(S.f10, 3)} for a 10-year average{#if S.applied}; debt sizing in Project finance uses {String(S.applied.p90_factor)} ({S.applied.basis === 10 ? '10-year average' : 'one year'}){/if}.{/if}</p>
  {#if S.devWarn}<div class="warn">{S.devWarn}</div>{/if}
  <Fig src={IMG.chRy} cap="Specific yield and fuel saved in each weather year as a percentage of their multi-year mean, with P50 (the project weather) and the one-year P90 on the same basis; the worst year of each is outlined." />
  <Tbl head={HEADS} rows={tableRows(S, cur)} />
  {#if X.note}<p>{X.note}</p>{/if}
{/if}
<UserFigs {D} place="site" />
