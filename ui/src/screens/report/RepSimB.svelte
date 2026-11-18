<!-- Energy simulation, second half: operational adequacy, monthly balance, dispatch, battery health -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import UserFigs from './UserFigs.svelte';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { fleetUnits, groupTable } from '../../lib/fleet-view.js';
  import { gensetMonthly, GEN_MONTH_HEADS, genMonthCells, socHistogram, SOC_BANDS, DIESEL_KWH_PER_L } from '../../lib/sim-tables.js';
  import { SEASONS } from '../../lib/series.js';
  import { RESIL_HEADS, resilRows, resilCells, resilNotes, stripPick } from '../../lib/resilience-view.js';
  let { D } = $props();
  const { P, SIM, RESIL, h, IMG } = D;
  const R = SIM.result, B = SIM.baseline, y = R.years[0], b = B.years[0], n = fleetUnits(P.diesel), wnd = y.wind_avail > 0, grd = !!R.has_grid;
  const GT = groupTable(SIM, P.diesel);
  const wy = R.years.reduce((a, x) => (x.unmet / x.load > a.unmet / a.load ? x : a), y);
  const MB = h.monthBalance(R), dM = (v) => fmtNum(v / 1000, MB[12].load >= 1e7 ? 0 : 1);
  const low = h.weekPicks(R).re;
  const big = R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6, bh = big ? h.bessHealth(R) : null;
  const yrs = (a) => (a.length > 1 ? 'years ' : 'year ') + h.yearList(a);
  const GM = gensetMonthly(R, P.diesel), SH = socHistogram(R);
</script>

