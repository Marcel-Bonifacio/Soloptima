<!-- The loss parameters and the models used for the PV yield, with where each value came from -->
<script>
  import Tbl from './Tbl.svelte';
  import { fmtNum, fmtPct, fmtOffset } from '../../lib/format.js';
  let { D } = $props();
  const { P, h } = D, pv = P.pv, ap = P.electrical.applied || {}, HOURS = h.HOURS;
  const src = (k) => (ap[k] != null && ap[k] === pv[k]
    ? (k === 'dc_wiring' && pv.dc_wiring_basis === 'stc' ? 'set from Electrical & SLD as a constant fraction, basis since changed to STC power' : 'set from Electrical & SLD') : 'typed');
  const months = (v, unit, k = 1, d = 1) => 'by month, January to December: ' + v.map((x) => fmtNum(x * k, d)).join(', ') + (unit ? ' ' + unit : '');
  const iamTxt = pv.iam_model === 'martin_ruiz' ? ['IAM (Martin-Ruiz) a_r', fmtNum(pv.iam_ar, 3)]
    : pv.iam_model === 'physical' ? ['IAM (physical)', `glass n ${+pv.iam_n}, extinction × thickness ${+pv.iam_kl}${+pv.iam_n_ar ? `, coating n ${+pv.iam_n_ar}` : ', no coating'}`]
    : ['IAM b0 (ASHRAE)', fmtNum(pv.iam_b0, 3)];
  const snowTxt = Array.isArray(pv.snow_monthly) && Array.isArray(pv.snow_events)
    ? [['Snowfall', months(pv.snow_monthly, 'cm', 1, 0), 'typed'], ['Snow days', months(pv.snow_events, '', 1, 0), 'typed'], ['Relative humidity in snow months', fmtPct(pv.snow_rh, 0), 'typed']] : [];
  const loss = [['Albedo', Array.isArray(pv.albedo_monthly) ? months(pv.albedo_monthly, '', 1, 2) : fmtNum(pv.albedo, 2), 'typed'],
    ['Soiling', Array.isArray(pv.soiling_monthly) && pv.soiling_monthly.length === 12 ? months(pv.soiling_monthly, '%', 100, 1) : fmtPct(pv.soiling, 2), 'typed'],
    ...(pv.bifaciality > 0 ? [['Bifaciality', `${fmtPct(pv.bifaciality, 0)}, rear-side shading and mismatch ${fmtPct(pv.rear_loss, 1)}`, 'typed']] : []),
    [...iamTxt, 'typed'], ...snowTxt,
    ['Thermal model', pv.thermal_model === 'noct' ? `NOCT ${+pv.noct} °C` : `Heat-loss factors, Uc ${+pv.uc} W/m²K, Uv ${+pv.uv} W/m²K per m/s, absorptance ${+pv.absorptance}`, 'typed'],
    ['Low-irradiance loss at 200 W/m²', fmtPct(pv.low_irr_loss_200, 2), 'typed'], ['Mismatch', fmtPct(pv.mismatch, 2), 'typed'],
    ['DC wiring', `${fmtPct(pv.dc_wiring, 2)} ${pv.dc_wiring_basis === 'stc' ? 'at STC power' : 'as a constant fraction'}`, src('dc_wiring')], ['LID', fmtPct(pv.lid, 2), 'typed'],
    ['Module quality', fmtPct(pv.module_quality, 2), 'typed'], ['Inverter efficiency', pv.inverter_model === 'curve' ? `${fmtPct(pv.inverter_eff, 2)} weighted, ${fmtPct(pv.inverter_eff_max, 2)} peak (part-load curve)` : fmtPct(pv.inverter_eff, 2), 'typed'], ['AC losses', fmtPct(pv.ac_losses, 2), src('ac_losses')],
    ['Availability', fmtPct(pv.availability, 2), 'typed'], ['Degradation', fmtPct(pv.degradation, 2) + '/yr ' + (pv.degradation_model === 'linear' ? 'linear' : 'compound'), 'typed']];

  const W = P.weather || {}, split = W.dni && W.dni.length === HOURS && W.dhi && W.dhi.length === HOURS, pvgisWx = /^PVGIS/.test(W.source || '');
  // the period only when the source name does not already give it; no year is guessed from a file name
  const yrs = W.years ? ((W.source || '').includes(W.years) ? '' : W.years.replace('-', '–')) : /TMY/.test(W.source || '') ? 'typical year (period not recorded)' : '';
  const tr = pv.mount === 'tracker', vf = pv.row_shading && pv.diffuse_shading;
  const rows = vf || pv.bifaciality > 0 ? `; rows ${fmtNum(+P.layout.modules_across || 1)} ${P.layout.orientation === 'landscape' ? 'landscape' : 'portrait'} module${+P.layout.modules_across === 1 ? '' : 's'} wide with the ${tr ? 'axis' : 'table centre'} ${fmtNum(+pv.mount_height, 1)} m above the ground` : '';
  const diffuseTxt = vf ? '; sky diffuse and ground-reflected light by the 2-D view factors of the rows (Marion et al. 2017), the circumsolar part shaded with the beam' : '; diffuse light not shaded';
  const objs = (P.layout.polygons || []).filter((g) => g.type === 'obstacle'), trees = objs.filter((g) => g.kind === 'tree').length;
  const near = !objs.length ? 'none on the layout map' : pv.near_shading === false ? `${objs.length} on the layout map, switched off`
    : `${objs.length - trees} building${objs.length - trees === 1 ? '' : 's'} and ${trees} tree${trees === 1 ? '' : 's'} on the layout map: the near horizon of points on the tables; beam and circumsolar light lost on the share of them behind an object, sky diffuse by the sky the objects and the terrain leave in view`;
  const models = [['Weather data', W.source ? W.source + (yrs ? ', ' + yrs : '') : '–'],
    ['Decomposition', split ? 'beam and diffuse from the weather data, kept consistent with GHI' : pv.decomposition === 'disc' ? 'DISC (beam from the clearness index and the air mass)'
      : pv.decomposition === 'boland' ? 'Boland-Ridley (diffuse fraction from the clearness index)' : 'Erbs (diffuse fraction from the clearness index)'],
    ['Clear sky', pv.clearsky === 'ineichen' ? `Ineichen-Perez, Linke turbidity ${+pv.linke_turbidity > 0 ? +pv.linke_turbidity : 'by month from the weather year'}, elevation ${fmtNum(+P.location.elevation || 0)} m` : 'Haurwitz'],
    ['Reflection (IAM)', pv.iam_model === 'martin_ruiz' ? 'Martin-Ruiz; diffuse IAM integrated over the sky and ground in view' : pv.iam_model === 'physical' ? 'physical glass model; diffuse IAM integrated over the sky and ground in view' : 'ASHRAE, diffuse at 59°'],
    ['Spectrum', pv.spectral && pv.spectral !== 'none' ? `PVSPEC mismatch factor (${pv.spectral}) from the clear-sky index and the air mass` : 'not corrected'],
    ['Transposition', pv.transposition === 'perez' ? 'Perez 1990, all-sites coefficients (beam, isotropic, circumsolar and horizon-band sky diffuse, ground reflection)'
      : 'Hay-Davies (beam, circumsolar and isotropic sky diffuse, ground reflection)'],
    ['Shading', (tr ? (pv.backtracking ? `single-axis tracking with backtracking (no beam row shading), up to ±${+pv.tracker_max_angle}°` : pv.row_shading ? `true tracking with infinite-row beam shading at GCR ${+pv.gcr}, up to ±${+pv.tracker_max_angle}°` : 'true tracking without shading')
      : pv.row_shading ? `infinite-row 2-D beam shading at GCR ${+pv.gcr}` : 'none (row shading off)') + (pv.row_shading ? diffuseTxt : '') + (vf ? rows : '')
      + (pv.row_shading && pv.shade_model === 'blocks' ? `; bypass-diode blocks (${+pv.bypass_blocks > 0 ? +pv.bypass_blocks : 'from the layout'} up the table)` : '')
      + (tr && (+pv.tracker_axis_tilt || +pv.tracker_cross_slope) ? `; axis tilt ${+pv.tracker_axis_tilt}°, ground slope across the rows ${+pv.tracker_cross_slope}° (slope-aware backtracking)` : '')],
    ['Rear side', pv.bifaciality > 0 ? `bifacial: light reflected by the sunlit and shaded ground between the rows, sky above the row behind and beam from behind, by 2-D view factors at GCR ${+pv.gcr}${vf ? '' : rows}; bifaciality ${fmtPct(pv.bifaciality, 0)}, rear-side loss ${fmtPct(pv.rear_loss, 1)}` : 'monofacial'],
    ['Horizon', Array.isArray(pv.horizon) && pv.horizon.length ? (pv.horizon_beam === 'data' ? 'profile given, weather measured at the site: left to the data'
      : `profile of ${pv.horizon.length} points up to ${fmtNum(Math.max(...pv.horizon), 1)}°: sky diffuse reduced${pv.horizon_beam === 'apply' || !pvgisWx ? ', beam blocked while the sun is below it' : ', beam as blocked in the PVGIS data'}`)
      : pvgisWx ? 'terrain horizon included in the PVGIS beam irradiance' : 'not applied'],
    ['Nearby objects', near],
    ['Snow', Array.isArray(pv.snow_monthly) ? 'monthly snow loss (Townsend)' : 'none'],
    ['Time base', `local standard time, ${fmtOffset(P.location.utc_offset)}${P.location.tz ? ' (' + P.location.tz + ')' : ''}; ` + (W.is_utc === false ? 'weather data already in local time'
      : 'weather data in UTC shifted by the offset' + (+P.location.utc_offset % 1 ? ', each local hour the weighted mean of the two UTC hours it overlaps' : ''))]];
</script>

<h3>Loss parameters</h3>
<Tbl head={['Parameter', 'Value', 'Source']} rows={loss} />
<h3>Models used</h3>
<Tbl head={['Model', 'Used']} rows={models} />
