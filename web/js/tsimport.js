// Timestamped load and weather files (Upload CSV on Solar resource and Load) and the data checks of the project's weather and
// load. The import dialog previews the first rows and takes the columns, date order, year, time basis, timestamp label and units;
// the engine (/api/import-series, src/series.cpp) turns the file into 8760 hourly means with an import report, which is shown
// before the data replace P.load.kw or P.weather. After every weather fetch or upload and every load upload, /api/data-qc checks
// the data (P.weather.qc, P.load.qc): weather timing against the sun, physical limits, stuck or copied values; load outages,
// stuck values, linear infill, spikes, level shifts and units. Flags only inform: the timing fixes change the weather only when
// their button is clicked.
'use strict';

const TsImport = (() => {
  const LOAD_UNITS = [['kw', 'kW (mean power)'], ['w', 'W (mean power)'], ['mw', 'MW (mean power)'], ['kwh_interval', 'kWh per interval'], ['mwh_interval', 'MWh per interval']];
  const IRR_UNITS = [['w_m2', 'W/m² (mean)'], ['wh_m2_interval', 'Wh/m² per interval'], ['kwh_m2_interval', 'kWh/m² per interval'], ['mj_m2_interval', 'MJ/m² per interval']];
  const TEMP_UNITS = [['c', '°C'], ['k', 'K']];
  const WIND_UNITS = [['m_s', 'm/s'], ['km_h', 'km/h']];
  const LABELS = [['auto', 'Detect from the first and last stamps'], ['start', 'Start of the interval'], ['end', 'End of the interval'], ['instant', 'Instant (a sample at the stamp)']];
  const ORDERS = [['auto', 'Detect (a day above 12)'], ['ymd', 'Year, month, day'], ['dmy', 'Day, month, year'], ['mdy', 'Month, day, year']];
  // weather columns with the header names the guess looks for (as the positional upload did)
  const WX = [['ghi', 'GHI', ['ghi', 'g(h)', 'globhor', 'global']], ['dni', 'DNI', ['dni', 'gb(n)', 'beam']], ['dhi', 'DHI', ['dhi', 'gd(h)', 'diff']],
              ['tamb', 'Temperature', ['temp', 't2m', 'tamb', 'air_temp', 'ta']], ['wind', 'Wind speed', ['wind', 'ws', 'wspd']]];
  const BASIS_TEXT = { utc: 'UTC', local_standard: 'local standard time', local_clock: 'local clock time with daylight saving' };
  const LABEL_TEXT = { start: 'the start of each interval', end: 'the end of each interval', instant: 'instantaneous samples' };
  const KIND_TEXT = { load: 'load', weather: 'weather' };
  const DATE_RE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|^\d{8}([:T ]?\d{2}:?\d{2})?$/;
  const word = (h, w) => new RegExp(`(^|[^a-z])(${w})([^a-z]|$)`).test(h);
  const days = (n) => `${fmtNum(n)} day${n === 1 ? '' : 's'}`;
  let S = null;   // the open dialog: {kind, file, text, delim, lines, hdr, names, ncol, nlines, opt, res, err, stale}

  // ---------------------------------------------------------------- file preview and guesses
  // The first n non-blank lines (from the end with back = true), as the engine and parseCSV skip blank lines.
  function someLines(text, n, back) {
    const out = [];
    if (!back) {
      let p = text.charCodeAt(0) === 0xfeff ? 1 : 0;
      while (p < text.length && out.length < n) {
        let q = text.indexOf('\n', p);
        if (q < 0) q = text.length;
        const l = text.slice(p, q).replace(/\r$/, '');
        if (l.trim()) out.push(l);
        p = q + 1;
      }
      return out;
    }
    let q = text.length;
    while (q > 0 && out.length < n) {
      const p = text.lastIndexOf('\n', q - 1) + 1, l = text.slice(p, q).replace(/\r$/, '');
      if (l.trim()) out.unshift(l);
      q = p - 1;
    }
    return out;
  }
  const num = (c) => (c !== '' && c != null && isFinite(Number(S.delim === ';' ? c.replace(',', '.') : c)) ? Number(S.delim === ';' ? c.replace(',', '.') : c) : NaN);
  const isTime = (c) => DATE_RE.test(c || '');
  const cells = (l) => csvSplit(l, S.delim);

  // Columns, date order, units and time basis guessed from the header names and the first rows; the time basis of the previous
  // import of the same kind is kept.
  function guess() {
    const rows = S.lines.slice(S.hdr).map(cells), r0 = rows[0] || [], r1 = rows[1] || [], names = S.names, kind = S.kind;
    const name = (i) => names[i] || '';
    let tc = names.findIndex((h, i) => word(h, 'date|time|timestamp|datetime|date ?time|zeit|datum') && (isTime(r0[i]) || isFinite(num(r0[i]))));
    if (tc < 0) tc = r0.findIndex(isTime);
    if (tc < 0) {   // Excel serial days stepping by an hour, half an hour or a quarter of an hour
      tc = r0.findIndex((c, i) => { const a = num(c), b = num(r1[i]); return a >= 20000 && a <= 80000 && [1 / 24, 1 / 48, 1 / 96].some((s) => Math.abs(b - a - s) < 1e-6); });
    }
    let t2 = -1;
    if (tc >= 0 && !/\d:\d\d/.test(r0[tc] || '') && !/^\d{8}[:T ]?\d{4}$/.test(r0[tc] || '')) {   // a date alone: the time of day in its own column
      t2 = r0.findIndex((c, i) => i !== tc && /^\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i.test(c));
    }
    const isVal = (i) => i !== tc && i !== t2 && isFinite(num(r0[i]));
    const vals = Array.from({ length: S.ncol }, (_, i) => i).filter(isVal);
    const prev = (kind === 'load' ? P.load.import : P.weather && P.weather.import) || {};
    const o = { time_col: tc, time2_col: t2, date_order: 'auto', year: 'auto', label: 'auto', fill_long: false,
                basis: prev.basis || (kind === 'weather' && P.weather_ui.is_utc ? 'utc' : 'local_standard') };
    if (o.basis === 'local_clock' && !clockOk(tc)) o.basis = 'local_standard';
    if (kind === 'load') {
      const named = vals.filter((i) => word(name(i), 'kw|kwh|mw|mwh|w|load|power|demand|p|active power|consumption'));
      const total = named.find((i) => /total|sum/.test(name(i)));
      o.cols = [total != null ? total : named.length ? named[0] : vals.length ? vals[vals.length - 1] : 0];
      const h = name(o.cols[0]);
      o.units = /kwh/.test(h) ? 'kwh_interval' : /mwh/.test(h) ? 'mwh_interval' : word(h, 'mw') ? 'mw' : word(h, 'w') ? 'w' : 'kw';
    } else {
      for (const [k, , keys] of WX) o[k] = names.findIndex((h, i) => i !== tc && i !== t2 && keys.some((n) => h === n || h.startsWith(n)));
      if (o.ghi < 0) o.ghi = vals.length ? vals[0] : -1;
      const g = name(o.ghi), t = name(o.tamb), w = name(o.wind);
      o.irr_units = /kwh\/m/.test(g) ? 'kwh_m2_interval' : /wh\/m/.test(g) ? 'wh_m2_interval' : /mj/.test(g) ? 'mj_m2_interval' : 'w_m2';
      o.temp_units = /kelvin|\(k\)|\[k\]/.test(t) ? 'k' : 'c';
      o.wind_units = /km\/h|kmh|kph/.test(w) ? 'km_h' : 'm_s';
    }
    return o;
  }
  // Clock time with daylight saving needs a time column and the site's zone with a clock change in the file's years (a zone
  // that has since dropped daylight saving still had it then).
  function clockOk(tc) {
    try {
      const tz = P.location.tz;
      if (!tz || !(tc >= 0)) return false;
      const [y0, y1] = fileYears(tc);
      for (let y = y0; y <= Math.min(y1, y0 + 60); y++) if (zoneOffsets(tz, y).dst) return true;
      return false;
    } catch (e) { return false; }
  }
  // Calendar years of the file from time column tc of its first and last lines (for the zone's clock changes).
  function fileYears(tc) {
    const ys = [];
    for (const l of S.lines.slice(S.hdr).concat(someLines(S.text, 40, true))) {
      const c = cells(l)[tc] || '', m = c.match(/(?:^|\D)((?:19|20|21)\d\d)(?:\D|$)/), x = num(c);
      if (m) ys.push(+m[1]);
      else if (x >= 20000 && x <= 80000) ys.push(new Date(Date.UTC(1899, 11, 30) + x * 864e5).getUTCFullYear());
    }
    const now = new Date().getUTCFullYear();
    return ys.length ? [Math.min(...ys), Math.max(...ys)] : [1990, now + 1];
  }
  // The zone's clock from y0 to y1: {start: offset in h, changes: [[UTC minute since 1970, offset in h after it], ...]}. Each change
  // is found to the minute between two days whose offsets differ (Intl time-zone data of the browser; nothing leaves the computer).
  function clockOf(tz, y0, y1) {
    const fmt = zoneFormat(tz), at = (t) => wallOffset(fmt, t), changes = [], end = Date.UTC(y1 + 1, 0, 1, 12);
    let tp = Date.UTC(y0 - 1, 11, 31, 12), prev = at(tp);
    const start = prev;
    for (let t = tp + 864e5; t <= end; t += 864e5) {
      const o = at(t);
      if (o !== prev) {
        let lo = tp, hi = t;
        while (hi - lo > 60000) { const m = lo + Math.floor((hi - lo) / 120000) * 60000; if (at(m) === prev) lo = m; else hi = m; }
        changes.push([Math.round(hi / 60000), o]);
        prev = o;
      }
      tp = t;
    }
    return { start, changes };
  }
  // Options as /api/import-series takes them.
  function engineOpt() {
    const o = S.opt, e = { kind: S.kind, time_col: o.time_col, time2_col: o.time_col >= 0 ? o.time2_col : -1, date_order: o.date_order, time_basis: o.basis,
                           label: o.label, utc_offset: +P.location.utc_offset || 0, year: o.time_col < 0 || o.year === 'auto' ? 'auto' : o.year === 'last12' ? 'last12' : +o.year };
    if (S.kind === 'load') Object.assign(e, { cols: o.cols, units: o.units, fill_long: !!o.fill_long });
    else Object.assign(e, { ghi: o.ghi, dni: o.dni, dhi: o.dhi, tamb: o.tamb, wind: o.wind, irr_units: o.irr_units, temp_units: o.temp_units, wind_units: o.wind_units });
    if (o.basis === 'local_clock') { const [y0, y1] = fileYears(o.time_col); e.clock = clockOf(P.location.tz, y0, Math.min(y1, y0 + 60)); }
    return e;
  }

  // ---------------------------------------------------------------- dialog
  async function open(kind, file) {
    const text = await readFile(file);
    const lines = someLines(text, 20);
    if (!lines.length) throw new Error(`${file.name} is empty.`);
    S = { kind, file: file.name, text, delim: csvDelimOf(lines), lines, res: null, err: '', stale: false };
    // header lines: those before the first line with a date (or, without dates, with a number); the last of them names the columns
    let hdr = lines.findIndex((l) => cells(l).some(isTime));
    if (hdr < 0) hdr = Math.max(0, lines.findIndex((l) => cells(l).some((c) => isFinite(num(c)))));
    S.hdr = hdr;
    S.names = hdr ? cells(lines[hdr - 1]).map((c) => c.toLowerCase()) : [];
    S.ncol = Math.min(256, Math.max(...lines.map((l) => cells(l).length)));
    S.nlines = 0;
    for (let p = -1; (p = text.indexOf('\n', p + 1)) >= 0;) S.nlines++;
    if (!text.endsWith('\n')) S.nlines++;
    S.opt = guess();
    const d = $('#dlgImport');
    d.innerHTML = `<div class="dlg-body ts">
      <div class="dlg-head"><h2>Import ${KIND_TEXT[kind]} data: ${escapeHtml(file.name)}</h2><button type="button" class="btn ghost small" data-close>Close</button></div>
      <p class="hint">${fmtNum(S.nlines)} lines. The first ${lines.length} non-blank lines are shown; the time column is highlighted in blue and the ${kind === 'load' ? 'load columns' : 'value columns'} in amber. Check the file to see how it is read before its data replace the project's.</p>
      <div class="table-wrap ts-preview" id="tsPreview"></div>
      <div class="ts-opts" id="tsOpts"></div>
      <div id="tsReport" class="ts-report"></div>
      <div class="dlg-foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" id="tsCheck">Check file</button><button type="button" class="btn primary" id="tsUse" disabled>Use these data</button></div>
    </div>`;
    $$('[data-close]', d).forEach((b) => (b.onclick = () => d.close()));
    $('#tsCheck', d).onclick = () => check();
    $('#tsUse', d).onclick = () => use();
    const s = S;
    d.onclose = () => { if (S === s) S = null; };
    S.dlg = d;
    paintOpts();
    paintPreview();
    paintReport();
    if (!d.open) d.showModal();
    check();
  }

  const opts = (list, v) => list.map(([k, l, dis]) => `<option value="${escapeHtml(String(k))}"${String(k) === String(v) ? ' selected' : ''}${dis ? ' disabled' : ''}>${escapeHtml(l)}</option>`).join('');
  const colName = (i) => `${i + 1}${S.names[i] ? ': ' + S.names[i].slice(0, 28) : ''}`;
  const field = (key, label, control, wide) => `<div class="ts-f${wide ? ' wide' : ''}"><div class="ts-l"><span>${escapeHtml(label)}</span>${infoBtn(key, label)}</div>${
    control.replace('<select ', `<select aria-label="${escapeHtml(label)}" `)}</div>`;
  const sel = (o, list, v, dis) => `<select data-o="${o}"${dis ? ' disabled' : ''}>${opts(list, v)}</select>`;
  function paintOpts() {
    const o = S.opt, cols = Array.from({ length: S.ncol }, (_, i) => [i, colName(i)]), none = [[-1, 'None']];
    const timed = o.time_col >= 0, tz = P.location.tz || '', clock = clockOk(o.time_col) && timed;
    const years = [['auto', 'The year with most data']].concat(S.kind === 'load' ? [['last12', 'The last 12 months']] : [],
      ((S.res && S.res.report && S.res.report.years) || (S.years || [])).map(([y, h]) => [y, `${y} (${fmtNum(h)} h)`]));
    S.years = (S.res && S.res.report && S.res.report.years) || S.years;
    let h = field('import.time_col', 'Time column', sel('time_col', [[-1, 'None: one row per interval from 1 January']].concat(cols), o.time_col));
    h += field('import.time2_col', 'Time of day', sel('time2_col', [[-1, 'In the time column']].concat(cols.filter(([i]) => i !== o.time_col)), o.time2_col, !timed));
    h += field('import.date_order', 'Date order', sel('date_order', ORDERS, o.date_order, !timed));
    h += field('import.basis', 'Time basis', sel('basis', [['utc', 'UTC'], ['local_standard', `Local standard time (${fmtOffset(P.location.utc_offset)})`],
      ['local_clock', `Local clock time with daylight saving${tz ? ` (${tz})` : ''}`, !clock]], o.basis));
    h += field('import.label', 'Timestamps mark', sel('label', LABELS, o.label, !timed));
    h += field('import.year', 'Year', sel('year', years, o.year, !timed));
    if (S.kind === 'load') {
      h += field('import.units', 'Load unit', sel('units', LOAD_UNITS, o.units));
      h += field('import.cols', 'Load columns (summed)', `<div class="chips">${cols.filter(([i]) => i !== o.time_col && i !== o.time2_col).map(([i, l]) =>
        `<label class="check"><input type="checkbox" data-col="${i}"${o.cols.includes(i) ? ' checked' : ''}><span>${escapeHtml(l)}</span></label>`).join('')}</div>`, true);
    } else {
      for (const [k, l] of WX) h += field('import.wcols', l, sel(k, none.concat(cols), o[k]));
      h += field('import.irr_units', 'Irradiance unit', sel('irr_units', IRR_UNITS, o.irr_units));
      h += field('import.temp_units', 'Temperature unit', sel('temp_units', TEMP_UNITS, o.temp_units));
      h += field('import.wind_units', 'Wind speed unit', sel('wind_units', WIND_UNITS, o.wind_units));
    }
    const el = $('#tsOpts', S.dlg);
    el.innerHTML = h;
    $$('select[data-o]', el).forEach((s) => (s.onchange = () => {
      const k = s.dataset.o, v = s.value;
      o[k] = ['time_col', 'time2_col', ...WX.map((x) => x[0])].includes(k) ? +v : v;
      if (k === 'time_col') {
        o.time2_col = -1;
        if (o.time_col < 0 && o.basis === 'local_clock') o.basis = 'local_standard';
        if (S.kind === 'load') o.cols = o.cols.filter((c) => c !== o.time_col);
      }
      changed();
    }));
    $$('input[data-col]', el).forEach((c) => (c.onchange = () => {
      const i = +c.dataset.col;
      o.cols = c.checked ? [...new Set(o.cols.concat(i))].sort((a, b) => a - b) : o.cols.filter((x) => x !== i);
      changed();
    }));
  }
  function changed() {
    S.opt.fill_long = false;
    if (S.res || S.err) S.stale = true;
    paintOpts();
    paintPreview();
    paintReport();
  }
  function paintPreview() {
    const o = S.opt, vals = S.kind === 'load' ? o.cols : WX.map(([k]) => o[k]).filter((i) => i >= 0);
    const cls = (i) => (i === o.time_col || i === o.time2_col ? ' class="c-time"' : vals.includes(i) ? ' class="c-val"' : '');
    const rows = S.lines.map(cells), idx = Array.from({ length: S.ncol }, (_, i) => i);
    $('#tsPreview', S.dlg).innerHTML = `<table class="data"><tr><th>Row</th>${idx.map((i) => `<th${cls(i)}>${i + 1}</th>`).join('')}</tr>${rows.map((r, k) =>
      `<tr${k < S.hdr ? ' class="ts-hdr"' : ''}><td>${k + 1}</td>${idx.map((i) => `<td${cls(i)}>${escapeHtml((r[i] || '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  // Unit hints from the imported values: a load peak far from the genset fleet, implausible irradiance, temperature or wind.
  function unitHints(res) {
    const out = [];
    if (S.kind === 'load' && res.kw) {
      const peak = maxOf(res.kw), unit = +P.diesel.unit_kw || 0, fleet = (+P.diesel.units || 0) * unit, fits = (x) => x >= 0.2 * unit && x <= fleet;
      if (fleet > 0 && peak > fleet) out.push(`The peak load, ${fmtPower(peak)}, is above the genset fleet (${fmtPower(fleet)})${fits(peak / 1000) ? ': a file in W read as kW would do this (choose W)' : ''}.`);
      if (fleet > 0 && peak < 0.2 * unit) {
        const why = [];
        if (fits(peak * 4)) why.push('kWh per 15-min interval read as kW (four times too small)');
        if (fits(peak * 2)) why.push('kWh per 30-min interval read as kW (half)');
        if (fits(peak * 1000)) why.push('MW read as kW');
        out.push(`The peak load, ${fmtPower(peak)}, is below a fifth of one genset (${fmtPower(unit)})${why.length ? ': check the unit, for example ' + why.join(', or ') : ''}.`);
      }
    }
    if (S.kind === 'weather' && res.ghi) {
      const g = sum(res.ghi) / 1000, t = res.tamb && res.tamb.length ? sum(res.tamb) / res.tamb.length : null, w = res.wind && res.wind.length ? sum(res.wind) / res.wind.length : null;
      if (g < 700 || g > 2700) out.push(`Annual GHI is ${fmtNum(g)} kWh/m², outside 700–2,700 kWh/m²: check the irradiance unit (energy per interval read as W/m², or the reverse) and the GHI column.`);
      if (t != null && t > 150) out.push(`The mean temperature is ${fmtNum(t, 1)} °C: the column looks like kelvin.`);
      if (w != null && w > 20) out.push(`The mean wind speed is ${fmtNum(w, 1)} m/s: the column looks like km/h.`);
    }
    return out;
  }
  function runsText(R, n) {
    return (R.runs || []).slice(0, n).map(([h, len]) => `${dateOfHour(h)} ${String(h % 24).padStart(2, '0')}:00 (${len} h)`).join(', ') + ((R.runs || []).length > n ? ', …' : '');
  }
  // Import report as table rows [label, text]: rows read, interval, period, coverage, gaps.
  function reportRows(R) {
    const rows = [];
    if (R.positional) rows.push(['Rows', `${fmtNum(R.parsed)} values, one per ${R.interval_min} min from 1 January 00:00 (no time column)`]);
    else {
      rows.push(['Rows read', `${fmtNum(R.parsed)} of ${fmtNum(R.rows)}${R.header_lines ? `, after ${R.header_lines} header line${R.header_lines > 1 ? 's' : ''}` : ''}`]);
      if (R.n_bad) rows.push(['Rows not read', `${fmtNum(R.n_bad)} without a readable time or value (lines ${R.bad_rows.join(', ')}${R.n_bad > R.bad_rows.length ? ', …' : ''})`]);
      if (R.duplicates) rows.push(['Duplicate stamps', `${fmtNum(R.duplicates)}, averaged`]);
      if (R.out_of_order) rows.push(['Out of order', `${fmtNum(R.out_of_order)} rows, sorted`]);
      rows.push(['Interval', `${R.interval_min} min, stamps mark ${LABEL_TEXT[R.label] || R.label}; dates ${R.excel ? 'as Excel serial days' : { ymd: 'year, month, day', dmy: 'day, month, year', mdy: 'month, day, year' }[R.date_order] || ''}`]);
      (R.rate_changes || []).forEach((c) => rows.push(['Other interval', `${c.interval_min} min in ${fmtNum(c.rows)} steps${c.ranges.length ? ': ' + c.ranges.map(([a, b]) => `${a} to ${b}`).join('; ') : ''}`]));
      rows.push([`First and last sample (${R.base})`, `${R.first} to ${R.last}`]);
    }
    rows.push(['Period used', R.period]);
    rows.push(['Coverage', `${fmtPct(R.coverage)} of the 8,760 h`]);
    rows.push(['Missing hours', R.missing_h ? `${fmtNum(R.missing_h)} (below half covered)${R.runs && R.runs.length ? ': ' + runsText(R, 6) : ''}` : 'none']);
    if (R.missing && Object.keys(R.missing).length > 1) rows.push(['Missing by column', Object.entries(R.missing).map(([k, v]) => `${k.toUpperCase()} ${fmtNum(v)} h`).join(', ')]);
    rows.push(['Filled hours', `${fmtNum(R.filled_h)}, longest gap ${fmtNum(R.max_gap_h)} h`]);
    return rows;
  }
  function paintReport() {
    const el = $('#tsReport', S.dlg), use = $('#tsUse', S.dlg), res = S.res;
    use.disabled = !res || S.stale || (S.kind === 'load' && !res.kw);
    if (S.stale) { el.innerHTML = '<p class="status">The options changed: check the file again.</p>'; return; }
    if (S.err) { el.innerHTML = `<div class="warnbox">${escapeHtml(S.err)}</div>`; return; }
    if (!res) { el.innerHTML = '<p class="status">Reading the file…</p>'; return; }
    const R = res.report, warn = [];
    if (res.long_gap) warn.push(`No load for ${fmtNum(res.long_gap.hours)} h in a row from ${escapeHtml(res.long_gap.from)}: gaps over 72 h are not filled unless you ask for it. <button type="button" class="btn small" id="tsFill">Fill long gaps from adjacent weeks</button>`);
    if (R.dst_suspect) warn.push(`One hour is missing in spring and one doubled in autumn: the file looks like clock time with daylight saving. Choose <b>Local clock time with daylight saving</b>${clockOk(S.opt.time_col) ? '' : ' (set the site first, on Site &amp; layout, so its time zone is known)'}.`);
    if (R.clock_skipped) warn.push(`${fmtNum(R.clock_skipped)} stamps fall in the hour skipped when the clocks went forward; they were read with the offset before the change.`);
    unitHints(res).forEach((t) => warn.push(escapeHtml(t)));
    el.innerHTML = `<h3>Import report</h3><table class="data ts-rep">${reportRows(R).map(([l, v]) => `<tr><td>${escapeHtml(l)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
      ${(R.notes || []).map((n) => `<p class="hint">${escapeHtml(n)}</p>`).join('')}
      ${warn.map((w) => `<div class="warnbox">${w}</div>`).join('')}`;
    const fill = $('#tsFill', el);
    if (fill) fill.onclick = () => { S.opt.fill_long = true; check(); };
    if (S.years !== R.years && R.years) paintOpts();
  }
  async function check() {
    if (!S) return;
    const s = S, b = $('#tsCheck', s.dlg), sent = clone(s.opt);   // the options as sent: they stay editable while the file is read
    s.stale = false; s.err = ''; s.res = null;
    paintReport();
    b.disabled = true;
    try {
      const res = await api('/api/import-series', { text: s.text, options: engineOpt() });
      if (S !== s) return;
      s.res = res;
      s.sent = sent;
    } catch (e) { if (S === s) s.err = e.message; }
    finally { b.disabled = false; }
    if (S !== s) return;
    if (JSON.stringify(s.opt) !== JSON.stringify(sent)) s.stale = true;   // options changed while the file was read
    paintReport();
  }
  function importInfo(res) {
    const o = S.sent, R = res.report;
    return { file: S.file, interval_min: R.interval_min, label: R.label, basis: o.basis,
             units: S.kind === 'load' ? o.units : { irradiance: o.irr_units, temperature: o.temp_units, wind: o.wind_units }, report: R };
  }
  async function use() {
    const s = S, res = s && s.res;
    if (!res || s.stale) return;
    const R = res.report, info = importInfo(res), what = `${R.period}, ${fmtPct(R.coverage)} covered${R.filled_h ? `, ${fmtNum(R.filled_h)} h filled` : ''}`;
    s.dlg.close();
    if (s.kind === 'load') {
      P.load.kw = res.kw; P.load.source = 'csv'; P.load.import = info; P.load.qc = null;
      setStatus('#loadStatus', `✓ Loaded ${s.file} (${what}). Measured profile: template settings are ignored until you press Generate.`, 'ok');
      drawLoad(); updateChecks(); autosave();
      await runQc('load');
    } else {
      P.weather = { source: 'CSV: ' + s.file, is_utc: res.is_utc, time_offset: res.time_offset, ghi: res.ghi, dni: res.dni, dhi: res.dhi, tamb: res.tamb, wind: res.wind,
                    note: `User file, ${what}.`, import: info };
      P.weather_ui.is_utc = !!res.is_utc;
      syncForms(P);
      setStatus('#wxStatus', `✓ Loaded ${s.file} (${what})`, 'ok');
      PVR = null; PVREF = null; drawWeather(); updateChecks(); autosave();
      await runQc('weather');
    }
  }

  // ---------------------------------------------------------------- data checks
  // /api/data-qc for one data set; the result is kept only while the data are still the ones checked. A measured load only.
  async function runQc(only) {
    const W = P.weather, kw = P.load.kw;
    if (only === 'weather' ? !(W && W.ghi) : !(kw && P.load.source === 'csv')) return;
    try {
      const r = await api('/api/data-qc', { project: engineProject(), only });
      if (only === 'weather' && P.weather === W) { W.qc = r.weather; drawWeather(); autosave(); }
      if (only === 'load' && P.load.kw === kw) { P.load.qc = r.load; drawLoad(); autosave(); }
    } catch (e) { toast('Data checks: ' + e.message, true); }
  }
  const qcTimers = {};
  // Checks again shortly after the inputs they depend on change (site for the timing, genset fleet for the load unit check).
  function qcLater(only) { clearTimeout(qcTimers[only]); qcTimers[only] = setTimeout(() => runQc(only), 600); }

  // The timing check as text: {text, fix: [[label, action, argument]]}.
  function timing(T, W) {
    if (!T || T.median_min == null || T.verdict === 'none') return { text: `Too few clear days (${T ? T.n_days : 0}) to check the timestamps against the sun.`, fix: [], ok: true };
    const m = T.median_min, k = T.shift_h || 0;
    const base = `On ${T.n_days} clear days the irradiance peaks ${fmtNum(Math.abs(m), 0)} min ${m >= 0 ? 'later' : 'earlier'} than the sun (median; interquartile range ${fmtNum(T.iqr_min, 0)} min)`;
    const clock = T.clock_change ? ` The monthly medians differ by ${fmtNum(T.month_spread_min, 0)} min: the logger clock may have changed during the year.` : '';
    switch (T.verdict) {
      case 'ok': return { text: `${base}: the timestamps match the sun.${clock}`, fix: [], ok: !clock };
      // data late by half an hour are samples at the hour starts: each hour is the mean of its own sample and the next (early: the previous)
      case 'half': return { text: `${base}: instantaneous samples read as hour means, or the reverse.${clock}`, fix: [['Treat as instantaneous samples', 'instant', m > 0 ? 1 : -1]] };
      case 'hours': return { text: `${base}: ${Math.abs(k) > 1 ? `a clock error of ${Math.abs(k)} h` : `${k > 0 ? 'interval-end stamps read as interval-start' : 'interval-start stamps read as interval-end'}, or a clock error of 1 h`}.${clock}`,
        fix: [[`Shift ${Math.abs(k)} h ${k > 0 ? 'earlier' : 'later'}`, 'shift', k]] };
      case 'utc': return { text: `${base}: about the UTC offset of the site, so the timestamps are ${W && W.is_utc ? 'local time, not UTC' : 'UTC, not local time'}.${clock}`,
        fix: [[`Timestamps are ${W && W.is_utc ? 'local time' : 'UTC'}`, 'utc', 0]] };
      default: return { text: `${base}: this matches no known timing error; check the timestamps.${clock}` , fix: [] };
    }
  }
  // Notes on the whole data set (absent columns, annual GHI, units, level shifts).
  function setNotes(kind, Q) {
    return (Q && Q.set || []).map((s) => {
      if (s.id === 't_absent') return s.value == null ? 'No temperature data.' : `No temperature data: ${fmtNum(s.value, 1)} °C in every hour (module temperature and the battery auxiliaries follow it).`;
      if (s.id === 'wind_absent') return s.value == null ? 'No wind speed data: the module temperature assumes 1 m/s and wind turbines produce nothing.' : `Wind speed is ${fmtNum(s.value, 1)} m/s in every hour.`;
      if (s.id === 'ghi_annual') return `Annual GHI is ${fmtNum(s.kwh_m2)} kWh/m², outside 700–2,700 kWh/m²: check the irradiance unit and the interval.`;
      if (s.id === 'units') {
        const H = { w: 'a file in W read as kW', kwh_15min: 'kWh per 15-min interval read as kW (×4)', kwh_30min: 'kWh per 30-min interval read as kW (×2)', mw: 'MW read as kW (×1,000)' };
        return `The peak load, ${fmtPower(s.peak_kw)}, is ${s.above ? `above the genset fleet (${fmtPower(s.fleet_kw)})` : `below a fifth of one genset (${fmtPower(s.unit_kw)})`}${s.hints.length ? ': ' + s.hints.map((h) => H[h] || h).join(', or ') + ' would do this; import the file again with the right unit' : ''}.`;
      }
      if (s.id === 'level_shift') return 'Level shift' + (s.shifts.length > 1 ? 's' : '') + ' of the daily mean load: ' + s.shifts.map((x) =>
        `${dateOfHour(x.day * 24)} from ${fmtPower(x.before_kw)} to ${fmtPower(x.after_kw)} (${x.after_kw >= x.before_kw ? '+' : '−'}${fmtNum(Math.abs(x.after_kw / x.before_kw - 1) * 100, 0)} %)`).join('; ') +
        '. A new process or a meter change; use the period that represents the future load.';
      return s.id;
    });
  }
  const SHORT = { night: 'Irradiance at night', dropout: 'Zero GHI in daylight', ghi_limit: 'GHI above the limit', dhi_limit: 'DHI above the limit', dhi_gt_ghi: 'DHI above GHI',
                  flat_ghi: 'GHI stuck', copy_ghi: 'GHI repeated', t_range: 'Temperature out of range', t_step: 'Temperature step', flat_t: 'Temperature stuck',
                  copy_t: 'Temperature repeated', wind_range: 'Wind speed out of range', flat_wind: 'Wind speed stuck', outage: 'Near-zero load', flat: 'Load stuck',
                  linear: 'Linear infill', spike: 'Spike' };
  const FLAG_UNIT = { dhi_limit: 'W/m²', dhi_gt_ghi: 'W/m²', t_range: '°C', t_step: '°C', flat_t: '°C', copy_t: '°C', wind_range: 'm/s', flat_wind: 'm/s' };
  const unitOf = (kind, id) => (kind === 'load' ? 'kW' : FLAG_UNIT[id] || 'W/m²');
  const hourText = (h) => `${dateOfHour(h)} ${String(h % 24).padStart(2, '0')}:00`;
  // One line on the imported file (or the downloaded weather) for the page.
  function sourceLine(kind) {
    const D = kind === 'load' ? P.load : P.weather, I = D && D.import, R = I && I.report;
    if (!R) return kind === 'weather' && D ? `${D.source || 'Weather'}${D.years ? ', ' + D.years : ''}${D.n_filled ? `: ${fmtNum(D.n_filled)} h filled, longest gap ${fmtNum(D.max_gap_h)} h` : ''}.` : '';
    return `Imported from ${I.file}: ${R.interval_min}-min data, stamps mark ${LABEL_TEXT[I.label] || I.label}, ${BASIS_TEXT[I.basis] || I.basis}; ${R.period}, ${fmtPct(R.coverage)} covered, ${fmtNum(R.filled_h)} h filled, longest gap ${fmtNum(R.max_gap_h)} h.`;
  }
  // The Data checks block under the annual summary (weather) or the load statistics (a measured load).
  function pageHtml(kind) {
    const D = kind === 'load' ? P.load : P.weather;
    if (!D || (kind === 'load' && (P.load.source !== 'csv' || !P.load.kw))) return '';
    const Q = D.qc, line = sourceLine(kind);
    let h = `<h3 class="mt">Data checks${infoBtn('qc.' + kind, 'Data checks')}</h3>${line ? `<p class="hint">${escapeHtml(line)}</p>` : ''}`;
    if (!Q) return h + `<p class="hint">Not run for these data. <button type="button" class="btn small" data-qc-run="${kind}">Run data checks</button></p>`;
    const fl = Q.flags.filter((f) => f.hours > 0), weather = kind === 'weather';
    h += fl.length ? `<div class="table-wrap"><table class="data qc-table"><tr><th>Flag</th><th>Hours</th><th>Days</th>${weather ? '<th>Share of GHI</th>' : ''}</tr>${fl.map((f) =>
      `<tr><td>${escapeHtml(f.label)}</td><td>${fmtNum(f.hours)}</td><td>${fmtNum(f.days)}</td>${weather ? `<td>${fmtPct(f.ghi_share, 2)}</td>` : ''}</tr>`).join('')}</table></div>
      <p class="hint">${fmtNum(Q.n_flagged)} h flagged on ${days(Q.days.length)} (outlined in the heatmap below); ${fmtPct(Q.score)} of the days have no flag${weather ? `, and the flagged hours hold ${fmtPct(Q.ghi_share, 2)} of the year's GHI` : ''}. Flags only inform: the data are used as they are.</p>`
      : '<p class="hint">No hour flagged.</p>';
    setNotes(kind, Q).forEach((t) => (h += `<p class="hint">${escapeHtml(t)}</p>`));
    if (weather) {
      const T = timing(Q.timing, D);
      h += `<div class="${T.ok ? 'hint' : 'warnbox'} qc-timing">${escapeHtml(T.text)}${T.fix.map(([l, a, x]) => ` <button type="button" class="btn small" data-fix="${a}" data-arg="${x}">${escapeHtml(l)}</button>`).join('')}</div>`;
    }
    if (Q.hours.length) h += `<details class="qc-hours"><summary>Flagged hours${Q.n_list > Q.hours.length ? ` (the first ${Q.hours.length} of ${fmtNum(Q.n_list)})` : ''}</summary><div class="table-wrap"><table class="data"><tr><th>Local time</th><th>Flag</th><th>Value</th></tr>${
      Q.hours.map((x) => `<tr><td>${hourText(x.h)}</td><td>${escapeHtml(SHORT[x.flag] || x.flag)}</td><td>${fmtNum(x.v, 1)} ${unitOf(kind, x.flag)}</td></tr>`).join('')}</table></div></details>`;
    return h;
  }
  function wire(el) {
    $$('[data-qc-run]', el).forEach((b) => (b.onclick = () => { b.disabled = true; runQc(b.dataset.qcRun); }));
    $$('[data-fix]', el).forEach((b) => (b.onclick = () => fix(b.dataset.fix, +b.dataset.arg)));
  }
  // Timing fixes of the weather: roll every series by k hours (k > 0: earlier), take each hour as the mean of instantaneous
  // samples at its two ends (s = +1: this hour and the next; -1: the previous), or toggle the UTC flag.
  function fix(what, x) {
    const W = P.weather;
    if (!W) return;
    const keys = ['ghi', 'dni', 'dhi', 'tamb', 'wind'].filter((k) => Array.isArray(W[k]) && W[k].length === HOURS), at = (v, i) => v[((i % HOURS) + HOURS) % HOURS];
    let done;
    if (what === 'shift') { keys.forEach((k) => { const v = W[k]; W[k] = v.map((_, i) => at(v, i + x)); }); done = `shifted ${Math.abs(x)} h ${x > 0 ? 'earlier' : 'later'}`; }
    else if (what === 'instant') { keys.forEach((k) => { const v = W[k]; W[k] = v.map((y, i) => (y + at(v, i + x)) / 2); }); done = `each hour taken as the mean of the samples at its start and end`; }
    else { W.is_utc = !W.is_utc; P.weather_ui.is_utc = W.is_utc; syncForms(P); done = `timestamps taken as ${W.is_utc ? 'UTC' : 'local standard time'}`; }
    W.note = `${W.note || ''} After the data checks: ${done}.`.trim();
    W.qc = null;
    setStatus('#wxStatus', `✓ Weather ${done}.`, 'ok');
    PVR = null; PVREF = null; drawWeather(); updateChecks(); autosave();
    runQc('weather');
  }

  // ---------------------------------------------------------------- report and workbook
  // Data quality of the weather or a measured load for the report: [label, value] rows, flag rows [label, hours, days, share of
  // GHI] and notes; null without such data.
  function quality(kind) {
    const D = kind === 'load' ? P.load : P.weather;
    if (!D || (kind === 'load' ? P.load.source !== 'csv' || !P.load.kw : !D.ghi)) return null;
    const I = D.import, R = I && I.report, Q = D.qc, rows = [];
    rows.push(['Source', I ? I.file : kind === 'weather' ? D.source || '' : 'Measured profile (CSV)']);
    if (R) {
      rows.push(['Interval', `${R.interval_min} min, stamps mark ${LABEL_TEXT[I.label] || I.label}, ${BASIS_TEXT[I.basis] || I.basis}`], ['Period', R.period],
        ['Coverage', fmtPct(R.coverage)], ['Filled hours', fmtNum(R.filled_h)], ['Longest gap', fmtNum(R.max_gap_h) + ' h']);
      if (R.duplicates || R.out_of_order || R.n_bad) rows.push(['Rows', `${fmtNum(R.duplicates || 0)} duplicate stamps averaged, ${fmtNum(R.out_of_order || 0)} out of order, ${fmtNum(R.n_bad || 0)} not read`]);
    } else if (kind === 'weather') {
      rows.push(['Interval', '60 min'], ['Period', D.years || '–']);
      if (D.n_filled != null) rows.push(['Filled hours', fmtNum(D.n_filled)], ['Longest gap', fmtNum(D.max_gap_h || 0) + ' h']);
    }
    const fl = Q ? Q.flags.filter((f) => f.hours > 0) : [];
    rows.push(['Flags', !Q ? 'data checks not run' : fl.length ? `${fmtNum(Q.n_flagged)} h on ${days(Q.days.length)}; ${fmtPct(Q.score)} of the days without a flag` : 'none']);
    const T = Q && kind === 'weather' ? timing(Q.timing, D) : null;
    if (T) rows.push(['Timing', T.text]);
    return { rows, flags: fl.map((f) => [f.label, fmtNum(f.hours), fmtNum(f.days), kind === 'weather' ? fmtPct(f.ghi_share, 2) : null]), notes: setNotes(kind, Q), timingOk: !T || T.ok };
  }
  // Workbook rows: one per flagged hour of each data set (data set, hour, local date, flag, value), then the flag counts.
  function sheetRows() {
    const sets = [['Weather', P.weather && P.weather.qc, 'weather'], ['Load', P.load.source === 'csv' && P.load.qc, 'load']].filter((x) => x[1]);
    if (!sets.length) return null;
    const rows = [['Data set', 'Hour of the year (local)', 'Local date and hour', 'Flag', 'Value', 'Unit']], tail = [[], ['Data set', 'Flag', 'Hours', 'Days', 'Share of GHI']];
    for (const [name, Q, kind] of sets) {
      const label = Object.fromEntries(Q.flags.map((f) => [f.id, f.label]));
      Q.hours.forEach((x) => rows.push([name, x.h, hourText(x.h), label[x.flag] || x.flag, x.v, unitOf(kind, x.flag)]));
      if (Q.n_list > Q.hours.length) rows.push([name, null, null, `The first ${Q.hours.length} of ${Q.n_list} flagged hours are listed`]);
      Q.flags.forEach((f) => tail.push([name, f.label, f.hours, f.days, kind === 'weather' ? f.ghi_share : null]));
      tail.push([name, 'Days without a flag', null, 365 - Q.days.length]);
      setNotes(kind, Q).forEach((t) => tail.push([name, 'Note', t]));
      if (kind === 'weather') tail.push([name, 'Timing', timing(Q.timing, P.weather).text]);
    }
    return rows.concat(tail);
  }

  return { open, runQc, qcLater, pageHtml, wire, quality, sheetRows };
})();
