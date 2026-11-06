<!-- The workspace of an open project: the side navigation and the pages. The top bar belongs to the app (TopBar.svelte). -->
<script>
  import Nav from './Nav.svelte';
  import StepNav from './StepNav.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { engine } from '../../lib/ws/boot.svelte.js';
  import LayoutView from '../layout/LayoutView.svelte';
  import ResourcePage from '../data/ResourcePage.svelte';
  import LoadPage from '../data/LoadPage.svelte';
  import PvPage from '../plant/PvPage.svelte';
  import BessPage from '../plant/BessPage.svelte';
  import DieselPage from '../plant/DieselPage.svelte';
  import EconPage from '../plant/EconPage.svelte';
  import EquipPage from '../equip/EquipPage.svelte';
  import ElecPage from '../equip/ElecPage.svelte';
  import SimPage from '../sim/SimPage.svelte';
  import OptPage from '../plan/OptPage.svelte';
  import EmsPage from '../plan/EmsPage.svelte';
  import FinPage from '../finance/FinPage.svelte';
  import ConsolePage from '../console/ConsolePage.svelte';
  import ReportPage from '../report/ReportPage.svelte';
  import TsImportDialog from '../tsimport/TsImportDialog.svelte';
</script>

<div class="shell ws-only">
  <Nav engine={engine.text} />
  <main class="content" id="mainContent">
    <section id="tab-site" class="tab" class:active={ws.tab === 'site'}>
      <h1>Site &amp; layout</h1>
      <p class="lead">Click the map (or search) to set the site. Then draw the land available for PV and the tool fills it with module tables to find the maximum capacity. Buildings and trees next to the array shade it: place them with their heights, and the yield counts their shade with the terrain horizon. Ctrl+click a roof (Cmd+click on a Mac) to lay it out as a PV area; double-click a placed shape to move its corners.</p>
      <div class="grid-2 map-grid"><LayoutView /></div>
    </section>
    <ResourcePage />
    <LoadPage />
    <PvPage />
    <BessPage />
    <DieselPage />
    <EconPage />
    <section id="tab-equip" class="tab" class:active={ws.tab === 'equip'}>
      <h1>Equipment datasheets</h1>
      <p class="lead">Datasheet library for PV modules, inverters, batteries, diesel generators, transformers and cables. Pick the equipment used in this project ("Use"), then apply it to the model. Built-in entries are generic typical values; import or enter the manufacturer datasheets for design work.</p>
      <EquipPage />
    </section>
    <section id="tab-elec" class="tab" class:active={ws.tab === 'elec'}>
      <h1>Electrical design &amp; single-line diagram</h1>
      <p class="lead">String sizing, transformer selection and cable sizing (current rating, voltage drop, I²R losses) from the datasheets. Annual losses are integrated over the hourly PV, battery, genset and load profiles and can be fed back into the energy model.</p>
      <ElecPage />
    </section>
    <section id="tab-script" class="tab" class:active={ws.tab === 'script'}>
      <h1>Script console</h1>
      <p class="lead">A numeric workspace on top of the engine: vectors, statistics, curve fitting, plots, tables, parametric sweeps and Monte Carlo runs, with full access to the project and every result. Scripts are JavaScript with numeric helper functions (type <code>help()</code>).</p>
      <ConsolePage />
    </section>
    <SimPage />
    <OptPage />
    <EmsPage />
    <FinPage />
    <section id="tab-report" class="tab" class:active={ws.tab === 'report'}><ReportPage /></section>
    <StepNav />
  </main>
</div>
<TsImportDialog />
<div id="chDispatchRep" class="offscreen-chart" aria-hidden="true"></div>
