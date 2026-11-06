<!-- Under the Location form: the site in degrees, minutes and seconds, the UTC offset against the site's time zone (with
     Use / Keep when they differ), the elevation of the weather data and the address. -->
<script>
  import { zoneCheck } from '../../lib/ws/util.js';
  import { lay, P, zoneChoice } from '../../lib/layout/map.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { toDMS } from '../../lib/layout/coords.js';
  import { fmtNum, fmtOffset } from '../../lib/format.js';

  // the project is edited in place: read again whenever the map or the forms change it
  const v = $derived.by(() => {
    lay.rev; forms.rev;
    const p = P();
    if (!p) return null;
    const L = p.location, { z, differs, warn } = zoneCheck(L), off = fmtOffset(L.utc_offset), typed = L.utc_offset_src === 'typed';
    const line = !z ? (typed ? `${off} typed; no time zone found for this location` : `${off} from longitude: no time zone found, check it`)
      : !differs ? `${off} (${z.tz}, standard time)`
        : typed ? `${off} typed; the site's time zone ${z.tz} is ${fmtOffset(z.std)}`
          : `${off} as saved; the site's time zone ${z.tz} is ${fmtOffset(z.std)}, check it`;
    const W = p.weather, atSite = !!(W && W.elevation != null && Math.abs(W.lat - +L.lat) < 0.05 && Math.abs(W.lon - +L.lon) < 0.05);
    return { L, z, differs, warn, line, off, typed, offs: z ? z.all.map(fmtOffset) : [], W, atSite };
  });
</script>

{#if v}
  <div id="siteInfo" class="site-info">
    <b>{toDMS(v.L.lat, v.L.lon)}</b><br>
    {#if v.warn}<span class="warn-text">{v.line}</span>{:else}{v.line}{/if}
    {#if v.differs}
      <button type="button" class="btn small" data-tz="use" onclick={() => zoneChoice('use')}>Use {fmtOffset(v.z.std)}</button>
      {#if !v.typed}<button type="button" class="btn small ghost" data-tz="keep" onclick={() => zoneChoice('keep')}>Keep {v.off}</button>{/if}
    {/if}
    {#if v.z && v.z.irregular}
      <br><span class="warn-text">{v.z.tz} has {v.offs.length} different offsets this year ({v.offs.join(', ')}): check the offset.</span>
    {:else if v.z && v.z.dst}
      <br><span class="hint">{v.z.tz} observes daylight saving ({v.offs.join(' and ')}). Soloptima works in local standard time, the lower offset. Import clock-time logger data with the time basis Local clock time with daylight saving.</span>
    {/if}
    <br>
    {#if v.atSite}Elevation {fmtNum(v.W.elevation)} m (from {v.W.source}){:else}<span class="hint">Solar data not yet fetched for this location (tab 2).</span>{/if}
    {#if lay.addr == null}<br><span class="hint">Looking up address…</span>{:else if lay.addr}<br>{lay.addr}{/if}
  </div>
{/if}
