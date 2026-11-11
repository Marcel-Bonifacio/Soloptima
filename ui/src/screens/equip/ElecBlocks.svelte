<!-- The inverter blocks measured on the layout map: tables, power, string and inverter cable runs, voltage drops and the losses of
     each block (lib/equip/design.js, blockLosses). The block that loses most is marked, and every block over a drop limit. -->
<script>
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { design } from '../../lib/equip/electrical.svelte.js';

  const D = $derived(design());
  const B = $derived(D.blocks);
  const label = (x, j) => x.name || (B.mode === 'string' ? 'Inverter ' : 'PV station ') + (j + 1);
  const kwh = (v) => (v == null ? '–' : fmtNum(v / 1000, v >= 1e5 ? 0 : 1));
  const pct = (v) => (v == null ? '–' : fmtPct(v, 2));
  let open = $state(false);
  const shown = $derived(B ? (open ? B.list : B.list.slice(0, 12)) : []);
</script>

{#if B}
  <div class="card">
    <h3>Inverter blocks ({B.mode === 'string' ? 'string inverters' : 'central inverters in the PV stations'})</h3>
    <p class="hint">Each {B.mode === 'string' ? 'inverter' : 'PV station'} on the layout map takes a block of tables of about the same size. String cables run from each table to it{B.mode === 'string' ? ', and its AC cable to the nearest PV station' : ''}. Lengths are straight lines times the route factor; the losses are the block's share of the cable table's losses.</p>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Block</th><th>Tables</th><th>kWp</th><th>String m avg</th><th>String m max</th><th>ΔV DC %</th>
          {#if B.mode === 'string'}<th>AC m</th><th>ΔV AC %</th>{/if}<th>DC loss MWh</th>{#if B.mode === 'string'}<th>AC loss MWh</th>{/if}<th>Loss % of block energy</th></tr></thead>
        <tbody>
          {#each shown as x, j (x.node)}
            <tr class:bad={x.over} class:worst={x.node === B.worst}>
              <td>{label(x, x.node)}{#if x.node === B.worst}<span class="cell-sub">loses most</span>{/if}</td>
              <td>{fmtNum(x.n)}</td><td>{fmtNum(x.kwp, 0)}</td><td>{fmtNum(x.dcAvg, 0)}</td><td>{fmtNum(x.dcMax, 0)}</td><td>{x.dvDc == null ? '–' : fmtNum(x.dvDc * 100, 2)}</td>
              {#if B.mode === 'string'}<td>{x.ac == null ? '–' : fmtNum(x.ac, 0)}</td><td>{x.dvAc == null ? '–' : fmtNum(x.dvAc * 100, 2)}</td>{/if}
              <td>{kwh(x.dcKwh)}</td>{#if B.mode === 'string'}<td>{kwh(x.acKwh)}</td>{/if}<td>{pct(x.loss)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if B.list.length > 12}<button type="button" class="btn small ghost" onclick={() => (open = !open)}>{open ? 'Show the first 12' : `Show all ${B.list.length} blocks`}</button>{/if}
    {#if B.list.some((x) => x.loss == null)}<p class="hint">Calculate the PV yield (tab 4) for the losses in energy.</p>{/if}
  </div>
{/if}
