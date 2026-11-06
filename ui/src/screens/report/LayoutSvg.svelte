<!-- The site and PV layout drawing of the report: PV areas, exclusion zones, buildings, trees, PV tables and the site marker, drawn
     from the stored coordinates (so it works offline and prints sharply), over the satellite image when there is one. -->
<script>
  import { layoutFrame, w180 } from '../../lib/report/layout-geom.js';
  let { G, img } = $props();
  const F = $derived(layoutFrame(G));
  const halo = $derived(img ? { stroke: '#fff', 'stroke-opacity': '.85' } : { stroke: 'none' });
  const tableD = $derived(G.tables.map(F.path).join(''));
</script>

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {F.W} {F.H}" width={F.W} height={F.H} role="img" aria-label="Site and PV layout">
  {#if img}<image href={img} x="0" y="0" width={F.W} height={F.H} preserveAspectRatio="none" />{:else}<rect width={F.W} height={F.H} fill="#f4f6f5" />{/if}
  <defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#b4302f" stroke-width="2.5" /></pattern></defs>
  {#each G.sites as p}
    <path d={F.path(p.latlngs)} fill="#0f7466" fill-opacity={img ? 0.12 : 0.1} {...halo} stroke-width="6" />
    <path d={F.path(p.latlngs)} fill="none" stroke="#0f7466" stroke-width="2.5" />
  {/each}
  {#if G.tables.length}<path d={tableD} fill="#1b2740" fill-opacity=".9" />{/if}
  {#each G.excls as p}<path d={F.path(p.latlngs)} fill="url(#hatch)" fill-opacity=".55" stroke="#b4302f" stroke-width="2" stroke-dasharray="6 4" />{/each}
  {#each G.buildings as p}<path d={F.path(p.latlngs)} fill="#8a7560" fill-opacity=".75" stroke="#3d2f22" stroke-width="1.5" />{/each}
  {#each G.trees as p}<path d={F.path(p.latlngs)} fill="#4caf50" fill-opacity=".7" stroke="#1b5e20" stroke-width="1.2" />{/each}
  {#if !G.away}<circle cx={F.siteX.toFixed(1)} cy={F.siteY.toFixed(1)} r="7" fill="#f59e0b" stroke="#fff" stroke-width="2.5" />{/if}
  <g transform="translate({F.W - 46},18)">
    <rect x="-16" y="-6" width="32" height="56" rx="6" fill="#fff" fill-opacity=".9" /><path d="M0 0 L9 26 L0 20 L-9 26 Z" fill="#1a1a1a" />
    <text x="0" y="44" text-anchor="middle" font-size="13" font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">N</text>
  </g>
  <g transform="translate(16,{F.H - 44})">
    <rect x="-6" y="-8" width={(F.Lpx + 12).toFixed(0)} height="40" rx="6" fill="#fff" fill-opacity=".9" />
    <rect x="0" y="0" width={(F.Lpx / 2).toFixed(1)} height="6" fill="#1a1a1a" /><rect x={(F.Lpx / 2).toFixed(1)} y="0" width={(F.Lpx / 2).toFixed(1)} height="6" fill="#fff" stroke="#1a1a1a" />
    <text x="0" y="24" font-size="13" font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">0</text>
    <text x={F.Lpx.toFixed(1)} y="24" text-anchor="end" font-size="13" font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">{F.label}</text>
  </g>
  <g><rect x={F.W - 238} y={F.H - 30} width="230" height="22" rx="5" fill="#fff" fill-opacity=".9" />
    <text x={F.W - 123} y={F.H - 14} text-anchor="middle" font-size="13" font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">{G.la0.toFixed(5)}, {w180(G.lo0).toFixed(5)} (SW)</text></g>
  <g><rect x="8" y="8" width="230" height="22" rx="5" fill="#fff" fill-opacity=".9" />
    <text x="123" y="24" text-anchor="middle" font-size="13" font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">{G.la1.toFixed(5)}, {w180(G.lo1).toFixed(5)} (NE)</text></g>
</svg>
