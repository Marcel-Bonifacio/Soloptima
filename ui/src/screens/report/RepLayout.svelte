<!-- "Site and PV layout" of the report: coordinates, the PV field, the drawing and the area corners -->
<script>
  import Tbl from './Tbl.svelte';
  import LayoutSvg from './LayoutSvg.svelte';
  import { fmtNum, fmtArea, fmtOffset } from '../../lib/format.js';
  import { coord, w180, kmBetween, layoutResult } from '../../lib/report/layout-geom.js';
  import { toDMS } from '../../lib/layout/coords.js';
  import { orientationOf } from '../../lib/layout/items.js';
  let { D } = $props();

  const { P, SIM, G, h, img } = D, L = P.location, Wx = P.weather, R = layoutResult(P);
  const rows = [['Site coordinates', `${coord(L.lat, L.lon)} (${toDMS(+L.lat, w180(+L.lon))})`], ['Time zone', `${fmtOffset(L.utc_offset)}${L.tz ? ' (' + L.tz + ')' : ''}`]];
  // the weather elevation is the site's only when the data were fetched for this site
  if (h.weatherAtSite()) rows.push(['Elevation', `${fmtNum(Wx.elevation)} m (from ${Wx.source})`]);
  else if (Wx && Number.isFinite(+Wx.lat) && Number.isFinite(+Wx.lon))
    rows.push(['Weather data point', `${coord(Wx.lat, Wx.lon)}, about ${fmtNum(kmBetween(+L.lat, +L.lon, +Wx.lat, +Wx.lon), 1)} km from the site${Wx.elevation != null ? `, elevation ${fmtNum(Wx.elevation)} m` : ''}; fetch the solar data again for this site`]);
  if (G && G.tables.length) {
    let a = 0, b = 0, la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    for (const tb of G.tables) for (const [x, y] of tb) { a += x; b += y; la0 = Math.min(la0, x); la1 = Math.max(la1, x); lo0 = Math.min(lo0, y); lo1 = Math.max(lo1, y); }
    const n = G.tables.length * 4;
    rows.push(['PV field centre', coord(a / n, b / n)], ['PV field extent', `${fmtNum((lo1 - lo0) * G.kx)} m east-west × ${fmtNum((la1 - la0) * G.ky)} m north-south`]);
  }
  if (R && +R.n_tables > 0) {
    const kw = SIM ? +SIM.result.size.pv_kwp : +P.pv.capacity_kwp, by = SIM ? 'simulated' : 'entered on PV & wind';
    rows.push(['PV tables / modules (area filled)', `${fmtNum(+R.n_tables)} tables, ${fmtNum(+R.modules)} modules, ${fmtNum(+R.kwp)} kWp DC, the most the PV area holds`]);
    if (+R.pitch > 0) rows.push(['Row pitch', `${fmtNum(+R.pitch, 2)} m`]);
    if (kw > 0 && Math.abs(+R.kwp - kw) > 0.01 * kw)
      rows.push(['Note', +R.kwp < kw ? `The PV area holds at most ${fmtNum(+R.kwp)} kWp, less than the ${fmtNum(kw)} kWp ${by}: the plant does not fit on the drawn area.` : `The drawing fills the PV area (${fmtNum(+R.kwp)} kWp); the plant ${by} has ${fmtNum(kw)} kWp.`]);
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const notDrawn = G && R && +R.n_tables > G.tables.length ? ` The ${fmtNum(+R.n_tables)} PV tables of the layout are too many to draw; only the areas are shown.` : '';
  const caption = G ? `Site and PV layout: ${plural(G.sites.length, 'PV area', 'PV areas')} (green)${G.excls.length ? `, ${plural(G.excls.length, 'exclusion zone', 'exclusion zones')} (hatched)` : ''}${G.buildings.length ? `, ${plural(G.buildings.length, 'building', 'buildings')} (brown)` : ''}${G.trees.length ? `, ${plural(G.trees.length, 'tree', 'trees')} (light green)` : ''}${G.tables.length ? `, ${fmtNum(G.tables.length)} PV tables filling the area (dark)` : ''}${G.away ? '.' : '; the orange dot marks the site coordinates.'}${G.siteNote + notDrawn}${img ? ' Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community.' : img === null ? ' The satellite image could not be fetched (no internet, or no image at this scale), so the drawing is shown without it.' : ''}${G.osm ? ' Building outlines © OpenStreetMap contributors (ODbL).' : ''}` : '';
  const k = { site: 0, exclusion: 0 }, orient = (p) => { const o = orientationOf(P, p); return o.own ? `; ${o.canopy ? 'canopy, ' : o.ew ? 'east-west, ' : ''}tilt ${fmtNum(o.tilt)}°, azimuth ${fmtNum(o.azimuth)}°` : ''; };
  const areas = G ? G.polys.filter((p) => p.type === 'site' || p.type === 'exclusion').map((p) => {
    const c = G.centroid(p.latlngs);
    return [`${p.type === 'site' ? 'PV area' : 'Exclusion zone'} ${++k[p.type]}`, fmtArea(G.area(p.latlngs)) + (p.type === 'site' && +p.base ? `, ${fmtNum(+p.base, 1)} m above the ground` : '') + (p.type === 'site' ? orient(p) : ''), p.latlngs.length, coord(c[0], c[1])];
  }) : [];
  const objs = G ? G.buildings.map((p, i) => { const c = G.centroid(p.latlngs); return [`Building ${i + 1}`, `${fmtNum(+p.height, 1)} m`, `footprint ${fmtArea(G.area(p.latlngs))}`, coord(c[0], c[1])]; })
    .concat(G.trees.map((p, i) => [`Tree ${i + 1}`, `${fmtNum(+p.height, 1)} m`, `crown ${fmtNum(+p.diameter, 1)} m`, coord(p.center[0], p.center[1])])) : [];
  // corner coordinates of the PV areas; the workbook's Layout sheet has every corner
  const corners = [], cap = 40;
  if (G) G.sites.forEach((p, i) => p.latlngs.forEach(([a, b], j) => corners.push([`PV area ${i + 1}, corner ${j + 1}`, (+a).toFixed(6), w180(+b).toFixed(6)])));
</script>

<h3>Site and PV layout</h3>
<Tbl {rows} head={['Item', 'Value']} />
{#if !G}
  <p>No PV area is drawn. Use Draw PV area on the Site &amp; layout page to add the layout drawing and its corner coordinates to the report.</p>
{:else}
  <figure class="layout"><LayoutSvg {G} {img} /><figcaption>{caption}</figcaption></figure>
  <Tbl rows={areas} head={['Area', 'Size', 'Corners', 'Centroid (lat, lon)']} />
  {#if objs.length}
    <h3>Buildings and trees that shade the array</h3>
    <Tbl rows={objs.slice(0, 60)} head={['Object', 'Height', 'Size', 'Centre (lat, lon)']} />
    {#if objs.length > 60}<p>{objs.length - 60} more objects are in the Layout sheet of the Excel workbook.</p>{/if}
  {/if}
  <h3>PV area corner coordinates</h3>
  <Tbl rows={corners.slice(0, cap)} head={['Corner', 'Latitude', 'Longitude']} />
  {#if corners.length > cap}<p>{corners.length - cap} more corners are in the Layout sheet of the Excel workbook.</p>{/if}
{/if}
