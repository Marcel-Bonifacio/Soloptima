<!-- Equipment datasheets page: the library by type, the editor, and the datasheets used in the project -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { fmtNum } from '../../lib/format.js';
  import { EQ_TYPES, selectedIn } from '../../lib/equip/library.js';
  import { eq, setType, add, importFile, exportJson, exportCsvFile, restoreGeneric, apply } from '../../lib/equip/equipment.svelte.js';
  import EquipTable from './EquipTable.svelte';
  import EquipEditor from './EquipEditor.svelte';

  // what the selected datasheets mean for the model inputs
  const used = $derived.by(() => {
    eq.rev;
    const P = W.P, s = (t) => selectedIn(P, t);
    const pv = s('pv'), inv = s('inverter'), bat = s('battery'), dg = s('genset');
    const nCont = bat && bat.energy_kwh ? P.bess.energy_kwh / bat.energy_kwh : 0;
    return [
      ['PV module', pv ? pv.name : '–', pv ? `${fmtNum(P.pv.capacity_kwp * 1000 / pv.pmax)} modules for ${fmtNum(P.pv.capacity_kwp)} kWp` : ''],
      ['PV inverter', inv ? inv.name : '–', inv ? `${fmtNum(Math.ceil(P.pv.capacity_kwp / P.pv.dc_ac_ratio / inv.pac_kw))} units at DC/AC ${P.pv.dc_ac_ratio}` : ''],
      ['Battery', bat ? bat.name : '–', bat ? `${fmtNum(nCont, 1)} units for ${fmtNum(P.bess.energy_kwh)} kWh${Math.abs(nCont - Math.round(nCont)) > 0.05 ? ' (not a whole number)' : ''}` : ''],
      ['Diesel generator', dg ? dg.name : '–', dg ? `fleet ${P.diesel.units} × ${fmtNum(P.diesel.unit_kw)} kW in the model` : ''],
    ];
  });
</script>

{#if eq.active}
  <div class="row gap"><div class="seg" role="group" aria-label="Equipment type">
    {#each Object.entries(EQ_TYPES) as [k, v]}<button class={k === eq.type ? 'on' : ''} onclick={() => setType(k)}>{v.label}</button>{/each}
  </div></div>
  <div class="row gap">
    <button class="btn small" onclick={add}>+ New datasheet</button>
    <label class="btn small ghost">Import JSON / CSV<input type="file" accept=".json,.csv" hidden onchange={(e) => { importFile(e.currentTarget.files[0]); e.currentTarget.value = ''; }}></label>
    <button class="btn small ghost" onclick={exportJson}>Export library (JSON)</button>
    <button class="btn small ghost" onclick={exportCsvFile}>Export this type (CSV)</button>
    <button class="btn small ghost" onclick={restoreGeneric}>Restore generic library</button>
  </div>
  <div class="grid-2">
    <div class="card"><div class="table-wrap"><EquipTable /></div></div>
    <div class="card"><EquipEditor /></div>
  </div>
  <div class="card"><h3>Equipment used in this project</h3>
    <table class="data"><tbody>{#each used as r}<tr><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td></tr>{/each}</tbody></table>
    <div class="row gap"><button class="btn primary" onclick={apply}>Apply selected datasheets to the model</button>
      <span class="hint inline">Sets module power/efficiency/temperature coefficient/dimensions (and NOCT and low-irradiance loss when given), inverter efficiency, battery efficiency/DoD/cycle life/prices (and the PCS no-load loss when given), genset rating/min load/fuel curve.</span></div>
  </div>
{/if}
