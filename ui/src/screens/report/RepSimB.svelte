<!-- Energy simulation, second half: operational adequacy, monthly balance, dispatch, battery health -->
<script>
  import Tbl from './Tbl.svelte';
  import Fig from './Fig.svelte';
  import UserFigs from './UserFigs.svelte';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { fleetUnits, groupTable } from '../../lib/fleet-view.js';
  let { D } = $props();
  const { P, SIM, h, IMG } = D;
  const R = SIM.result, B = SIM.baseline, y = R.years[0], b = B.years[0], n = fleetUnits(P.diesel), wnd = y.wind_avail > 0, grd = !!R.has_grid;
  const GT = groupTable(SIM, P.diesel);
  const wy = R.years.reduce((a, x) => (x.unmet / x.load > a.unmet / a.load ? x : a), y);
  const MB = h.monthBalance(R), dM = (v) => fmtNum(v / 1000, MB[12].load >= 1e7 ? 0 : 1);
  const low = h.weekPicks(R).re;
  const big = R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6, bh = big ? h.bessHealth(R) : null;
  const yrs = (a) => (a.length > 1 ? 'years ' : 'year ') + h.yearList(a);
</script>

<h3>Operational adequacy</h3>
<Tbl head={['Year 1', 'Diesel only', 'Hybrid']} rows={[
  ['Loss-of-load hours', fmtNum(b.lol_h), fmtNum(y.lol_h)], ['Loss-of-load events (longest, h)', `${fmtNum(b.lol_events)} (${fmtNum(b.lol_max_h)})`, `${fmtNum(y.lol_events)} (${fmtNum(y.lol_max_h)})`],
  ['Unmet energy (MWh/yr)', fmtNum(b.unmet / 1000, 1), fmtNum(y.unmet / 1000, 1)],
  ['Spinning reserve shortfall (h/yr)', fmtNum(b.reserve_short_h), fmtNum(y.reserve_short_h)], ['Largest reserve shortfall (kW)', fmtNum(b.reserve_short_max_kw), fmtNum(y.reserve_short_max_kw)],
  ['Most gensets online', `${fmtNum(b.max_units)} of ${n}`, `${fmtNum(y.max_units)} of ${n}`], ['Hours with the whole fleet online', fmtNum(b.fleet_full_h), fmtNum(y.fleet_full_h)],
  ['Hours at minimum loading (longest run, h)', `${fmtNum(b.minload_h)} (${fmtNum(b.minload_run_max_h)})`, `${fmtNum(y.minload_h)} (${fmtNum(y.minload_run_max_h)})`],
  ['Most gensets started in one hour', fmtNum(b.max_starts_h), fmtNum(y.max_starts_h)]]} />
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
<Fig src={IMG.chDispatch} cap="Hourly dispatch, sample week." />
{#if low != null}<Fig src={IMG.chDispatchRep} cap={`Hourly dispatch, week with the lowest renewable share (${h.dateOfHour(low)} to ${h.dateOfHour(low + 167)}).`} />{/if}
<Fig src={IMG.chGenLoad} cap="Genset loading distribution." />
<Fig src={IMG.chUnitsDur} cap="Units online duration curve, hybrid and diesel only (year 1)." />
{#if bh}
  <h3>Battery health</h3>
  <p>State of health starts at {fmtPct(P.bess.soh_init, 0)} and ends the project at {fmtPct(bh.soh_end)}. The battery is replaced at {fmtPct(bh.thr, 0)} state of health{bh.repl.length ? `, in ${yrs(bh.repl)}` : '; no replacement falls within the project life'}.
    It runs up to {fmtNum(bh.max_efc)} equivalent full cycles per year (AC discharge ÷ nameplate; {fmtNum(bh.max_efc_dc)} at the cells) at up to {fmtNum(bh.max_c, 2)} C.
    At year-1 use a new battery lasts {bh.life == null ? 'indefinitely (no fade)' : fmtNum(bh.life, 1) + ' years'}{bh.life == null ? '' : `, limited mainly by ${bh.cyc_share > 0.5 ? 'cycling' : 'calendar fade'}`}.{bh.cap > 0 && !bh.over.length ? ` The warranty cap of ${fmtNum(bh.cap)} cycles per year is respected in every year.` : ''}</p>
  {#if bh.over.length}<div class="warn">The warranty cap of {fmtNum(bh.cap)} cycles per year is exceeded in {yrs(bh.over)} (up to {fmtNum(bh.max_efc)} cycles).</div>{/if}
  <Fig src={IMG.chSoh} cap="Battery state of health with the replacement threshold and replacements." />
  <Fig src={IMG.chSohLoss} cap="Battery capacity lost each year to calendar and cycle fade." />
{/if}
<UserFigs {D} place="simulation" />
