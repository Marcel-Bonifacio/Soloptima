<!-- The figures of the layout under its parameters: capacity, tables, net area and power density, the buttons that take the
     capacity over, the orientations, tables left out or taken out, and the shade of buildings and trees on the tables. -->
<script>
  import Kpis from '../../lib/Kpis.svelte';
  import { lay, P } from '../../lib/layout/map.svelte.js';
  import { E, useCapacity, showShade } from '../../lib/layout/edit.svelte.js';
  import { SHADE_CLASSES } from '../../lib/layout/fill.js';
  import { forms } from '../../lib/state.svelte.js';
  import { fmtNum, fmtPct, fmtPower, plural } from '../../lib/format.js';

  const v = $derived.by(() => {
    lay.rev; forms.rev;
    const p = P();
    if (!p) return null;
    const R = p.layout.result, objs = (p.layout.polygons || []).filter((g) => g.type === 'obstacle'), shade = E.shade;
    const out = { p, R, objs, trees: objs.filter((g) => g.kind === 'tree').length, shade, removed: (p.layout.removed || []).length };
    if (R) {
      const net = (R.site_m2 - R.excl_m2) / 1e4;
      out.kpis = [
        ['Max DC capacity', fmtPower(R.kwp).replace('kW', 'kWp').replace('MW', 'MWp'), `${fmtNum(R.modules)} modules`, true],
        ['Tables', fmtNum(R.n_tables), `${fmtNum(R.along || 0, 1)} × ${fmtNum(R.slant, 2)} m`],
        ['Net area', `${fmtNum(net, 1)} ha`, `${fmtNum(R.excl_m2 / 1e4, 1)} ha excluded`],
        ['Power density', fmtNum(net > 0 ? R.kwp / 1000 / net : 0, 2), `MWp/ha · pitch ${fmtNum(R.pitch, 1)} m`]];
    }
    if (objs.length) {
      let s = '';
      if (p.pv.near_shading === false) s = ' (switched off on the PV page)';
      else if (!(p.weather && p.weather.ghi)) s = ' (shade map once the solar data are fetched, tab 2)';
      else if (shade && shade.tables.length && R && shade.tables.length === (R.tables || []).length)
        s = `: beam lost ${fmtPct(shade.tables.reduce((a, x) => a + x, 0) / shade.tables.length)} on average, ${fmtPct(Math.max(...shade.tables))} on the worst table`;
      out.objText = `${plural(objs.length - out.trees, 'building')} and ${plural(out.trees, 'tree')} shade the array${s}.`;
    }
    return out;
  });
</script>

{#if v}
  <div id="layoutStats" class="stats">
    {#if !v.R}
      <p class="hint">No layout yet. Draw a PV area, then press "Fill area with tables" or keep auto-update on.</p>
    {:else}
      <Kpis items={v.kpis} />
      <div class="row gap"><button class="btn small" onclick={() => useCapacity('pv')}>Use as PV capacity</button><button class="btn small" onclick={() => useCapacity('opt')}>Use as optimiser land limit</button></div>
    {/if}
    {#if v.R && v.R.groups}
      <p class="hint">Tables by orientation: {v.R.groups.map((g) => `${fmtNum(g.n)} ${g.label === 'project' ? 'at the project\'s tilt and azimuth' : 'at ' + g.label}`).join(', ')}. The yield adds up each orientation under the shared inverters.</p>
    {/if}
    {#if v.R && lay.emptyAreas}<p class="hint">{plural(lay.emptyAreas, 'PV area takes', 'PV areas take')} no table: the edge setback ({fmtNum(v.p.layout.setback || 0, 1)} m) or the table size leaves no room.</p>{/if}
    {#if v.R && v.removed}<p class="hint">{plural(v.removed, 'table')} taken out by hand; <i>Restore all</i> in the toolbar puts them back.</p>{/if}
    {#if v.R && v.R.dropped}<p class="hint">{plural(v.R.dropped, 'table')} left out, shaded over {fmtPct(v.p.layout.max_table_shade, 0)} by buildings and trees.</p>{/if}
    {#if v.objText}
      <p class="hint">{v.objText}</p>
      {#if v.shade && v.shade.tables.length}
        <label class="hint inline"><input type="checkbox" checked={lay.showShade} onchange={(e) => showShade(e.target.checked)}> shade on the tables</label>
        <span class="shade-legend">{#each SHADE_CLASSES as [, c, t]}<i style:background={c}></i>{t}{/each}</span>
      {/if}
    {/if}
  </div>
{/if}