<h3>Operational adequacy</h3>
<Tbl head={['Year 1', 'Diesel only', 'Hybrid']} rows={[
  ['Loss-of-load hours', fmtNum(b.lol_h), fmtNum(y.lol_h)], ['Loss-of-load events (longest, h)', `${fmtNum(b.lol_events)} (${fmtNum(b.lol_max_h)})`, `${fmtNum(y.lol_events)} (${fmtNum(y.lol_max_h)})`],
  ['Unmet energy (MWh/yr)', fmtNum(b.unmet / 1000, 1), fmtNum(y.unmet / 1000, 1)],
  ...(y.unmet_crit != null ? [['Unserved critical load (MWh/yr; hours)', `${fmtNum(b.unmet_crit / 1000, 1)}; ${fmtNum(b.lol_crit_h)}`, `${fmtNum(y.unmet_crit / 1000, 1)}; ${fmtNum(y.lol_crit_h)}`],
    ['Unserved non-critical load (MWh/yr; hours)', `${fmtNum(b.unmet_nc / 1000, 1)}; ${fmtNum(b.lol_nc_h)}`, `${fmtNum(y.unmet_nc / 1000, 1)}; ${fmtNum(y.lol_nc_h)}`]] : []),
  ...(y.dl_kwh != null ? [['Deferrable load (MWh/yr; from PV and wind)', `${fmtNum(b.dl_kwh / 1000, 1)}; ${fmtPct(b.dl_kwh > 0 ? b.dl_re / b.dl_kwh : 0)}`, `${fmtNum(y.dl_kwh / 1000, 1)}; ${fmtPct(y.dl_kwh > 0 ? y.dl_re / y.dl_kwh : 0)}`],
    ['Unserved deferrable energy (MWh/yr)', fmtNum(b.dl_unmet / 1000, 1), fmtNum(y.dl_unmet / 1000, 1)]] : []),
  ['Spinning reserve shortfall (h/yr)', fmtNum(b.reserve_short_h), fmtNum(y.reserve_short_h)], ['Largest reserve shortfall (kW)', fmtNum(b.reserve_short_max_kw), fmtNum(y.reserve_short_max_kw)],
  ['Most gensets online', `${fmtNum(b.max_units)} of ${n}`, `${fmtNum(y.max_units)} of ${n}`], ['Hours with the whole fleet online', fmtNum(b.fleet_full_h), fmtNum(y.fleet_full_h)],
  ['Hours at minimum loading (longest run, h)', `${fmtNum(b.minload_h)} (${fmtNum(b.minload_run_max_h)})`, `${fmtNum(y.minload_h)} (${fmtNum(y.minload_run_max_h)})`],
  ['Most gensets started in one hour', fmtNum(b.max_starts_h), fmtNum(y.max_starts_h)],
  ...(y.n1_short_h != null ? [['N-1 shortfall: largest unit lost (h/yr)', fmtNum(b.n1_short_h), fmtNum(y.n1_short_h)], ['Largest N-1 gap (kW)', fmtNum(b.n1_short_max_kw), fmtNum(y.n1_short_max_kw)]] : []),
  ...(y.unit_outages != null ? [['Forced genset outages (unit-hours out)', `${fmtNum(b.unit_outages)} (${fmtNum(b.unit_outage_h)})`, `${fmtNum(y.unit_outages)} (${fmtNum(y.unit_outage_h)})`]] : []),
  ...(y.inverter_outages != null ? [['Inverter block outages (block-hours out, MWh of PV lost)', 'none', `${fmtNum(y.inverter_outages)} (${fmtNum(y.inverter_outage_h)}, ${fmtNum(y.inverter_outage_kwh / 1000)})`]] : []),
  ...(y.pcs_outages != null ? [['Battery PCS outages (unit-hours out)', 'none', `${fmtNum(y.pcs_outages)} (${fmtNum(y.pcs_outage_h)})`]] : []),
  ...(y.min_down_override != null ? [['Units started within the minimum down time, for the load', fmtNum(b.min_down_override), fmtNum(y.min_down_override)]] : []),
  ...(y.ramp_limited_h != null ? [['Hours held back by ramp or start time', fmtNum(b.ramp_limited_h), fmtNum(y.ramp_limited_h)]] : []),
  ...(y.re_ramp_viol != null ? [['PV and wind falls beyond the ramp limit (steps, MWh)', '–', `${fmtNum(y.re_ramp_viol)} (${fmtNum(y.re_ramp_viol_kwh / 1000, 1)})`],
    ['Battery charged and discharged for the ramp limit (MWh/yr)', '–', fmtNum((y.re_ramp_bess_ch + y.re_ramp_bess_dis) / 1000, 1)],
    ['PV and wind curtailed by the ramp limit (MWh/yr)', '–', fmtNum(y.re_ramp_curtailed / 1000, 1)]] : [])]} />
{#if R.step_min}<p>The dispatch runs in {R.step_min} minute steps; hours above are summed over the steps, and the tables and figures show hourly means.</p>{/if}
{#if y.re_ramp_viol != null}<p>PV and wind may change by at most {fmtNum(P.sim.re_ramp_pct_min, 2)} % of their rating per minute. The battery takes rises above that, and what it cannot take is curtailed; a fall it cannot make up counts as a violation.{SIM.re_ramp_ref ? ` Without the limit ${fmtNum(SIM.re_ramp_ref.curtailed / 1000, 1)} MWh would be curtailed and the battery would move ${fmtNum((SIM.re_ramp_ref.bess_ch + SIM.re_ramp_ref.bess_dis) / 1000, 1)} MWh in year 1, against ${fmtNum((y.pv_curtailed + y.wind_curtailed) / 1000, 1)} and ${fmtNum((y.bess_ch + y.bess_dis) / 1000, 1)} MWh with it.` : ''} The PV and wind data are hourly, filled into the steps, so they hold no cloud ramps: these figures are a lower bound on the battery work a ramp limit needs.</p>{/if}
{#if R.summary && R.summary.reliability && R.summary.reliability.low_pv_run_d != null}
  {@const Q = R.summary.reliability}
  <p>In the simulated weather year the longest run of low-PV days (PV yield below {fmtPct(Q.low_pv_frac, 0)} of the mean daily yield) is {fmtNum(Q.low_pv_run_d)} days{Q.low_pv_run_d ? `, from ${h.dateOfHour(Q.low_pv_run_start * 24)}` : ''}; {fmtNum(Q.low_pv_days)} days of the year are low. The longest run of hours with unserved load in year 1 is {fmtNum(Q.unmet_run_h)} h{Q.unmet_run_h ? `, from ${h.dateOfHour(Q.unmet_run_start)}` : ''}.</p>
{/if}
<p>Loss of load counts hours with more than 0.1 % of the load unserved; an event is a run of such hours. Reserve shortfall counts hours in which the genset headroom and battery reserve left after dispatch do not cover the spinning-reserve rule; it normally arises only when no more of the {n} gensets can be started. Low loading counts hours with every online genset at minimum loading.{wy.year !== y.year ? ` The highest unmet share is ${fmtPct(wy.unmet / wy.load, 3)} in year ${wy.year} (${fmtNum(wy.lol_h)} loss-of-load hours).` : ''}</p>
<Fig src={IMG.chMonthly} cap="Monthly energy supply (year 1)." />
<h3>Monthly energy balance (year 1)</h3>
<Tbl head={['Month', 'Load MWh', 'PV direct', ...(wnd ? ['Wind direct'] : []), 'Battery → load', 'Diesel → load', ...(grd ? ['Grid → load'] : []), 'Unmet', 'RE curtailed', ...(grd ? ['Exported'] : []), 'Genset dump', 'Fuel kL', 'RE fraction']}
  rows={MB.map((x) => [x.label, dM(x.load), dM(x.pv), ...(wnd ? [dM(x.wind)] : []), dM(x.bess), dM(x.gen), ...(grd ? [dM(x.grid)] : []), dM(x.unmet), dM(x.curt), ...(grd ? [dM(x.export)] : []), dM(x.dump), fmtNum(x.fuel / 1000), fmtPct(x.re)])} />
<p>Load (auxiliaries included) = PV direct{wnd ? ' + wind direct' : ''} + battery → load + diesel → load{grd ? ' + grid → load' : ''} + unmet. RE fraction = 1 − diesel energy to the load and the battery{grd ? ' and the grid import' : ''} ÷ energy served.</p>
{#if GT}
  <h3>Genset groups (year 1)</h3>
  <Tbl head={GT.heads} rows={GT.rows} />
  <p>Units start in merit order (the group with the cheapest energy first) and the online units share the load at one loading, so a later group runs only when every unit before it is online.</p>
{/if}
{#if GM}
  <h3>Gensets by month (year 1)</h3>
  <Tbl head={GEN_MONTH_HEADS} rows={GM.map(genMonthCells)} />
  <p>Run hours are those of all units and starts count every unit started. Capacity factor = genset energy ÷ (fleet rating × hours); efficiency = genset energy ÷ (fuel × {DIESEL_KWH_PER_L} kWh/L).</p>
{/if}
<Fig src={IMG.chDispatch} cap="Hourly dispatch, sample week." />
{#if low != null}<Fig src={IMG.chDispatchRep} cap={`Hourly dispatch, week with the lowest renewable share (${h.dateOfHour(low)} to ${h.dateOfHour(low + 167)}).`} />{/if}
<Fig src={IMG.chGenLoad} cap="Genset loading distribution." />
<Fig src={IMG.chUnitsDur} cap="Units online duration curve, hybrid and diesel only (year 1)." />
{#if bh}
  <h3>Battery health</h3>
  <p>State of health starts at {fmtPct(P.bess.soh_init, 0)} and ends the project at {fmtPct(bh.soh_end)}. The battery is replaced at {fmtPct(bh.thr, 0)} state of health{bh.repl.length ? `, in ${yrs(bh.repl)}` : '; no replacement falls within the project life'}.
    It runs up to {fmtNum(bh.max_efc)} equivalent full cycles per year (AC discharge ÷ nameplate; {fmtNum(bh.max_efc_dc)} at the cells) at up to {fmtNum(bh.max_c, 2)} C.
    {#if y.rf_cycles != null}Counted by rainflow, year 1 has {fmtNum(y.rf_cycles)} cycles of {fmtPct(y.rf_dod, 0)} mean depth, which use {fmtPct(y.bess_damage, 2)} of the cycle life.{/if}
    At year-1 use a new battery lasts {bh.life == null ? 'indefinitely (no fade)' : fmtNum(bh.life, 1) + ' years'}{bh.life == null ? '' : `, limited mainly by ${bh.cyc_share > 0.5 ? 'cycling' : 'calendar fade'}`}.{bh.cap > 0 && !bh.over.length ? ` The warranty cap of ${fmtNum(bh.cap)} cycles per year is respected in every year.` : ''}</p>
  {#if bh.over.length}<div class="warn">The warranty cap of {fmtNum(bh.cap)} cycles per year is exceeded in {yrs(bh.over)} (up to {fmtNum(bh.max_efc)} cycles).</div>{/if}
  {#if SH}
    <Tbl head={['State of charge', ...SEASONS, 'Year']} rows={SOC_BANDS.map((b, i) => [b, ...SH.seasons.map((x) => fmtNum(x[i])), fmtNum(SH.year[i])])} />
    <p>Hours of year 1 in each band of state of charge at the end of the hour, by season, against the battery's capacity that year.</p>
  {/if}
  <Fig src={IMG.chSoh} cap="Battery state of health with the replacement threshold and replacements." />
  <Fig src={IMG.chSohLoss} cap="Battery capacity lost each year to calendar and cycle fade." />
{/if}
{#if RESIL}
  {@const X = RESIL.res}
  <h3>Outage survival</h3>
  {#if h.resilStale()}<div class="warn">The inputs changed after this study was run. Run it again on the Simulation results page for current figures.</div>{/if}
  <p>{resilNotes(X).join(' ')}</p>
  <Fig src={IMG.chResil} cap="Chance that the critical load is served in full through an outage, against its length: minimum, 5th percentile and mean over the start hours." />
  <Tbl head={RESIL_HEADS} rows={resilRows(X).map(resilCells)} />
  <Fig src={IMG.chResilStrip} cap={`Chance of serving the critical load through a ${stripPick(X, P.resilience.strip_h)} h outage, by the hour it starts.`} />
{/if}
<UserFigs {D} place="simulation" />
