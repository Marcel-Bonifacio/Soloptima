// Report & export: standalone HTML engineering report (print to PDF) and an Excel .xlsx workbook.
'use strict';

const Report = (() => {
  // ------------------------------------------------------------------ minimal XLSX writer (stored ZIP)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {   // files: [{name, data: Uint8Array}]
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff], u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
      const head = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(n), ...u32(n), ...u16(name.length), ...u16(0)]);
      parts.push(head, name, f.data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(n), ...u32(n), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += head.length + name.length + n;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xesc = (s) => escapeHtml(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  function sheetXml(rows) {
    const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>'], refs = [];
    rows.forEach((r, ri) => {
      out.push(`<row r="${ri + 1}">`);
      r.forEach((v, ci) => {
        if (v == null || v === '') return;
        const ref = (refs[ci] || (refs[ci] = colName(ci))) + (ri + 1), s = ri === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && isFinite(v)) out.push(`<c r="${ref}"${s}><v>${+v.toPrecision(12)}</v></c>`);
        else if (typeof v === 'boolean') out.push(`<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`);
        else out.push(`<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`);
      });
      out.push('</row>');
    });
    out.push('</sheetData></worksheet>');
    return out.join('');
  }
  function xlsx(sheets) {   // sheets: [{name, rows: [[...]]}]
    const enc = new TextEncoder(), f = (name, s) => ({ name, data: enc.encode(s) });
    const names = sheets.map((s, i) => (s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)) || 'Sheet' + (i + 1));
    return zip([
      f('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
      f('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      f('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
      f('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
      f('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'),
      ...sheets.map((s, i) => f(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows))),
    ]);
  }

  // ------------------------------------------------------------------ results from other inputs
  // A simulation from other inputs is run again before an export when that is quick (rule-based dispatch, about a second); a
  // predictive run takes much longer, so its report and workbook say which inputs changed instead (staleNote).
  async function freshSim() {
    if (!simStale() || P.diesel.strategy === 'predictive') return;
    toast('The inputs changed after the last simulation: simulating again…');
    await runSim(true);
  }
  function staleNote() {
    if (!simStale()) return '';
    const list = simChanges(12);
    return `These results were computed before ${list ? 'the following inputs changed: ' + list : 'the inputs changed'}. Run the simulation again before issuing this report.`;
  }

  // ------------------------------------------------------------------ workbook sheets
  function workbookSheets() {
    const cur = P.econ.currency, sheets = [];
    const summary = [['Item', 'Value', 'Unit']];
    summary.push(['Project', P.name, ''], ['Latitude', P.location.lat, '°'], ['Longitude', P.location.lon, '°'], ['UTC offset', P.location.utc_offset, 'h'],
      ['Time zone', P.location.tz || '', ''], ['Exported', new Date().toISOString(), '']);
    if (SIM) {
      // sizes from the run, as the results; the genset fleet is not part of it (the note covers a change)
      const R = SIM.result, C = SIM.comparison, y = R.years[0], Z = R.size, note = staleNote();
      if (note) summary.push(['Note', note, '']);
      summary.push(['PV capacity', Z.pv_kwp, 'kWp'], ['BESS energy', Z.bess_kwh, 'kWh'], ['BESS power', Z.bess_kw, 'kW'], ['Gensets', `${P.diesel.units} x ${P.diesel.unit_kw}`, 'kW'],
        ['Renewable fraction (yr 1)', R.re_fraction, '-'], ['Fuel (yr 1)', y.fuel_l, 'L'], ['Fuel saved vs diesel-only (yr 1)', C.fuel_saved_l_y1, 'L'],
        ['LCOE', R.econ.lcoe, cur + '/kWh'], ['LCOE diesel-only', C.lcoe_base, cur + '/kWh'], ['NPC', R.econ.npc, cur], ['NPV of savings', C.npv_savings, cur],
        ['IRR', C.irr, '-'], ['Payback', C.payback_years, 'yr'], ['Capex', R.econ.capex_total, cur], ['PV curtailment', R.curtail_fraction, '-'], ['Unmet load', R.unmet_fraction, '-'],
        ['CO2 avoided (yr 1)', C.co2_saved_t_y1, 't'], ['Auxiliary consumption (yr 1)', y.aux || 0, 'kWh'], ['Unmet load, worst year', R.unmet_fraction_max, '-'],
        ['Loss-of-load hours (yr 1)', y.lol_h, 'h'], ['Loss-of-load events (yr 1)', y.lol_events, ''], ['Reserve shortfall (yr 1)', y.reserve_short_h, 'h'],
        ['Reserve shortfall diesel-only (yr 1)', SIM.baseline.years[0].reserve_short_h, 'h'], ['Most gensets online (yr 1)', y.max_units, ''],
        ['Most gensets online diesel-only (yr 1)', SIM.baseline.years[0].max_units, ''], ['Hours at minimum loading (yr 1)', y.minload_h, 'h']);
      const V = SIM.pv_only, CB = SIM.comparison_bess, vl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only';
      if (V && CB) summary.push([`NPC without the battery (${vl})`, V.econ.npc, cur], [`NPV of the battery vs ${vl}`, CB.npv_savings, cur],
        [`IRR of the battery vs ${vl}`, CB.irr, '-'], [`Fuel saved by the battery vs ${vl} (yr 1)`, CB.fuel_saved_l_y1, 'L']);
      if (R.metrics) for (const [k, v] of Object.entries(R.metrics)) summary.push([k, v, '']);
    }
    sheets.push({ name: 'Summary', rows: summary });
    sheets.push({ name: 'Inputs', rows: [['Parameter', 'Value']].concat(flatten({ location: P.location, pv: P.pv, bess: P.bess, aux: P.aux, diesel: P.diesel, wind: P.wind, ems: P.ems, econ: P.econ, sim: P.sim, electrical: P.electrical, site_records: P.site_records })) });
    const eqRows = [['Type', 'Field', 'Value']];
    for (const t of ['pv', 'inverter', 'battery', 'genset']) { const e = Equipment.selected(t); if (e) Object.entries(e).forEach(([k, v]) => eqRows.push([t, k, v])); }
    sheets.push({ name: 'Equipment', rows: eqRows });
    const LY = layoutRows();
    if (LY) sheets.push({ name: 'Layout', rows: LY });
    const D = Electrical.design;
    if (D) {
      const rows = [['Circuit', 'Count', 'Cable', 'Parallel runs', 'Length m', 'Design current A', 'Rating A', 'Utilisation', 'Voltage drop', 'Loss at rated kW', 'Annual loss kWh', 'Cost ' + cur]];
      D.circuits.forEach((c) => rows.push([c.name, c.count, c.cab ? c.cab.name : '', c.runs, c.L, c.I, c.amp, c.util, c.dv, c.ploss != null ? c.ploss * c.count : null, c.annual, c.cost]));
      rows.push([]);
      rows.push(['Transformer role', 'Units', 'Type', 'kVA', 'Peak loading', 'No-load loss kWh/yr', 'Load loss kWh/yr']);
      D.trafos.forEach((t) => rows.push([t.role, t.n, t.t.name, t.t.kva, t.loading, t.noLoad, t.loadLoss]));
      if (D.str) {
        const s = D.str;
        rows.push([]);
        rows.push(['String sizing', 'Value', 'Unit']);
        rows.push(['Modules per string', s.ns, ''], ['Allowed modules per string, min', s.nMin, ''], ['Allowed modules per string, max', Math.min(s.nMax, s.nMppt), ''],
          ['Site minimum temperature', D.tmin, '°C'], ['Max cell temperature', s.tHot, '°C'], ['Thermal model P99.9 cell temperature', s.tModel, '°C'],
          ['Voc at site minimum', s.vocMax, 'V'], ['Vmp at max cell temperature', s.vmpHot, 'V'], ['Vmp at site minimum', s.vmpCold, 'V'],
          ['Temp. coeff. Vmp', s.bVmp, '%/°C'], ['Temp. coeff. Vmp source', s.bVmpSrc, ''], ['Strings', s.nStrings, ''], ['Inverters', s.nInv, ''], ['DC capacity (built)', s.kwp, 'kWp']);
      }
      sheets.push({ name: 'Electrical', rows });
    }
    if (P.resource_years && P.resource_years.result) {
      const S = resourceYearsSummary(), X = S.X, b = X.budget || {};
      const cols = [['year', 'Weather year'], ['sy', 'Specific yield kWh/kWp'], ['ghi', 'GHI kWh/m²'], ['poa', 'Plane of array kWh/m²'], ['re', 'RE fraction'], ['curtail', 'Curtailment'],
        ['unmet', 'Unmet load'], ['fuel_hyb', 'Fuel hybrid L'], ['fuel_base', 'Fuel diesel only L'], ['fuel_saved', 'Fuel saved L'], ['avoided_cost', 'Avoided diesel cost ' + cur],
        ['re_kwh', 'RE served kWh'], ['revenue', 'Revenue yr 1 ' + cur], ['npv_savings', 'NPV of savings ' + cur]];
      const rows = [cols.map((c) => c[1])];
      X.years.forEach((y) => rows.push(cols.map(([k]) => y[k])));
      const st = fmtNum(X.step * 100, 2);
      [['Project weather (P50)', X.anchor], [`Project weather, irradiance +${st} %`, X.plus], [`Project weather, irradiance −${st} %`, X.minus]]
        .forEach(([l, y]) => rows.push([l].concat(cols.slice(1).map(([k]) => y[k]))));
      const unit = { yield: 'kWh/kWp', fuel_saved: 'L', re: '-', revenue: cur, fuel_used: 'L', avoided_cost: cur };
      rows.push([], ['Result', 'Unit', 'P50', 'Multi-year mean', 'Inter-annual σ', 'σ 1 yr', 'σ 10 yr', 'Elasticity', 'P75 1 yr', 'P90 1 yr', 'P99 1 yr', 'P90 10 yr', 'Worst year', 'Worst year value']);
      S.rows.concat([{ k: 'avoided_cost', label: 'Avoided diesel cost', ...X.stats.avoided_cost }]).forEach((r) => rows.push([r.label, unit[r.k], r.p50, r.mean, r.sigma_iav, r.sigma_1, r.sigma_10,
        r.elasticity, r.p75_1, r.p90_1, r.p99_1, r.p90_10, r.worst_year, r.worst]));
      rows.push([], ['Database', `${X.database} ${X.range.from}–${X.range.to}`], ['P50 weather', X.weather || ''],
        ['Project weather vs multi-year mean', S.dev, 'specific yield, P50 ÷ multi-year mean − 1'], ['Systematic uncertainty σ', X.sigma_sys],
        ['Dataset / model / soiling and availability', `${b.dataset} / ${b.model} / ${b.soiling}`], ['Revenue P90 ÷ P50, one year', S.f1], ['Revenue P90 ÷ P50, 10-year average', S.f10],
        ['Debt sizing factor (Project finance)', P.finance.p90_factor, S.applied ? `from this run, ${S.applied.basis === 10 ? '10-year average' : 'one year'}` : 'typed'],
        ['Basis', 'year 1 of the plant per weather year; spread used as ratios around P50; 10-year values assume independent years']);
      if (S.devWarn) rows.push(['Note', S.devWarn]);
      if (X.note) rows.push(['Note', X.note]);
      if (S.stale) rows.push(['Note', 'The inputs changed after this run; run it again.']);
      sheets.push({ name: 'Resource years', rows });
    }
    const DQ = TsImport.sheetRows();
    if (DQ) sheets.push({ name: 'Data quality', rows: DQ });
    const PB = pvBalance();
    if (PB) {
      const kwp = P.pv.capacity_kwp, rows = [['Month', 'GlobHor kWh/m²', 'DiffHor kWh/m²', 'T_amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²', 'EArray kWh/kWp', 'E_avail kWh/kWp',
        'EArray MWh', 'E_avail MWh', 'PR', 'Yr kWh/kWp/day', 'Ya kWh/kWp/day', 'Yf kWh/kWp/day', 'Lc kWh/kWp/day', 'Ls kWh/kWp/day'].concat(PB.sim ? ['Lu kWh/kWp/day', 'PR delivered'] : [])];
      PB.rows.forEach((x) => rows.push([x.label, x.ghi, x.dhi, x.tamb, x.poa, x.eff, x.earray, x.eavail, x.earray * kwp / 1000, x.eavail * kwp / 1000, x.pr, x.yr, x.ya, x.yf,
        x.yr - x.ya, x.ya - x.yf].concat(PB.sim ? [x.lu / x.days, x.prUsed] : [])));
      rows.push([], ['PV capacity', kwp, 'kWp']);
      if (PVREF) {
        rows.push([], ['PVGIS reference', 'PVGIS kWh/kWp', 'Soloptima comparable kWh/kWp']);
        MONTHS.forEach((m, i) => rows.push([m, PVREF.pvgis_em[i], PVREF.soloptima_em[i]]));
        rows.push(['Year', PVREF.pvgis_ey, PVREF.soloptima_ey], ['Difference', PVREF.diff, '(Soloptima − PVGIS) ÷ PVGIS'], ['PVGIS system loss', PVREF.loss_pct / 100, ''],
          ['PVGIS data', `${PVREF.radiation_db} ${PVREF.year_min}–${PVREF.year_max}`, ''],
          ['Basis', 'comparable yield without row shading and inverter clipping; PVGIS uses its own thermal and spectral models', '']);
      }
      sheets.push({ name: 'PV monthly', rows });
    }
    if (SIM) {
      const R = SIM.result, y = R.years[0], F = energyFlow(y);
      const rows = [['Month', 'Load kWh', 'PV direct kWh', 'Wind direct kWh', 'Battery to load kWh', 'Diesel to load kWh', 'Diesel to battery kWh', 'Unmet kWh', 'RE curtailed kWh',
        'Genset dump kWh', 'Fuel L', 'RE fraction']];
      monthBalance(R).forEach((x) => rows.push([x.label, x.load, x.pv, x.wind, x.bess, x.gen, x.gch, x.unmet, x.curt, x.dump, x.fuel, x.re]));
      rows.push([], ['Energy flow (yr 1)', 'kWh', '']);
      [['PV available', y.pv_avail], ['PV to load', y.pv_to_load], ['PV to battery', y.pv_to_bess], ['PV curtailed', y.pv_curtailed],
        ['Wind available', y.wind_avail], ['Wind to load', y.wind_to_load], ['Wind to battery', y.wind_to_bess], ['Wind curtailed', y.wind_curtailed],
        ['Genset energy', y.gen_kwh], ['Genset to load', y.gen_to_load], ['Genset to battery', y.gen_to_bess], ['Genset dump', y.gen_dump],
        ['Battery charged', y.bess_ch], ['Battery discharged', y.bess_dis], ['Battery losses', F.loss], ['Self-discharge', y.self_discharge],
        ['Stored energy, start of year', y.e_start], ['Stored energy, end of year', y.e_end], ['Unmet', y.unmet], ['Load', y.load], ['Auxiliaries', F.aux], ['Site load', y.load - F.aux],
        ['Direct RE share', F.direct], ['Inputs − outputs', F.gap]].forEach((r) => rows.push(r));
      sheets.push({ name: 'Energy monthly', rows });
    }
    const K = calibration();
    if (K) {
      const rows = [['Record', 'Unit', 'Site', 'Model', 'Difference', 'Tolerance', 'Flag']];
      K.rows.forEach((x) => rows.push([x.label, x.unit, x.site, x.model, x.d, x.tol, x.flag ? 'beyond tolerance' : 'within tolerance']));
      if (K.monthly) {
        rows.push([], ['Month', 'Site fuel L', 'Model fuel L', 'Difference']);
        K.months.forEach((x) => rows.push([x.label, x.site, x.model, x.d]));
        rows.push(['CV(RMSE)', K.cv, '', '', `over the ${K.nMonths} months with a record`]);
      }
      rows.push([], ['Source', K.recs.source], ['Period', K.recs.period], ['Scope', K.recs.scope],
        ['Basis', 'diesel-only case of the last simulation, year 1, without auxiliary loads; difference = model ÷ site − 1'],
        ['Fuel saved change per 1 % of baseline fuel error', K.lever, '%']);
      K.diag.forEach((t) => rows.push(['Diagnosis', t]));
      if (K.monthNote) rows.push(['Note', K.monthNote]);
      sheets.push({ name: 'Baseline check', rows });
    }
    if (SIM) {
      const R = SIM.result, keys = ['year', 'load', 'aux', 'served', 'served_site', 'unmet', 'pv_avail', 'pv_to_load', 'pv_to_bess', 'pv_curtailed', 'wind_avail', 'wind_to_load', 'wind_to_bess', 'wind_curtailed', 'bess_dis', 'bess_ch', 'self_discharge', 'e_start', 'e_end', 'bess_soh', 'bess_efc', 'bess_efc_dc', 'soh_loss_cal', 'soh_loss_cyc', 'max_c_rate', 'bess_replaced', 'gen_kwh', 'gen_to_load', 'gen_to_bess', 'gen_dump', 'fuel_l', 'unit_hours', 'starts', 'max_starts_h', 'max_units', 'fleet_full_h', 'minload_h', 'minload_run_max_h', 'lol_h', 'lol_events', 'lol_max_h', 'reserve_short_h', 'reserve_short_max_kw', 're_fraction', 'co2_t', 'c_fuel', 'c_om', 'c_replace', 'c_carbon', 'c_salvage', 'c_total'];
      sheets.push({ name: 'Yearly', rows: [keys].concat(R.years.map((y) => keys.map((k) => y[k]))) });
      const H = R.hourly, hk = Object.keys(H).filter((k) => Array.isArray(H[k]) && H[k].length === HOURS);
      const mrows = [['Month'].concat(hk)];
      const ms = hk.map((k) => (k === 'soc' || k === 'soc_target' || k === 'gen_units' ? null : monthlySum(H[k])));
      MONTHS.forEach((m, i) => mrows.push([m].concat(ms.map((s) => (s ? s[i] : null)))));
      sheets.push({ name: 'Monthly (yr 1)', rows: mrows });
      const hrows = [['Hour', 'Date', 'Hour of day'].concat(hk)];
      for (let t = 0; t < HOURS; t++) hrows.push([t, dateOfHour(t), t % 24].concat(hk.map((k) => H[k][t])));
      sheets.push({ name: 'Hourly (yr 1)', rows: hrows });
    }
    if (OPTIONS) {
      const S = optionsSummary(), rows = [['Option', 'Feasible', 'Fuel L/yr (yr 1)', 'RE fraction', 'Unit-hours', 'Starts', 'Avg genset load', 'Battery EFC', 'Battery replacements',
        'Curtailment', 'Unmet load', 'Capex ' + cur, 'NPC ' + cur, 'LCOE ' + cur + '/kWh', 'NPV vs diesel only ' + cur, 'IRR vs diesel only', 'Equity IRR', 'NPC change vs row above ' + cur, 'Note']];
      S.rows.forEach((x) => rows.push(x.err ? [x.label].concat(new Array(17).fill(null), [x.err])
        : [x.label, x.why ? 'no: ' + x.why : 'yes', x.fuel, x.re, x.uh, x.starts, x.load, x.efc, x.repl, x.curt, x.unmet, x.capex, x.npc, x.lcoe, x.npv, x.irr, x.eqIrr, x.dnpc,
          [x === S.best ? 'lowest feasible NPC' : '', x.close ? 'within model accuracy' : '', x.id === 'perfect' ? 'benchmark, not an option' : ''].filter(Boolean).join('; ')]));
      rows.push([], ['Basis', S.fast ? 'year 1 repeated over the project life' : 'every project year']);
      if (S.stale) rows.push(['Note', 'The inputs changed after this comparison; run Compare options again.']);
      sheets.push({ name: 'Options', rows });
    }
    if (TORNADO) {
      const S = tornadoSummary(P.tornado.metric), ms = Object.keys(TORNADO_METRICS), mode = { x: '×', '+': '+', '=': '=' };
      const get = (res, m) => { if (!res || res.error) return null; const x = TORNADO_METRICS[m][1](res); return x == null || !isFinite(x) ? null : x; };
      const unit = { npv: ' ' + cur, lcoe: ' ' + cur + '/kWh', irr: '', eq_irr: '', fuel: ' L' };
      // the change in the card's units: percentages in % or pp, with the field's unit
      const chg = (x, i) => { const v = i ? x.hi : x.lo, u = tornadoUnit(x); return v == null ? '' : `${mode[x.mode] || x.mode} ${tornadoPct(x) ? +(v * 100).toFixed(6) : v}${u ? ' ' + u : ''}`; };
      const rows = [['Input', 'Path', 'Change', 'Case', 'Input value'].concat(ms.map((m) => TORNADO_METRICS[m][0] + unit[m]))];
      rows.push(['Base', '', '', 'base', ''].concat(ms.map((m) => get(TORNADO.base, m))));
      S.rows.forEach((x) => ['low', 'high'].forEach((k, i) => rows.push([x.label, x.path, chg(x, i), k, x.vals[i]]
        .concat(x.err ? [x.err] : ms.map((m) => get(x.res[i], m))))));
      rows.push([], ['Order', 'largest swing of ' + S.name + ' first'], ['Basis', S.fast ? 'year 1 repeated over the project life' : 'every project year'],
        ['Battery prices move together', S.together ? 'yes' : 'no']);
      if (S.stale) rows.push(['Note', 'The inputs changed after this tornado; run it again.']);
      sheets.push({ name: 'Tornado', rows });
    }
    if (SIM && SIM.finance) {
      const R = SIM.finance, rows = [['Item'].concat(R.years.map((y) => 'Year ' + y.year))];
      Finance.ROWS(R.model === 'host').filter((r) => r[0] !== 'g').forEach(([k, label]) => rows.push([label].concat(R.years.map((y) => y[k]))));
      rows.push([]);
      Object.entries(R.metrics).forEach(([k, v]) => rows.push([k, v]));
      sheets.push({ name: 'Finance', rows });
    }
    if (OPT) {
      const cols = ['pv_kwp', 'bess_kwh', 'bess_kw', 'capex', 'npc', 'lcoe', 're', 'fuel', 'curtail', 'unmet', 'lole_h', 'res_short_h', 'irr', 'payback'];
      sheets.push({ name: 'Optimisation', rows: [cols].concat(OPT.ranked.map((r) => cols.map((k) => r[k]))) });
    }
    if (ForecastLab.result) {
      const B = ForecastLab.result, rows = [['Variable', 'Method', 'nMAE 1h', 'nMAE 6h', 'nMAE 24h', 'nRMSE 24h', 'Skill 24h', 'Bias 24h']];
      for (const v of ['pv', 'load']) B[v].methods.forEach((m) => rows.push([v, m.name, m.nmae[0], m.nmae[5], m.nmae[23], m.nrmse[23], m.skill[23], m.bias[23]]));
      if (B.value) { rows.push([]); rows.push(['EMS value', 'Method', 'Fuel L', 'Genset hours', 'NPC']); B.value.forEach((v) => rows.push([v.kind, v.name, v.fuel_l, v.unit_hours, v.npc])); }
      sheets.push({ name: 'Forecast', rows });
    }
    return sheets;
  }
  async function exportXlsx() {
    await freshSim();
    Electrical.render();
    const blob = xlsx(workbookSheets());
    download((P.name || 'project').replace(/[^\w\- ]+/g, '_') + '_results.xlsx', blob, blob.type);
    toast('Excel workbook exported');
  }

  // ------------------------------------------------------------------ HTML report
  async function chartImg(id, w = 1000, h = 420) {
    const el = document.getElementById(id);
    if (!el || !el.data || !el.layout) return '';
    const lay = JSON.parse(JSON.stringify(el.layout));
    lay.paper_bgcolor = '#ffffff'; lay.plot_bgcolor = '#ffffff';
    for (const k of Object.keys(lay)) if (/^[xy]axis/.test(k)) Object.assign(lay[k], { gridcolor: '#e6e6e6', linecolor: '#999' });
    try { return await Plotly.toImage({ data: el.data, layout: lay }, { format: 'png', width: w, height: h, scale: 1.5 }); } catch (e) { return ''; }
  }
  const tbl = (rows, head) => `<table>${head ? `<tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>` : ''}${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ''}>${c == null ? '–' : escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')}</table>`;

  // ---------------------------------------------------------------- site and PV layout
  // Drawn from the stored coordinates (Site & layout page): PV areas and exclusion zones, the PV tables of the last layout run
  // and the site marker, in a local metric projection (the same as the layout map), so the figure works offline and prints sharply.
  // Rounded to 0.1″ before the split, so 106.85 prints 106°51′00.0″.
  const dms = (v, pos, neg) => { const t = Math.round(Math.abs(v) * 36000), d = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = (t % 600) / 10; return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`; };
  const w180 = (lo) => ((((lo + 180) % 360) + 360) % 360) - 180;   // longitude in [-180, 180)
  const coord = (lat, lon) => `${(+lat).toFixed(6)}, ${w180(+lon).toFixed(6)}`;
  const finite = (q) => Array.isArray(q) && q.length === 2 && Number.isFinite(+q[0]) && Number.isFinite(+q[1]);
  const kmBetween = (a1, o1, a2, o2) => Math.hypot(w180(o2 - o1) * 111.32 * Math.cos(((a1 + a2) / 2) * Math.PI / 180), (a2 - a1) * 110.574);
  function layoutGeom() {
    const raw = ((P.layout && P.layout.polygons) || []).filter((p) => p && Array.isArray(p.latlngs) && p.latlngs.length >= 3 && p.latlngs.length <= 5000 && p.latlngs.every(finite)).slice(0, 50);
    if (!raw.length) return null;
    const R = P.layout.result && typeof P.layout.result === 'object' ? P.layout.result : null;
    const rt = R && Array.isArray(R.tables) && R.tables.length <= MAX_LAYOUT_TABLES ? R.tables.filter((t) => Array.isArray(t) && t.length === 4 && t.every(finite)) : [];
    // longitudes unwrapped around the first PV-area corner, so an area across ±180° stays in one piece
    const ref = +(raw.find((p) => p.type !== 'exclusion') || raw[0]).latlngs[0][1];
    const uw = (lo) => ref + ((((+lo - ref) % 360) + 540) % 360) - 180;
    const U = (ll) => ll.map(([x, y]) => [+x, uw(y)]);
    const polys = raw.map((p) => ({ type: p.type === 'exclusion' ? 'exclusion' : 'site', latlngs: U(p.latlngs) })), tables = rt.map(U);
    const site = [+P.location.lat, uw(+P.location.lon)], ky = 110574;
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    const grow = ([x, y]) => { la0 = Math.min(la0, x); la1 = Math.max(la1, x); lo0 = Math.min(lo0, y); lo1 = Math.max(lo1, y); };
    polys.forEach((p) => p.latlngs.forEach(grow)); tables.forEach((t) => t.forEach(grow));
    // the site marker joins the frame unless it lies far outside the drawn areas
    const k0 = 111320 * Math.cos(((la0 + la1) / 2) * Math.PI / 180), diag = Math.hypot((lo1 - lo0) * k0, (la1 - la0) * ky);
    const away = Math.hypot(Math.max(lo0 - site[1], 0, site[1] - lo1) * k0, Math.max(la0 - site[0], 0, site[0] - la1) * ky) > Math.max(0.5 * diag, 200);
    if (!away) grow(site);
    const kx = 111320 * Math.cos(((la0 + la1) / 2) * Math.PI / 180);
    // 8 % margin, at least 40 m, so the areas do not touch the frame
    const padLat = Math.max((la1 - la0) * 0.08, 40 / ky), padLon = Math.max((lo1 - lo0) * 0.08, 40 / kx);
    la0 -= padLat; la1 += padLat; lo0 -= padLon; lo1 += padLon;
    // a frame no flatter than 1:3, so the north arrow, scale bar and corner labels fit
    let widthM = (lo1 - lo0) * kx, heightM = (la1 - la0) * ky;
    if (heightM < widthM / 3) { const e = (widthM / 3 - heightM) / 2 / ky; la0 -= e; la1 += e; heightM = widthM / 3; }
    if (widthM < heightM / 3) { const e = (heightM / 3 - widthM) / 2 / kx; lo0 -= e; lo1 += e; widthM = heightM / 3; }
    const m = (x, y) => [(y - lo0) * kx, (x - la0) * ky];   // metres east and north of the south-west corner
    const area = (ll) => { let s2 = 0; const q = ll.map(([x, y]) => m(x, y)); q.forEach(([x, y], i) => { const [x2, y2] = q[(i + 1) % q.length]; s2 += x * y2 - x2 * y; }); return Math.abs(s2) / 2; };
    // area centroid (shoelace); on an L- or U-shaped area it can lie outside the area
    const centroid = (ll) => {
      const q = ll.map(([x, y]) => m(x, y));
      let A2 = 0, cx = 0, cy = 0;
      q.forEach(([x, y], i) => { const [x2, y2] = q[(i + 1) % q.length], cr = x * y2 - x2 * y; A2 += cr; cx += (x + x2) * cr; cy += (y + y2) * cr; });
      if (Math.abs(A2) < 1e-6) return [ll.reduce((t, p) => t + p[0], 0) / ll.length, ll.reduce((t, p) => t + p[1], 0) / ll.length];
      return [la0 + cy / (3 * A2) / ky, lo0 + cx / (3 * A2) / kx];
    };
    let siteNote = '';
    if (away) {
      const ex = (site[1] - (lo0 + lo1) / 2) * kx, ny = (site[0] - (la0 + la1) / 2) * ky;
      siteNote = ` The site coordinates lie ${fmtNum(Math.hypot(ex, ny) / 1000, 1)} km from the centre of the drawing, bearing ${Math.round((Math.atan2(ex, ny) * 180 / Math.PI + 360) % 360)}°, outside the frame.`;
    }
    return { polys, R, tables, site, away, siteNote, la0, la1, lo0, lo1, kx, ky, widthM, heightM, area, centroid };
  }
  // Satellite image of the frame from Esri World Imagery as a data URL: '' when turned off, null when it could not be fetched.
  // Requested in geographic coordinates with square degree pixels, so it lines up with the frame once stretched to it. The
  // data URL type is set here and the result checked, never taken from the response. Kept for the session per area.
  const imgCache = new Map(), IMG_DATA = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
  async function layoutImagery(G) {
    if (!(P.report && P.report.imagery)) return '';
    let lo0 = G.lo0, lo1 = G.lo1;
    if (lo1 > 180) { lo0 -= 360; lo1 -= 360; } else if (lo0 < -180) { lo0 += 360; lo1 += 360; }
    if (lo0 < -180 || lo1 > 180) return null;   // the frame still crosses ±180°
    const key = `${lo0},${G.la0},${lo1},${G.la1}`;
    if (imgCache.has(key)) return imgCache.get(key);
    let w0 = 1600, h0 = Math.round(w0 * (G.la1 - G.la0) / (lo1 - lo0));
    if (h0 > 1600) { w0 = Math.round(w0 * 1600 / h0); h0 = 1600; }
    let out = null;
    // where the imagery is coarse (remote areas) the service refuses large images: halve the size until it answers
    for (let k = 1; ; k *= 2) {
      const w = Math.round(w0 / k), h = Math.round(h0 / k);
      if (w < 64 || h < 64) break;
      let r;
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
        r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lo0},${G.la0},${lo1},${G.la1}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=jpg&f=image`, { signal: ctl.signal });
        clearTimeout(t);
      } catch (e) { return null; }   // offline: not cached, so a later preview tries again
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (r.ok && (type === 'image/jpeg' || type === 'image/png')) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength <= 8e6) {
          const src = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => res(''); fr.readAsDataURL(new Blob([buf], { type })); });
          if (IMG_DATA.test(src)) out = src;
        }
        break;
      }
      if (!r.ok && r.status < 500) break;   // a 4xx answer does not change with the size
    }
    imgCache.set(key, out);
    return out;
  }
  function layoutSvg(G, img) {
    let W = 1000, H = Math.round(W * G.heightM / G.widthM);
    if (H > 1300) { H = 1300; W = Math.round(H * G.widthM / G.heightM); }
    const X = (lon) => ((lon - G.lo0) / (G.lo1 - G.lo0)) * W, Y = (lat) => ((G.la1 - lat) / (G.la1 - G.la0)) * H;
    const path = (ll) => 'M' + ll.map(([a, b]) => `${X(b).toFixed(1)},${Y(a).toFixed(1)}`).join('L') + 'Z';
    const site = G.polys.filter((p) => p.type === 'site'), excl = G.polys.filter((p) => p.type === 'exclusion');
    const halo = img ? 'stroke="#fff" stroke-opacity=".85"' : 'stroke="none"';
    // scale bar: a round length near a fifth of the frame
    const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000], target = G.widthM / 5, Lm = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), nice[0]);
    const Lpx = Lm * W / G.widthM, label = Lm >= 1000 ? `${Lm / 1000} km` : `${Lm} m`;
    const t = (x, y, s, anchor = 'start') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="13" font-family="Arial, Helvetica, sans-serif" fill="#1a1a1a">${s}</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Site and PV layout">
      ${img ? `<image href="${escapeHtml(img)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` : `<rect width="${W}" height="${H}" fill="#f4f6f5"/>`}
      <defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#b4302f" stroke-width="2.5"/></pattern></defs>
      ${site.map((p) => `<path d="${path(p.latlngs)}" fill="#0f7466" fill-opacity="${img ? 0.12 : 0.1}" ${halo} stroke-width="6"/><path d="${path(p.latlngs)}" fill="none" stroke="#0f7466" stroke-width="2.5"/>`).join('')}
      ${G.tables.length ? `<path d="${G.tables.map(path).join('')}" fill="#1b2740" fill-opacity=".9"/>` : ''}
      ${excl.map((p) => `<path d="${path(p.latlngs)}" fill="url(#hatch)" fill-opacity=".55" stroke="#b4302f" stroke-width="2" stroke-dasharray="6 4"/>`).join('')}
      ${G.away ? '' : `<circle cx="${X(G.site[1]).toFixed(1)}" cy="${Y(G.site[0]).toFixed(1)}" r="7" fill="#f59e0b" stroke="#fff" stroke-width="2.5"/>`}
      <g transform="translate(${W - 46},18)"><rect x="-16" y="-6" width="32" height="56" rx="6" fill="#fff" fill-opacity=".9"/><path d="M0 0 L9 26 L0 20 L-9 26 Z" fill="#1a1a1a"/>${t(0, 44, 'N', 'middle')}</g>
      <g transform="translate(16,${H - 44})"><rect x="-6" y="-8" width="${(Lpx + 12).toFixed(0)}" height="40" rx="6" fill="#fff" fill-opacity=".9"/>
        <rect x="0" y="0" width="${(Lpx / 2).toFixed(1)}" height="6" fill="#1a1a1a"/><rect x="${(Lpx / 2).toFixed(1)}" y="0" width="${(Lpx / 2).toFixed(1)}" height="6" fill="#fff" stroke="#1a1a1a"/>
        ${t(0, 24, '0')}${t(Lpx.toFixed(1), 24, label, 'end')}</g>
      <g><rect x="${W - 238}" y="${H - 30}" width="230" height="22" rx="5" fill="#fff" fill-opacity=".9"/>${t(W - 123, H - 14, `${G.la0.toFixed(5)}, ${w180(G.lo0).toFixed(5)} (SW)`, 'middle')}</g>
      <g><rect x="8" y="8" width="230" height="22" rx="5" fill="#fff" fill-opacity=".9"/>${t(123, 24, `${G.la1.toFixed(5)}, ${w180(G.lo1).toFixed(5)} (NE)`, 'middle')}</g>
    </svg>`;
  }
  // The "Site and PV layout" part of the report: coordinates, the PV field, the drawing and the area corners.
  async function layoutHtml(fig) {
    const L = P.location, G = layoutGeom(), Wx = P.weather, R = P.layout && P.layout.result && typeof P.layout.result === 'object' ? P.layout.result : null;
    let h = '<h3>Site and PV layout</h3>';
    const rows = [['Site coordinates', `${coord(L.lat, L.lon)} (${dms(+L.lat, 'N', 'S')} ${dms(w180(+L.lon), 'E', 'W')})`],
      ['Time zone', `${fmtOffset(L.utc_offset)}${L.tz ? ' (' + L.tz + ')' : ''}`]];
    // the weather elevation is the site's only when the data were fetched for this site
    if (weatherAtSite()) rows.push(['Elevation', `${fmtNum(Wx.elevation)} m (from ${Wx.source})`]);
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
    h += tbl(rows, ['Item', 'Value']);
    if (!G) return h + '<p>No PV area is drawn. Use Draw PV area on the Site &amp; layout page to add the layout drawing and its corner coordinates to the report.</p>';
    const img = await layoutImagery(G), site = G.polys.filter((p) => p.type === 'site'), excl = G.polys.filter((p) => p.type === 'exclusion');
    const notDrawn = R && +R.n_tables > G.tables.length ? ` The ${fmtNum(+R.n_tables)} PV tables of the layout are too many to draw; only the areas are shown.` : '';
    h += `<figure class="layout">${layoutSvg(G, img)}<figcaption>Figure ${fig.next()}. Site and PV layout: ${site.length} PV area${site.length === 1 ? '' : 's'} (green)${excl.length ? `, ${excl.length} exclusion zone${excl.length === 1 ? '' : 's'} (hatched)` : ''}${G.tables.length ? `, ${fmtNum(G.tables.length)} PV tables filling the area (dark)` : ''}${G.away ? '.' : '; the orange dot marks the site coordinates.'}${escapeHtml(G.siteNote + notDrawn)}${img ? ' Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community.' : img === null ? ' The satellite image could not be fetched (no internet, or no image at this scale), so the drawing is shown without it.' : ''}</figcaption></figure>`;
    const k = { site: 0, exclusion: 0 };
    h += tbl(G.polys.map((p) => {
      const c = G.centroid(p.latlngs);
      return [`${p.type === 'site' ? 'PV area' : 'Exclusion zone'} ${++k[p.type]}`, `${fmtNum(G.area(p.latlngs) / 1e4, 2)} ha`, p.latlngs.length, coord(c[0], c[1])];
    }), ['Area', 'Size', 'Corners', 'Centroid (lat, lon)']);
    // corner coordinates of the PV areas; the workbook's Layout sheet has every corner
    const corners = [];
    site.forEach((p, i) => p.latlngs.forEach(([a, b], j) => corners.push([`PV area ${i + 1}, corner ${j + 1}`, (+a).toFixed(6), w180(+b).toFixed(6)])));
    const cap = 40;
    h += '<h3>PV area corner coordinates</h3>' + tbl(corners.slice(0, cap), ['Corner', 'Latitude', 'Longitude']);
    if (corners.length > cap) h += `<p>${corners.length - cap} more corners are in the Layout sheet of the Excel workbook.</p>`;
    return h;
  }
  // Rows of the workbook's Layout sheet: every area corner and the layout result
  function layoutRows() {
    const G = layoutGeom(), R = P.layout && P.layout.result && typeof P.layout.result === 'object' ? P.layout.result : null;
    if (!G && !R) return null;
    const rows = [['Item', 'Corner', 'Latitude', 'Longitude'], ['Site coordinates', '', +P.location.lat, w180(+P.location.lon)]];
    const k = { site: 0, exclusion: 0 };
    if (G) G.polys.forEach((p) => { const name = `${p.type === 'site' ? 'PV area' : 'Exclusion zone'} ${++k[p.type]}`; p.latlngs.forEach(([a, b], j) => rows.push([name, j + 1, a, w180(b)])); });
    if (R) rows.push([], ['Layout result (area filled)', 'Value'], ['PV tables', +R.n_tables], ['Modules', +R.modules], ['DC capacity, the most the area holds (kWp)', +R.kwp],
      ['PV area (m²)', +R.site_m2], ['Exclusion area (m²)', +R.excl_m2], ['Row pitch (m)', +R.pitch]);
    return rows;
  }

  // ---------------------------------------------------------------- figures supplied by the user
  const FIG_PLACES = { site: 'Site and solar resource', pv: 'PV system and energy yield', electrical: 'Electrical design', simulation: 'Energy simulation', appendix: 'Additional figures' };
  const DATA_IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
  // P.report as the app expects it, also for an imported file: a plain object, a boolean imagery, and figures that are valid
  // images with a caption, a known place and a unique id
  function cleanReport(p) {
    const r = p.report;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { p.report = { imagery: true, figures: [] }; return; }
    r.imagery = !!r.imagery;
    const ids = new Set();
    r.figures = (Array.isArray(r.figures) ? r.figures : []).filter((f) => f && typeof f === 'object' && typeof f.src === 'string' && DATA_IMG.test(f.src)).map((f) => {
      let id = typeof f.id === 'string' && /^[\w-]{1,40}$/.test(f.id) ? f.id : '';
      while (!id || ids.has(id)) id = Math.random().toString(36).slice(2, 10);
      ids.add(id);
      return { id, caption: String(f.caption == null ? '' : f.caption).slice(0, 300), place: FIG_PLACES[f.place] ? f.place : 'appendix', src: f.src, w: +f.w || 0, h: +f.h || 0 };
    });
  }
  const figList = () => (P.report && Array.isArray(P.report.figures) ? P.report.figures : []);
  const userFigures = () => figList().filter((f) => f && typeof f.src === 'string' && DATA_IMG.test(f.src));
  // Scale an image file to at most 1,800 px on the long side. PNG stays PNG (drawings) unless it gets large; photos become JPEG.
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d');
    const draw = (white) => { g.clearRect(0, 0, c.width, c.height); if (white) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } g.drawImage(bmp, 0, 0, c.width, c.height); };
    let src = '';
    if (file.type === 'image/png') { draw(false); src = c.toDataURL('image/png'); }
    if (!src || src.length > 2.5e6) { draw(true); src = c.toDataURL('image/jpeg', 0.85); }
    bmp.close && bmp.close();
    return { src, w: c.width, h: c.height };
  }
  let figTimer;
  function figuresSaved() { autosave(); clearTimeout(figTimer); figTimer = setTimeout(preview, 700); }
  function figuresChanged() { figuresSaved(); renderFigures(); }
  async function addFigures(files) {
    if (!Array.isArray(P.report.figures)) P.report.figures = [];
    const F = P.report.figures;
    for (const f of files) {
      if (F.length >= 12) { toast('A project holds at most 12 figures.', true); break; }
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast(`${f.name}: use a PNG, JPEG or WebP image.`, true); continue; }
      let s;
      try { s = await shrinkImage(f); } catch (e) { toast(`${f.name}: the image could not be read.`, true); continue; }
      if (F.reduce((n, x) => n + x.src.length, 0) + s.src.length > 15e6) { toast('The figures would take more than 15 MB in the project file. Use smaller images.', true); break; }
      let id;
      do id = Math.random().toString(36).slice(2, 10); while (F.some((x) => x.id === id));
      F.push({ id, caption: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 300), place: 'appendix', src: s.src, w: s.w, h: s.h });
    }
    figuresChanged();
  }
  function renderFigures() {
    const box = $('#figList');
    if (!box || !P.report) return;
    $('#figImagery').checked = !!P.report.imagery;
    const F = figList();
    box.innerHTML = F.length ? F.map((f, i) => {
      const pl = FIG_PLACES[f.place] ? f.place : 'appendix';
      return `<div class="fig-row" data-i="${i}">
        <img src="${DATA_IMG.test(f.src) ? f.src : ''}" alt="">
        <div class="fig-fields"><label>Caption<input data-f="caption" maxlength="300" value="${escapeHtml(f.caption || '')}"></label>
          <label>Place in the report<select data-f="place">${Object.entries(FIG_PLACES).map(([k, t]) => `<option value="${k}" ${k === pl ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
        <div class="fig-btns"><button class="btn ghost small" data-mv="-1" ${i ? '' : 'disabled'} aria-label="Move figure ${i + 1} up">↑</button><button class="btn ghost small" data-mv="1" ${i < F.length - 1 ? '' : 'disabled'} aria-label="Move figure ${i + 1} down">↓</button>
          <button class="btn ghost small danger" data-rm aria-label="Remove figure ${i + 1}">Remove</button></div></div>`;
    }).join('') : '<p class="hint">No figures yet.</p>';
    $$('.fig-row', box).forEach((row) => {
      const i = +row.dataset.i;
      // caption and place change no structure: save without redrawing, so focus stays where it is
      $$('[data-f]', row).forEach((el) => (el.onchange = () => { F[i][el.dataset.f] = el.value.slice(0, 300); figuresSaved(); }));
      $$('[data-mv]', row).forEach((b) => (b.onclick = () => {
        const d = +b.dataset.mv, j = i + d;
        [F[i], F[j]] = [F[j], F[i]];
        figuresChanged();
        const r2 = $(`#figList .fig-row[data-i="${j}"]`), t = r2 && r2.querySelector(`[data-mv="${d}"]`);
        if (r2) (t && !t.disabled ? t : r2.querySelector(`[data-mv="${-d}"]`)).focus();
      }));
      $('[data-rm]', row).onclick = () => {
        F.splice(i, 1);
        figuresChanged();
        const k = Math.min(i, F.length - 1), t = k >= 0 ? $(`#figList .fig-row[data-i="${k}"] [data-rm]`) : $('#figAddBtn');
        if (t) t.focus();
      };
    });
  }
  function initFigures() {
    $('#figAddBtn').onclick = () => $('#figAdd').click();
    $('#figAdd').onchange = (e) => { addFigures([...e.target.files]); e.target.value = ''; };
    $('#figImagery').onchange = (e) => { P.report.imagery = e.target.checked; autosave(); clearTimeout(figTimer); figTimer = setTimeout(preview, 300); };
  }

  // Auxiliary loads as the engine applies them (Method and assumptions).
  function auxText() {
    const a = P.aux || {}, parts = [];
    if (a.bess_kw_per_mwh > 0) parts.push(`battery HVAC, BMS and fire system ${fmtNum(a.bess_kw_per_mwh, 2)} kW per MWh of nameplate energy${a.bess_temp_coeff > 0 ? `, rising ${fmtPct(a.bess_temp_coeff)}/°C above ${+a.ref_c} °C ambient` : ''}`);
    if (a.pcs_kw_per_mw > 0) parts.push(`battery inverter (PCS) no-load ${fmtNum(a.pcs_kw_per_mw, 2)} kW per MW of PCS rating (with a battery)`);
    if (a.plant_kw > 0) parts.push(`plant auxiliaries ${fmtNum(a.plant_kw, 1)} kW (with PV, wind or a battery)`);
    if (a.trafo_noload_kw > 0) parts.push(`PV step-up transformer no-load ${fmtNum(a.trafo_noload_kw, 1)} kW (with PV)`);
    if (a.bess_trafo_noload_kw > 0) parts.push(`BESS step-up transformer no-load ${fmtNum(a.bess_trafo_noload_kw, 1)} kW (with a battery)`);
    return parts.length ? `Auxiliary loads: ${parts.join('; ')}. They are served every hour like the site load and do not grow with it; LCOE, COE and billed renewable energy count only the energy served to the site.`
      : 'Auxiliary loads (battery HVAC and BMS, battery inverter no-load, plant auxiliaries, transformer no-load): none modelled.';
  }

  // Data quality of the weather or a measured load: the import and the data checks (TsImport.quality, web/js/tsimport.js).
  function qualityHtml(kind) {
    const Q = TsImport.quality(kind);
    if (!Q) return '';
    const weather = kind === 'weather';
    let s = `<h3>Data quality</h3><p>${weather
      ? 'The data checks flag hours that are physically impossible or look stuck, copied or infilled, and compare the timing of the clear days with the sun.'
      : 'The data checks flag outages, stuck values, linear infill, spikes, level shifts and unit errors of the measured load.'} Flags only inform: the data are used as they are.</p>`;
    s += tbl(Q.rows, ['Item', 'Value']);
    if (Q.flags.length) s += tbl(Q.flags.map((f) => (weather ? f : f.slice(0, 3))), weather ? ['Flag', 'Hours', 'Days', 'Share of GHI'] : ['Flag', 'Hours', 'Days']);
    Q.notes.forEach((n) => (s += `<p>${escapeHtml(n)}</p>`));
    if (!Q.timingOk) s += '<div class="warn">The timing check of the weather needs attention; see Timing above.</div>';
    return s;
  }

  async function build() {
    const cur = P.econ.currency, curH = escapeHtml(cur), date = new Date().toISOString().slice(0, 10);
    let fn = 0, sec = 0;
    const H2 = (t) => `<h2>${++sec}. ${escapeHtml(t)}</h2>`;
    const fig = (src, cap, cls) => (src ? `<figure${cls ? ` class="${cls}"` : ''}><img src="${src}"><figcaption>Figure ${++fn}. ${escapeHtml(cap)}</figcaption></figure>` : '');
    fig.next = () => ++fn;
    // figures supplied by the user, at the end of the section they chose; those whose section is not in the report go to Additional figures
    const shown = new Set();
    const userFigs = (place) => userFigures().filter((f) => (FIG_PLACES[f.place] ? f.place : 'appendix') === place).map((f) => { shown.add(f); return fig(f.src, f.caption || 'Figure supplied with the project.', 'user'); }).join('');
    try { drawWeather(); drawLoad(); Finance.render(); } catch (e) { /* charts optional */ }
    Electrical.render();
    const logo = await fetch('img/logo.svg').then((r) => (r.ok ? r.text() : '')).catch(() => '');
    let h = `<header class="cover">${logo ? `<div class="logo">${logo}</div>` : ''}<div class="tag">TECHNO-ECONOMIC ASSESSMENT</div><h1>${escapeHtml(P.name || 'Hybrid power plant')}</h1>
      <p class="sub">PV${(SIM ? SIM.result.size.wind_units : P.wind && P.wind.units) > 0 ? ', wind' : ''}, battery storage and diesel generation: energy yield, dispatch, sizing, electrical design and economics</p>
      <table class="meta"><tr><td>Location</td><td>${(+P.location.lat).toFixed(5)}, ${(+P.location.lon).toFixed(5)} (${fmtOffset(P.location.utc_offset)}${P.location.tz ? ', ' + escapeHtml(P.location.tz) : ''})</td></tr>
      <tr><td>Date</td><td>${date}</td></tr><tr><td>Prepared with</td><td>Soloptima (local engine, hourly chronological simulation)</td></tr></table></header>`;

    h += H2('Executive summary');
    if (SIM) {
      const R = SIM.result, C = SIM.comparison, B = SIM.baseline, y = R.years[0], CB = SIM.comparison_bess, pvW = R.size.wind_units > 0 ? 'PV and wind' : 'PV', Z = R.size, note = staleNote();
      if (note) h += `<div class="warn">${escapeHtml(note)}</div>`;
      // sizes from the run, as the results
      h += `<p>The plant combines <b>${fmtNum(Z.pv_kwp)} kWp</b> of PV, a <b>${fmtNum(Z.bess_kwh)} kWh / ${fmtNum(Z.bess_kw)} kW</b> battery${Z.wind_units > 0 ? ` and <b>${+Z.wind_units} × ${fmtNum(P.wind.rated_kw)} kW</b> wind turbines` : ''} with the existing diesel fleet of <b>${+P.diesel.units} × ${fmtNum(P.diesel.unit_kw)} kW</b>.
        In year 1 renewables supply <b>${fmtPct(R.re_fraction)}</b> of the ${fmtEnergy(y.served)} served. Diesel use falls by <b>${fmtNum(C.fuel_saved_l_y1)} L</b> (${fmtPct(C.fuel_saved_l_y1 / B.fuel_l_y1)}) and CO₂ emissions by ${fmtNum(C.co2_saved_t_y1)} t.
        The levelised cost of electricity is <b>${curH} ${fmtNum(R.econ.lcoe, 4)}/kWh</b> against ${fmtNum(C.lcoe_base, 4)} for diesel only; the additional investment of ${fmtMoney(R.econ.capex_total - B.econ.capex_total, curH)} returns an IRR of ${fmtPct(C.irr)} with a payback of ${C.payback_years == null ? 'more than the project life' : fmtNum(C.payback_years, 1) + ' years'} (NPV of savings ${fmtMoney(C.npv_savings, curH)}).${CB
          ? ` Against the same ${pvW} without a battery, the battery's own NPV is <b>${fmtMoney(CB.npv_savings, curH)}</b>${CB.irr != null ? ` (IRR ${fmtPct(CB.irr)})` : ''}${CB.npv_savings < 0 ? ': at these inputs it does not pay for itself' : ''}.` : ''}</p>`;
      h += tbl([['Renewable fraction (yr 1)', fmtPct(R.re_fraction)], ['Fuel saved (yr 1)', fmtNum(C.fuel_saved_l_y1) + ' L'], ['LCOE hybrid / diesel only', `${fmtNum(R.econ.lcoe, 4)} / ${fmtNum(C.lcoe_base, 4)} ${cur}/kWh`],
        ['Net present cost hybrid / diesel only', `${fmtMoney(R.econ.npc, cur)} / ${fmtMoney(B.econ.npc, cur)}`], ['Capex', fmtMoney(R.econ.capex_total, cur)], ['IRR / payback', `${fmtPct(C.irr)} / ${C.payback_years == null ? '–' : fmtNum(C.payback_years, 1) + ' yr'}`],
        ['PV curtailment / unmet load', `${fmtPct(R.curtail_fraction)} / ${fmtPct(R.unmet_fraction, 3)}`]].concat(CB ? [['Battery NPV / IRR vs ' + pvW + ' only', `${fmtMoney(CB.npv_savings, cur)} / ${fmtPct(CB.irr)}`]] : [], R.metrics ? [['LPSP / SSSI / SSCI', `${fmtPct(R.metrics.lpsp, 3)} / ${fmtPct(R.metrics.sssi)} / ${fmtPct(R.metrics.ssci)}`]] : []), ['Indicator', 'Value']);
    } else h += '<p>No simulation results yet.</p>';

    h += H2('Site and solar resource');
    h += await layoutHtml(fig);
    if (P.weather) {
      const ghi = sum(P.weather.ghi) / 1000;
      h += `<p>Hourly meteorological data: <b>${escapeHtml(P.weather.source)}</b>. ${escapeHtml(P.weather.note || '')} Annual global horizontal irradiation ${fmtNum(ghi)} kWh/m², mean temperature ${fmtNum(sum(P.weather.tamb) / HOURS, 1)} °C.</p>` + fig(await chartImg('chWxMonthly'), 'Monthly global horizontal irradiation.');
      h += qualityHtml('weather');
    }
    if (P.resource_years && P.resource_years.result) {
      const S = resourceYearsSummary(), X = S.X, b = X.budget || {}, st = X.stats;
      h += '<h3>Inter-annual variability and P50/P90</h3>';
      if (S.stale) h += '<div class="warn">The inputs changed after this run. Run it again on the Solar resource page for current figures.</div>';
      h += `<p>Year 1 of the plant was simulated with each of the ${X.years.length} historical weather years of ${escapeHtml(X.database)} ${X.range.from}–${X.range.to}, with the sizes and settings unchanged.
        The spread across these years is used only as ratios${S.devNote ? `. ${escapeHtml(S.devNote)}` : `: P50 is the result with the project's weather, ${escapeHtml(X.weather || '–')}.`}
        The one-year uncertainty of each result combines its year-to-year spread with the systematic uncertainty of irradiance, ${fmtPct(X.sigma_sys)} (dataset ${fmtPct(b.dataset)}, transposition and PV model ${fmtPct(b.model)}, soiling and availability ${fmtPct(b.soiling)}, root-sum-square), scaled by the result's elasticity to irradiance; the 10-year values assume independent years.${P.wind && P.wind.units > 0 ? ' With wind turbines, each weather year also brings its own wind speeds, but the systematic uncertainty and the elasticity cover irradiance only, so the P90 leaves out the uncertainty of the long-term wind resource.' : ''}
        A 1 % change in irradiance changes the specific yield by ${fmtNum(st.yield.elasticity, 2)} % and the fuel saved by ${fmtNum(st.fuel_saved.elasticity, 2)} %.
        ${S.f1 == null ? '' : `Revenue P90 ÷ P50 is ${fmtNum(S.f1, 3)} for one year and ${fmtNum(S.f10, 3)} for a 10-year average${S.applied ? `; debt sizing in Project finance uses ${S.applied.p90_factor} (${S.applied.basis === 10 ? '10-year average' : 'one year'})` : ''}.`}</p>`;
      if (S.devWarn) h += `<div class="warn">${escapeHtml(S.devWarn)}</div>`;
      drawResourceYears();
      h += fig(await chartImg('chRy'), 'Specific yield and fuel saved in each weather year as a percentage of their multi-year mean, with P50 (the project weather) and the one-year P90 on the same basis; the worst year of each is outlined.');
      h += tbl(S.rows.map((r) => [r.label, ...['p50', 'p75_1', 'p90_1', 'p99_1', 'p90_10'].map((q) => ryFmt(r.k, r[q])), fmtPct(r.sigma_iav), fmtNum(r.elasticity, 2), `${r.worst_year} (${ryFmt(r.k, r.worst)})`]),
        ['Result', 'P50', 'P75', 'P90 1-yr', 'P99 1-yr', 'P90 10-yr', 'Inter-annual σ', 'Elasticity', 'Worst year']);
      if (X.note) h += `<p>${escapeHtml(X.note)}</p>`;
    }
    h += userFigs('site');
    h += H2('Electrical load');
    if (P.load.kw) h += `<p>Annual energy ${fmtEnergy(sum(P.load.kw))}, average ${fmtPower(sum(P.load.kw) / HOURS)}, peak ${fmtPower(maxOf(P.load.kw))} (load factor ${fmtPct(sum(P.load.kw) / HOURS / maxOf(P.load.kw))}). Source: ${P.load.source === 'csv' ? 'measured profile' : 'synthetic profile from daily shape with variability'}${P.load.growth ? `, growth ${fmtPct(P.load.growth)}/yr` : ''}.</p>` + fig(await chartImg('chLoadDaily'), 'Average daily load profile with min–max range.') + qualityHtml('load');
    h += H2('PV system and energy yield');
    h += tbl([['DC capacity', fmtNum(P.pv.capacity_kwp) + ' kWp'], ['Mounting', P.pv.mount === 'fixed' ? `fixed, tilt ${P.pv.tilt}°` : 'single-axis tracker'], ['GCR', P.pv.gcr], ['DC/AC ratio', P.pv.dc_ac_ratio],
      ['Module', Equipment.selected('pv') ? Equipment.selected('pv').name : `${P.pv.module_wp} Wp`], ['Inverter', Equipment.selected('inverter') ? Equipment.selected('inverter').name : '–'],
      ...(PVR ? [['Specific yield', fmtNum(PVR.specific_yield) + ' kWh/kWp·yr'], ['Performance ratio', fmtPct(PVR.performance_ratio)]] : [])], ['Parameter', 'Value']);
    if (PVR) h += fig(await chartImg('chPvLoss', 1000, 520), 'PV loss diagram (year 1).') + fig(await chartImg('chPvMonthly'), 'Monthly specific yield.');
    if (PVREF) {
      const t = pvRefText(PVREF), w = t.filter((x) => x.startsWith('⚠')).map((x) => x.replace(/^⚠\s*/, ''));
      h += `<p>${t.filter((x) => !x.startsWith('⚠')).map(escapeHtml).join(' ')}</p>` + (w.length ? `<div class="warn">${escapeHtml(w.join(' '))}</div>` : '');
    }
    drawPvBalance();
    const PB = pvBalance();
    if (PB) {
      const kwp = P.pv.capacity_kwp, dE = kwp >= 1000 ? 0 : kwp >= 100 ? 1 : 2;
      h += '<h3>Balances and main results</h3>' + tbl(PB.rows.map((x) => [x.label, fmtNum(x.ghi, 1), fmtNum(x.dhi, 1), fmtNum(x.tamb, 1), fmtNum(x.poa, 1), fmtNum(x.eff, 1),
        fmtNum(x.earray * kwp / 1000, dE), fmtNum(x.eavail * kwp / 1000, dE), fmtPct(x.pr)]), ['Month', 'GlobHor kWh/m²', 'DiffHor kWh/m²', 'T_amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²', 'EArray MWh', 'E_avail MWh', 'PR']);
      h += `<p>GlobInc is the irradiation on the module plane before shading and GlobEff after row shading, reflection (IAM) and soiling. EArray is the DC energy of the array, E_avail the energy available after the inverter, clipping, AC losses and availability, and PR = E_avail ÷ (GlobInc × kWp ÷ 1 kW/m²).
        In the normalised production the reference yield Yr (GlobInc per day) splits into the final yield Yf, the system losses Ls and the array capture losses Lc${PB.sim ? '; Lu is the PV energy curtailed in the simulation because neither the load nor the battery could take it, and the delivered PR counts only the PV energy used' : ''}.</p>`;
      h += fig(await chartImg('chPvNorm'), `Normalised production per kWp and day (Yf, ${PB.sim ? 'Lu, ' : ''}Ls, Lc) and performance ratio by month.`);
    }
    const ST = Electrical.design && Electrical.design.str;
    if (ST) {
      const m = ST.pv, iv = ST.inv, area = m.length && m.width ? ST.nModules * m.length * m.width : null;
      h += '<h3>Array characteristics</h3>' + tbl([['Modules', `${fmtNum(ST.nModules)} × ${fmtNum(m.pmax)} Wp: ${m.name}`], ['Strings × modules in series', `${fmtNum(ST.nStrings)} × ${ST.ns}`],
        ['DC capacity (built)', fmtNum(ST.kwp, 1) + ' kWp'], ['Inverters', `${fmtNum(ST.nInv)} × ${fmtNum(iv.pac_kw)} kW: ${iv.name}; DC/AC ${ST.dcac.toFixed(3)}`],
        ['MPPT', `${iv.n_mppt} per inverter, window ${iv.vmppt_min}–${iv.vmppt_max} V; ${fmtNum(ST.spi, 1)} strings per inverter, up to ${ST.spm} per MPPT`],
        ['Vmp at max cell temperature', `${fmtNum(ST.vmpHot)} V at ${ST.tHot} °C`],
        ['Voc at site minimum', `${fmtNum(ST.vocMax)} V at ${Electrical.design.tmin} °C (limit ${fmtNum(Math.min(iv.vdc_max, m.vsys || iv.vdc_max))} V)`],
        ['Module area', area == null ? '–' : fmtNum(area) + ' m²']], ['Item', 'Value']);
    }
    const pv = P.pv, ap = P.electrical.applied || {}, src = (k) => (ap[k] != null && ap[k] === pv[k]
      ? (k === 'dc_wiring' && pv.dc_wiring_basis === 'stc' ? 'set from Electrical & SLD as a constant fraction, basis since changed to STC power' : 'set from Electrical & SLD') : 'typed');
    h += '<h3>Loss parameters</h3>' + tbl([['Albedo', fmtNum(pv.albedo, 2), 'typed'], ['Soiling', fmtPct(pv.soiling, 2), 'typed'], ['IAM b0 (ASHRAE)', fmtNum(pv.iam_b0, 3), 'typed'],
      ['Thermal model', pv.thermal_model === 'noct' ? `NOCT ${+pv.noct} °C` : `Heat-loss factors, Uc ${+pv.uc} W/m²K, Uv ${+pv.uv} W/m²K per m/s, absorptance ${+pv.absorptance}`, 'typed'],
      ['Low-irradiance loss at 200 W/m²', fmtPct(pv.low_irr_loss_200, 2), 'typed'], ['Mismatch', fmtPct(pv.mismatch, 2), 'typed'],
      ['DC wiring', `${fmtPct(pv.dc_wiring, 2)} ${pv.dc_wiring_basis === 'stc' ? 'at STC power' : 'as a constant fraction'}`, src('dc_wiring')], ['LID', fmtPct(pv.lid, 2), 'typed'],
      ['Module quality', fmtPct(pv.module_quality, 2), 'typed'], ['Inverter efficiency', fmtPct(pv.inverter_eff, 2), 'typed'], ['AC losses', fmtPct(pv.ac_losses, 2), src('ac_losses')],
      ['Availability', fmtPct(pv.availability, 2), 'typed'], ['Degradation', fmtPct(pv.degradation, 2) + '/yr', 'typed']], ['Parameter', 'Value', 'Source']);
    const W = P.weather || {}, split = W.dni && W.dni.length === HOURS && W.dhi && W.dhi.length === HOURS, pvgisWx = /^PVGIS/.test(W.source || '');
    // the period only when the source name does not already give it; no year is guessed from a file name
    const yrs = W.years ? ((W.source || '').includes(W.years) ? '' : W.years.replace('-', '–')) : /TMY/.test(W.source || '') ? 'typical year (period not recorded)' : '';
    const tr = pv.mount === 'tracker';
    h += '<h3>Models used</h3>' + tbl([['Weather data', W.source ? W.source + (yrs ? ', ' + yrs : '') : '–'],
      ['Decomposition', split ? 'beam and diffuse from the weather data, kept consistent with GHI' : 'Erbs (diffuse fraction from the clearness index)'],
      ['Transposition', 'Hay-Davies (beam, circumsolar and isotropic sky diffuse, ground reflection)'],
      ['Shading', tr ? (pv.backtracking ? `single-axis tracking with backtracking (no row shading), up to ±${+pv.tracker_max_angle}°` : pv.row_shading ? `true tracking with infinite-row beam shading at GCR ${+pv.gcr}, up to ±${+pv.tracker_max_angle}°` : 'true tracking without shading')
        : pv.row_shading ? `infinite-row 2-D beam shading at GCR ${+pv.gcr}; diffuse light not shaded` : 'none (row shading off)'],
      ['Horizon', pvgisWx ? 'terrain horizon included in the PVGIS beam irradiance' : 'not applied'],
      ['Time base', `local standard time, ${fmtOffset(P.location.utc_offset)}${P.location.tz ? ' (' + P.location.tz + ')' : ''}; ` + (W.is_utc === false ? 'weather data already in local time'
        : 'weather data in UTC shifted by the offset' + (+P.location.utc_offset % 1 ? ', each local hour the weighted mean of the two UTC hours it overlaps' : ''))]], ['Model', 'Used']);
    h += userFigs('pv');
    h += H2('Equipment schedule');
    for (const [t, lbl] of [['pv', 'PV module'], ['inverter', 'PV inverter'], ['battery', 'Battery system'], ['genset', 'Diesel generator']]) {
      const e = Equipment.selected(t);
      if (!e) continue;
      const fields = EQ_TYPES[t].fields.filter(([k]) => k !== 'name' && e[k] != null && e[k] !== '');
      h += `<h3>${lbl}: ${escapeHtml(e.name)}</h3>` + tbl(fields.map(([k, l, , u]) => [l, `${typeof e[k] === 'number' ? fmtSig(e[k]) : e[k]} ${u || ''}`]));
    }
    const D = Electrical.design;
    if (D) {
      h += H2('Electrical design');
      if (D.str) {
        const s = D.str;
        h += `<p>Strings of <b>${s.ns}</b> modules (allowed ${s.nMin}–${Math.min(s.nMax, s.nMppt)}; Voc at ${+D.tmin} °C = ${fmtNum(s.vocMax)} V). ${fmtNum(s.nStrings)} strings on ${fmtNum(s.nInv)} inverters, DC/AC ${s.dcac.toFixed(3)}, ${fmtNum(s.kwp, 1)} kWp built.</p>`;
        h += `<p>Vmp at ${+s.tHot} °C cell temperature = ${fmtNum(s.vmpHot)} V and at ${+D.tmin} °C = ${fmtNum(s.vmpCold)} V, against the MPPT window ${escapeHtml(s.inv.vmppt_min)}–${escapeHtml(s.inv.vmppt_max)} V. Vmp temperature coefficient ${fmtNum(s.bVmp, 3)} %/°C (${escapeHtml(s.bVmpSrc)})${s.tModel != null ? `; the thermal model's 99.9th percentile cell temperature is ${fmtNum(s.tModel, 1)} °C` : ''}.</p>`;
      }
      h += '<h3>Transformers</h3>' + tbl(D.trafos.map((t) => [t.role, t.n, t.t.name, fmtNum(t.t.kva) + ' kVA', fmtPct(t.loading, 0), t.annual_kwh != null ? fmtNum(t.annual_kwh / 1000, 1) : '–']), ['Role', 'Units', 'Type', 'Rating', 'Peak loading', 'Losses MWh/yr']);
      h += '<h3>Cable schedule</h3>' + tbl(D.circuits.map((c) => [c.name, c.count, c.cab ? c.cab.name : '–', c.runs, fmtNum(c.L), fmtNum(c.I), c.amp ? fmtNum(c.amp) : '–', c.dv != null ? (c.dv * 100).toFixed(2) + ' %' : '–', c.annual != null ? fmtNum(c.annual / 1000, 1) : '–']),
        ['Circuit', 'No.', 'Cable', 'Runs', 'Length m', 'I A', 'Rating A', 'ΔV', 'Loss MWh/yr']);
      if (D.warn.length) h += `<div class="warn">${D.warn.map((w) => escapeHtml(w)).join('<br>')}</div>`;
      if (SLD.svg) h += `<figure class="sld">${SLD.svg}<figcaption>Figure ${++fn}. Single-line diagram.</figcaption></figure>`;
      h += userFigs('electrical');
    }
    if (SIM) {
      const R = SIM.result, B = SIM.baseline, y = R.years[0], b = B.years[0];
      h += H2('Energy simulation');
      h += `<p>Dispatch strategy: <b>${{ load_following: 'load following', cycle_charging: +P.diesel.cc_setpoint <= +P.bess.soc_min ? 'cycle charging with the setpoint at or below the minimum SOC, so the gensets never charge the battery (the same as load following)'
        : `cycle charging to ${fmtPct(Math.min(+P.diesel.cc_setpoint, +P.bess.soc_max), 0)} SOC (the battery runs down to the minimum SOC as in load following, then the running gensets recharge it to the setpoint before it discharges again)`, predictive: 'predictive EMS (forecast-based, dynamic programming)' }[P.diesel.strategy]}</b>; ${+P.diesel.units} × ${fmtNum(P.diesel.unit_kw)} kW gensets, minimum loading ${fmtPct(P.diesel.min_load, 0)}, spinning reserve ${fmtPct(P.diesel.reserve_load, 0)} of load + ${fmtPct(P.diesel.reserve_pv, 0)} of PV and wind.</p>`;
      // With a battery, PV only (the same PV and wind without it) sits between diesel only and the hybrid.
      const V = SIM.pv_only, v = V ? V.years[0] : {}, CB = SIM.comparison_bess, pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only';
      const r3 = (l, d, p, hy) => (V ? [l, d, p, hy] : [l, d, hy]);
      const auxT = (x) => `${fmtNum((x.aux || 0) / 1000, 1)}${x.aux > 0 ? ` (${fmtPct(x.aux / (x.load - x.aux), 2)} of site load)` : ''}`;
      h += tbl([r3('Fuel (L/yr)', fmtNum(b.fuel_l), fmtNum(v.fuel_l), fmtNum(y.fuel_l)), r3('Diesel energy (MWh/yr)', fmtNum(b.gen_kwh / 1000), fmtNum(v.gen_kwh / 1000), fmtNum(y.gen_kwh / 1000)),
        r3('Genset run-hours', fmtNum(b.unit_hours), fmtNum(v.unit_hours), fmtNum(y.unit_hours)), r3('Genset starts', fmtNum(b.starts), fmtNum(v.starts), fmtNum(y.starts)),
        r3('CO₂ (t/yr)', fmtNum(b.co2_t), fmtNum(v.co2_t), fmtNum(y.co2_t)), r3('PV used (MWh/yr)', '–', fmtNum((v.pv_to_load + v.pv_to_bess) / 1000), fmtNum((y.pv_to_load + y.pv_to_bess) / 1000)),
        r3('PV curtailed (MWh/yr)', '–', fmtNum(v.pv_curtailed / 1000), fmtNum(y.pv_curtailed / 1000)), r3('Battery throughput (MWh/yr)', '–', '–', fmtNum(y.bess_dis / 1000)),
        r3('Auxiliary consumption (MWh/yr)', fmtNum((b.aux || 0) / 1000, 1), auxT(v), auxT(y))].concat(V ? [['Net present cost', fmtMoney(B.econ.npc, cur), fmtMoney(V.econ.npc, cur), fmtMoney(R.econ.npc, cur)]] : []),
        V ? ['Year 1', 'Diesel only', pvLbl, 'Hybrid'] : ['Year 1', 'Diesel only', 'Hybrid']);
      if (CB) {
        h += `<p>The battery's own value is measured against ${pvLbl === 'PV only' ? 'the same PV' : 'the same PV and wind'} without it: it saves ${fmtNum(CB.fuel_saved_l_y1)} L of fuel in year 1 and has an NPV of <b>${fmtMoney(CB.npv_savings, curH)}</b>${CB.irr != null ? ` with an IRR of ${fmtPct(CB.irr)}` : ''} on its own capex, O&amp;M, replacements and salvage${CB.npv_savings < 0 ? `. At these inputs the battery does not pay for itself${SIM.comparison.npv_savings > 0 ? ', although the hybrid as a whole does better than diesel only' : ''}` : ''}. The case without a battery keeps the hybrid's PV capacity and curtails ${fmtPct(V.curtail_fraction)} of the renewable energy; a design without a battery sized on its own is usually smaller and curtails less, so this comparison tends to flatter the battery.</p>`;
      }
      const K = calibration();
      if (K) {
        h += '<h3>Baseline against site records</h3>';
        h += `<p>${escapeHtml(K.basis)} Every result of this report is measured against this diesel-only case.</p>`;
        if (K.rows.length) h += tbl(K.rows.map((x) => [`${x.label} (${x.unit})`, calFmt(x.k, x.site), calFmt(x.k, x.model), `${calPct(x.d)} (${x.flag ? 'beyond' : 'within'} ±${fmtNum(x.tol * 100)} %)`]), ['Record', 'Site', 'Model', 'Difference']);
        if (K.monthly) {
          drawCalibration();
          h += fig(await chartImg('chCal'), 'Monthly fuel of the site records and of the modelled diesel-only case (year 1).') + `<p>${escapeHtml(K.monthNote)}</p>`;
        }
        h += `<ul>${K.diag.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
      }
      const EF = energyFlow(y), wnd = y.wind_avail > 0, hasB = y.bess_ch > 0 || y.bess_dis > 0;
      h += '<h3>Energy flow</h3>';
      h += `<p>${EF.direct != null && hasB ? `In year 1, ${fmtPct(EF.direct)} of the ${wnd ? 'PV and wind' : 'PV'} energy used goes straight to the load; the rest is stored first.` : ''}${hasB
        ? ` The battery takes ${fmtEnergy(y.bess_ch)} and returns ${fmtEnergy(y.bess_dis)}; it loses ${fmtEnergy(EF.loss)} ${y.bess_ch > 0 ? `in conversion (${fmtPct(EF.loss / y.bess_ch)} of the energy charged)` : 'in conversion on discharge (nothing was charged)'}${y.self_discharge > 0 ? ` and ${fmtEnergy(y.self_discharge)} to self-discharge` : ''}, and its stored energy changes by ${fmtEnergy(EF.dE)} over the year.` : ''}
        ${[y.pv_curtailed + y.wind_curtailed > 0 ? `${fmtEnergy(y.pv_curtailed + y.wind_curtailed)} of renewable energy is curtailed` : 'No renewable energy is curtailed',
          y.gen_dump > 0 ? `${fmtEnergy(y.gen_dump)} of genset energy at minimum loading is dumped.` : 'no genset energy is dumped.'].join(' and ')}</p>`;
      if (Math.abs(EF.gap) > 1e-3 * y.load) h += `<div class="warn">Inputs and outputs of the energy flow differ by ${fmtEnergy(EF.gap)} (${fmtPct(EF.gap / y.load, 2)} of the load).</div>`;
      drawFlow();
      h += fig(await chartImg('chFlow', 1000, 520), `Energy flow in year 1 (MWh): sources on the left, ${hasB ? 'the battery and the load' : 'the load'}, and where the energy ends.${hasB ? ' Battery losses = charged − discharged − self-discharge − change in stored energy.' : ''}`);
      if (OPTIONS) {
        const S = optionsSummary(), lbl = (x) => x.label + (x === S.best ? ' (lowest NPC)' : '') + (x.why ? ` (infeasible: ${x.why})` : '');
        const money = (v) => (v === 0 ? cur + ' 0' : fmtMoney(v, cur));
        const ok = S.rows.filter((x) => !x.err);
        h += '<h3>Operating options</h3>';
        if (S.stale) h += '<div class="warn">The inputs changed after this comparison was run. Run Compare options again on the Simulation results page for current figures.</div>';
        h += `<p>Each row simulates the project with one change: diesel only (no PV, battery or wind) as the reference, no battery, then every dispatch strategy with the battery, and the predictive EMS with perfect forecasts as a benchmark for better forecasting (not an option). ${S.fast ? 'Year 1 is simulated and repeated over the project life, without PV degradation and load growth. ' : ''}Feasible options meet the sizing constraints (unmet load, loss-of-load and reserve shortfall hours, renewable fraction, curtailment, land and capex limits). ${S.best
          ? `The lowest net present cost among them is <b>${escapeHtml(S.best.label)}</b> (${fmtMoney(S.best.npc, curH)}).${S.near.length ? ` Within 0.5 % of it, which is within model accuracy: ${S.near.map((x) => escapeHtml(x.label)).join('; ')}.` : ''}` : 'No option meets the constraints.'}</p>`;
        h += tbl(ok.map((x) => [lbl(x), fmtNum(x.fuel / 1000), fmtPct(x.re), fmtNum(x.uh), fmtNum(x.starts), fmtPct(x.load), fmtNum(x.efc), fmtNum(x.repl), fmtPct(x.curt), fmtPct(x.unmet, 3)]),
          ['Option (year 1)', 'Fuel kL', 'RE', 'Unit-h', 'Starts', 'Avg genset load', 'EFC', 'Repl.', 'Curtailed', 'Unmet']);
        h += tbl(ok.map((x) => [lbl(x), money(x.capex), money(x.npc), fmtNum(x.lcoe, 4), money(x.npv), fmtPct(x.irr), fmtPct(x.eqIrr),
          x.dnpc == null ? '–' : `${cur} ${x.dnpc < 0 ? '−' : '+'}${fmtMoney(Math.abs(x.dnpc), '').trim()}${x.close ? ' (within model accuracy)' : ''}`]),
          ['Option', 'Capex', 'NPC', 'LCOE ' + cur + '/kWh', 'NPV vs diesel only', 'IRR', 'Equity IRR', 'NPC change vs row above']);
        if (S.fall) h += fig(await chartImg('chOptFall'), 'Net present cost from diesel only to the hybrid with its best strategy: PV first, then the battery with load following, then the best strategy. The split depends on this order.');
      }
      h += '<h3>Operational adequacy</h3>' + tbl([
        ['Loss-of-load hours', fmtNum(b.lol_h), fmtNum(y.lol_h)], ['Loss-of-load events (longest, h)', `${fmtNum(b.lol_events)} (${fmtNum(b.lol_max_h)})`, `${fmtNum(y.lol_events)} (${fmtNum(y.lol_max_h)})`],
        ['Unmet energy (MWh/yr)', fmtNum(b.unmet / 1000, 1), fmtNum(y.unmet / 1000, 1)],
        ['Spinning reserve shortfall (h/yr)', fmtNum(b.reserve_short_h), fmtNum(y.reserve_short_h)], ['Largest reserve shortfall (kW)', fmtNum(b.reserve_short_max_kw), fmtNum(y.reserve_short_max_kw)],
        ['Most gensets online', `${fmtNum(b.max_units)} of ${+P.diesel.units}`, `${fmtNum(y.max_units)} of ${+P.diesel.units}`], ['Hours with the whole fleet online', fmtNum(b.fleet_full_h), fmtNum(y.fleet_full_h)],
        ['Hours at minimum loading (longest run, h)', `${fmtNum(b.minload_h)} (${fmtNum(b.minload_run_max_h)})`, `${fmtNum(y.minload_h)} (${fmtNum(y.minload_run_max_h)})`],
        ['Most gensets started in one hour', fmtNum(b.max_starts_h), fmtNum(y.max_starts_h)]], ['Year 1', 'Diesel only', 'Hybrid']);
      const wy = R.years.reduce((a, x) => (x.unmet / x.load > a.unmet / a.load ? x : a), y);
      h += `<p>Loss of load counts hours with more than 0.1 % of the load unserved; an event is a run of such hours. Reserve shortfall counts hours in which the genset headroom and battery reserve left after dispatch do not cover the spinning-reserve rule; it normally arises only when no more of the ${+P.diesel.units} gensets can be started. Low loading counts hours with every online genset at minimum loading.${wy.year !== y.year ? ` The highest unmet share is ${fmtPct(wy.unmet / wy.load, 3)} in year ${wy.year} (${fmtNum(wy.lol_h)} loss-of-load hours).` : ''}</p>`;
      h += fig(await chartImg('chMonthly'), 'Monthly energy supply (year 1).');
      const MB = monthBalance(R), dM = (v) => fmtNum(v / 1000, MB[12].load >= 1e7 ? 0 : 1);
      h += '<h3>Monthly energy balance (year 1)</h3>' + tbl(MB.map((x) => [x.label, dM(x.load), dM(x.pv), ...(wnd ? [dM(x.wind)] : []), dM(x.bess), dM(x.gen), dM(x.unmet), dM(x.curt), dM(x.dump),
        fmtNum(x.fuel / 1000), fmtPct(x.re)]), ['Month', 'Load MWh', 'PV direct', ...(wnd ? ['Wind direct'] : []), 'Battery → load', 'Diesel → load', 'Unmet', 'RE curtailed', 'Genset dump', 'Fuel kL', 'RE fraction']);
      h += `<p>Load (auxiliaries included) = PV direct${wnd ? ' + wind direct' : ''} + battery → load + diesel → load + unmet. RE fraction = 1 − diesel energy to the load and the battery ÷ energy served.</p>`;
      h += fig(await chartImg('chDispatch', 1100, 620), 'Hourly dispatch, sample week.');
      const low = weekPicks(R).re;
      if (low != null) {
        dispatchChart('chDispatchRep', R.hourly, low, 168, { socTarget: P.diesel.strategy === 'predictive' });
        h += fig(await chartImg('chDispatchRep', 1100, 620), `Hourly dispatch, week with the lowest renewable share (${dateOfHour(low)} to ${dateOfHour(low + 167)}).`);
        Plotly.purge('chDispatchRep');
      }
      h += fig(await chartImg('chGenLoad'), 'Genset loading distribution.') + fig(await chartImg('chUnitsDur'), 'Units online duration curve, hybrid and diesel only (year 1).');
      if (R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6) {
        const bh = bessHealth(R), yrs = (a) => (a.length > 1 ? 'years ' : 'year ') + yearList(a);
        h += '<h3>Battery health</h3>';
        h += `<p>State of health starts at ${fmtPct(P.bess.soh_init, 0)} and ends the project at ${fmtPct(bh.sohEnd)}. The battery is replaced at ${fmtPct(bh.thr, 0)} state of health${bh.repl.length ? `, in ${yrs(bh.repl)}` : '; no replacement falls within the project life'}.
          It runs up to ${fmtNum(bh.maxEfc)} equivalent full cycles per year (AC discharge ÷ nameplate; ${fmtNum(bh.maxEfcDc)} at the cells) at up to ${fmtNum(bh.maxC, 2)} C.
          At year-1 use a new battery lasts ${bh.life == null ? 'indefinitely (no fade)' : fmtNum(bh.life, 1) + ' years'}${bh.life == null ? '' : `, limited mainly by ${bh.cycShare > 0.5 ? 'cycling' : 'calendar fade'}`}.${bh.cap > 0 && !bh.over.length ? ` The warranty cap of ${fmtNum(bh.cap)} cycles per year is respected in every year.` : ''}</p>`;
        if (bh.over.length) h += `<div class="warn">The warranty cap of ${fmtNum(bh.cap)} cycles per year is exceeded in ${yrs(bh.over)} (up to ${fmtNum(bh.maxEfc)} cycles).</div>`;
        h += fig(await chartImg('chSoh'), 'Battery state of health with the replacement threshold and replacements.') + fig(await chartImg('chSohLoss'), 'Battery capacity lost each year to calendar and cycle fade.');
      }
      h += userFigs('simulation');
      h += H2('Economics');
      h += tbl([['PV', fmtMoney(R.econ.capex_pv, cur)], ['Battery', fmtMoney(R.econ.capex_bess, cur)], ['Wind', fmtMoney(R.econ.capex_wind || 0, cur)], ['Gensets', fmtMoney(R.econ.capex_diesel, cur)], ['Development / EPC', fmtMoney(R.econ.capex_other, cur)], ['Total', fmtMoney(R.econ.capex_total, cur)]], ['Capex', 'Amount']);
      h += fig(await chartImg('chCash'), 'Lifetime cash flow (nominal).');
      if (TORNADO) {
        const S = tornadoSummary(P.tornado.metric), ok = S.rows.filter((x) => !x.err), top = ok[0], f = (v) => escapeHtml(tornadoFmt(S.metric, v));
        h += '<h3>What drives the result</h3>';
        if (S.stale) h += '<div class="warn">The inputs changed after this tornado was run. Run it again on the Simulation results page for current figures.</div>';
        h += `<p>The design above was simulated again with one input at a time set to a low and a high value, everything else unchanged${S.fast ? ' (year 1 simulated and repeated over the project life, so PV degradation and load growth are left out)' : ''}${S.together ? '; the battery energy capex moves the power capex and the replacement price with it' : ''}.
          The base ${escapeHtml(S.name)} is ${f(S.base)}.${top && top.swing > 0 ? ` ${escapeHtml(top.label)} moves it the most: ${f(top.vLo)} at ${escapeHtml(top.vals[0])} and ${f(top.vHi)} at ${escapeHtml(top.vals[1])}.` : ''}
          Cycle life and calendar fade move the battery replacement year in whole-year steps, so their bars can be lumpy and asymmetric.</p>`;
        h += fig(await chartImg('chTornado', 1000, Math.max(300, 100 + 30 * ok.length)), `${S.name}: change from the base value at the low and the high value of each input, largest swing on top.`);
        h += tbl(S.rows.map((x) => [x.label, x.vals[0], x.vals[1]].concat(x.err ? [x.err, '', ''] : [tornadoFmt(S.metric, x.vLo), tornadoFmt(S.metric, x.vHi), S.base == null || (x.vLo == null && x.vHi == null) ? '–' : tornadoSwing(S.metric, x.swing)])),
          ['Input', 'Low value', 'High value', S.name + ' at low', S.name + ' at high', 'Swing']);
      }
      h += '<h3>Year-by-year</h3>' + tbl(R.years.map((x) => [x.year, fmtNum(x.load / 1000), fmtNum(x.fuel_l / 1000), fmtPct(x.re_fraction), fmtNum(x.bess_soh * 100, 1) + ' %', fmtNum(x.bess_efc), x.bess_replaced ? 'yes' : '', fmtNum(x.c_total)]), ['Year', 'Load MWh', 'Fuel kL', 'RE', 'BESS SOH', 'EFC', 'Repl.', 'Cost ' + cur]);
    }
    if (SIM && SIM.finance) {
      const R = SIM.finance, m = R.metrics, f = P.finance, host = R.model === 'host';
      const names = { host: 'host-owned (avoided diesel cost as revenue)', ppa: 'single owner selling energy under a PPA', tpo: 'third-party ownership (developer PPA / lease to the host)' };
      h += H2('Project finance');
      h += `<p>Structure: <b>${names[R.model]}</b>. Annual after-tax cash flow over ${m.term} years, using the simulated energy and costs of each year. Debt ${fmtPct(m.debt_fraction, 1)} of total installed cost (${{ min: 'lower of gearing and DSCR sculpting', dscr: 'DSCR sculpting' }[f.sizing] || 'gearing'}), ${fmtPct(f.interest)} over ${Math.min(+f.tenor, m.term)} years, ${{ annuity: 'annuity', equal: 'equal-principal' }[f.repayment] || 'sculpted'} repayment${f.p90_factor < 1 ? `, sized on revenue × ${+f.p90_factor} (P90 ÷ P50${P.resource_years.applied && P.resource_years.applied.p90_factor === f.p90_factor ? ' of revenue from the inter-annual variability run' : ''})` : ''}; income tax ${fmtPct(f.tax_rate)}${f.sme_31e ? ' with the Art. 31E reduced rate' : ''}; depreciation ${f.dep_method === 'db' ? 'declining balance' : 'straight line'} over ${+f.dep_life} years (battery ${+f.dep_life_bess}).</p>`;
      h += tbl([['Equity IRR (after tax)', fmtPct(m.equity_irr, 2)], ['Project IRR (after tax)', fmtPct(m.project_irr, 2)],
        ['Equity NPV', fmtMoney(m.equity_npv, cur)], ['Project NPV', fmtMoney(m.project_npv, cur)], [host ? 'Avoided cost, year 1' : 'Tariff, year 1', `${cur} ${fmtNum(m.tariff_y1, 4)}/kWh`],
        ...(host ? [] : [['Levelised PPA price (nominal / real)', `${fmtNum(m.lppa_nominal, 4)} / ${fmtNum(m.lppa_real, 4)} ${cur}/kWh`]]),
        ['LCOE, unlevered pre-tax (nominal / real)', `${fmtNum(m.lcoe_nominal, 4)} / ${fmtNum(m.lcoe_real, 4)} ${cur}/kWh`],
        ['Minimum / average DSCR, LLCR', m.dscr_min == null ? 'no debt' : `${fmtNum(m.dscr_min, 2)} / ${fmtNum(m.dscr_avg, 2)}, ${fmtNum(m.llcr, 2)}`],
        ['Total installed cost (incl. IDC, fees, DSRA)', fmtMoney(m.total_installed_cost, cur)], ['Debt / equity', `${fmtMoney(m.debt, cur)} / ${fmtMoney(m.equity, cur)}`],
        ['Equity payback', m.equity_payback == null ? 'not reached' : fmtNum(m.equity_payback, 1) + ' years'],
        ...(host ? [] : [['Host saving vs diesel only', `${fmtPct(m.host_saving_pct, 1)} (NPV ${fmtMoney(m.host_npv_savings, cur)})`]])], ['Metric', 'Value']);
      if (R.solved && R.solved.ok) h += `<p>The tariff was solved for a ${fmtPct(f.target_irr)} ${escapeHtml(f.solve_for)} IRR.</p>`;
      h += fig(await chartImg('chFinCash'), 'After-tax cash flow to equity.') + fig(await chartImg('chFinCum'), 'Cumulative cash flow.') + fig(await chartImg('chFinDscr'), 'Debt service cover ratio by year.') + fig(await chartImg('chFinHost'), host ? 'Avoided diesel cost vs cost of the new assets.' : 'Host energy cost with and without the plant.');
      const keys = [['revenue', host ? 'Avoided cost' : 'Revenue'], ['opex', 'Operating cost'], ['ebitda', 'EBITDA'], ['tax', 'Income tax'], ['cfads', 'CFADS'], ['debt_service', 'Debt service'], ['dscr', 'DSCR'], ['equity_cf', 'Equity cash flow']];
      h += '<h3>Annual cash flow (summary)</h3>' + tbl(R.years.map((y) => [y.year, ...keys.map(([k]) => (y[k] == null ? '' : k === 'dscr' ? fmtNum(y[k], 2) : fmtNum(y[k])))]), ['Year', ...keys.map((k) => k[1])]);
    }
    if (OPT && OPT.best) {
      const b = OPT.best;
      h += H2('Sizing optimisation');
      h += `<p>${fmtNum(OPT.n_evaluated)} configurations were simulated over the full project life (${OPT.settings.algorithm || 'grid search + pattern search'}); ${fmtNum(OPT.n_feasible)} met the constraints. Optimum: <b>${fmtNum(b.pv_kwp)} kWp PV, ${fmtNum(b.bess_kwh)} kWh / ${fmtNum(b.bess_kw)} kW BESS</b>${b.wind_units ? `, ${b.wind_units} wind turbines` : ''} (NPC ${fmtMoney(b.npc, curH)}, LCOE ${fmtNum(b.lcoe, 4)} ${curH}/kWh, RE ${fmtPct(b.re)}).</p>`;
      h += fig(await chartImg('chOptHeat', 900, 520), 'Search-space map.') + fig(await chartImg('chPareto', 900, 520), 'Cost vs renewable fraction.') + fig(await chartImg('chSens'), 'Sensitivity of the optimum.');
      h += tbl(OPT.ranked.slice(0, 10).map((r, i) => [i + 1, fmtNum(r.pv_kwp), fmtNum(r.bess_kwh), fmtMoney(r.npc, cur), fmtNum(r.lcoe, 4), fmtPct(r.re)]), ['#', 'PV kWp', 'BESS kWh', 'NPC', 'LCOE', 'RE']);
    }
    if (ForecastLab.result) {
      const B = ForecastLab.result;
      h += H2('Forecasting and energy management');
      h += '<p>Every method except "Perfect forecast" and "Perfect + random error" uses only data available before the forecast issue time. Errors are normalised by the mean actual value; skill = 1 − nRMSE / nRMSE of persistence.</p>';
      for (const v of ['pv', 'load']) h += `<h3>${v === 'pv' ? 'PV' : 'Load'}</h3>` + tbl(B[v].methods.map((m) => [m.name, fmtPct(m.nmae[0]), fmtPct(m.nmae[23]), m.skill[23].toFixed(3)]), ['Method', 'nMAE 1 h', 'nMAE 24 h', 'Skill 24 h']);
      h += fig(await chartImg('chBenchLead'), 'Forecast error vs horizon.');
    }
    const rest = userFigures().filter((f) => !shown.has(f));
    if (rest.length) h += H2('Additional figures') + rest.map((f) => fig(f.src, f.caption || 'Figure supplied with the project.', 'user')).join('');
    h += H2('Method and assumptions');
    h += `<ul><li>Hourly chronological simulation over ${P.sim.all_years ? 'every project year (PV degradation, battery ageing and replacement, load growth)' : 'year 1, repeated'}.</li>
      <li>PV: Hay-Davies transposition, infinite-row beam shading, ASHRAE IAM, ${P.pv.thermal_model === 'noct' ? 'NOCT' : 'heat-loss factor (Uc/Uv)'} thermal model, DC/AC loss chain with inverter clipping; DC wiring loss ${P.pv.dc_wiring_basis === 'stc' ? 'stated at STC power and scaled with the hourly string current over voltage (I²R)' : 'as a constant fraction'}.</li>
      <li>Diesel: unit commitment with spinning reserve and minimum loading, at most ${+P.diesel.units} units online; ${P.bess.provides_reserve ? `spare battery power counts as reserve up to what its stored energy sustains for ${+P.bess.reserve_duration_h} h` : 'the battery does not count as reserve'}; fuel from part-load curve.</li>
      <li>Battery: SOC window, round-trip efficiency${P.bess.self_discharge ? `, self-discharge ${fmtPct(P.bess.self_discharge, 3)}/h` : ''}; calendar fade ${fmtPct(P.bess.calendar_fade)}/yr plus cycle fade, with cycles counted at the cells (DC) against ${fmtNum(P.bess.cycle_life)} cycles at ${fmtPct(P.bess.cycle_life_dod, 0)} depth of discharge to ${fmtPct(P.bess.eol_soh, 0)}; replacement at ${fmtPct(bessThreshold(), 0)} state of health${P.bess.soh_init < 1 ? `, initial state of health ${fmtPct(P.bess.soh_init, 0)}` : ''}.</li>
      <li>${auxText()}</li>
      <li>Economics: nominal discounted cash flow, ${+P.econ.lifetime} years, discount rate ${fmtPct(P.econ.discount_rate)}, diesel ${curH} ${+P.econ.fuel_price}/L escalating ${fmtPct(P.econ.fuel_escalation)}/yr. NPV, IRR and payback of the hybrid on the incremental cash flow against diesel only; the battery's own value on the same cash flow against the same PV and wind without a battery.</li>
      <li>Equipment marked "Generic" uses typical values, not manufacturer data. Results are for feasibility assessment, not construction.</li></ul>`;
    const css = `body{font:11pt/1.5 Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:1000px;margin:24px auto;padding:0 28px}
      .cover{border-bottom:3px solid #1a1a1a;padding:40px 0 24px;margin-bottom:24px}.cover .logo svg{display:block;height:30px;width:auto;margin-bottom:22px}.cover .tag{letter-spacing:.15em;font-size:9pt;color:#555}.cover h1{font-size:26pt;margin:8px 0}.sub{color:#444;font-size:12pt}
      h2{font-size:15pt;border-bottom:1px solid #bbb;padding-bottom:4px;margin-top:32px;page-break-after:avoid}h3{font-size:11.5pt;margin:18px 0 6px}
      table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:9.5pt;page-break-inside:avoid}th,td{border:1px solid #ccc;padding:4px 7px;text-align:left}th{background:#f1f1f1}td.n{text-align:right;font-variant-numeric:tabular-nums}
      table.meta td{border:none;padding:2px 12px 2px 0}figure{margin:12px 0 20px;page-break-inside:avoid}figure img,figure svg{width:100%;height:auto;border:1px solid #ddd}figure.layout svg{max-height:900px}figure.user img{width:auto;max-width:100%;max-height:850px;display:block;margin:0 auto}figcaption{font-size:9pt;color:#555;margin-top:4px}
      .warn{border:1px solid #c98500;background:#fff8e6;padding:8px 12px;font-size:9.5pt}@media print{body{margin:0;max-width:none}h2{page-break-before:auto}figure.sld{page-break-before:always}}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Soloptima report: ${escapeHtml(P.name || 'project')}</title><style>${css}</style></head><body>${h}</body></html>`;
  }

  async function exportHtml() {
    await freshSim();
    toast('Building report…');
    const html = await build();
    download((P.name || 'project').replace(/[^\w\- ]+/g, '_') + '_report.html', html, 'text/html');
  }
  // Printed from a hidden frame that cannot run scripts, so nothing in the report can act in the app (and no pop-up is needed).
  async function printPdf() {
    await freshSim();
    toast('Building report…');
    const html = await build(), old = $('#printFrame');
    if (old) old.remove();
    const f = document.createElement('iframe');
    f.id = 'printFrame'; f.setAttribute('sandbox', 'allow-same-origin allow-modals'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:1400px;border:0';
    f.onload = () => setTimeout(() => {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { toast('Printing failed. Use "Download report (HTML)" and print it from the browser.', true); }
    }, 300);
    f.srcdoc = html;
    document.body.appendChild(f);
  }
  let previewSeq = 0;   // a slow build (the satellite image takes seconds) must not replace a newer one
  async function preview() {
    const n = ++previewSeq;
    $('#report').innerHTML = '<p class="hint">Building preview…</p>';
    const html = await build();
    if (n !== previewSeq) return;
    const f = document.createElement('iframe'); f.className = 'report-frame'; f.setAttribute('sandbox', ''); f.srcdoc = html; $('#report').replaceChildren(f);
  }
  function clearCache() { const n = [...imgCache.values()].filter(Boolean).length; imgCache.clear(); return n; }
  return { exportXlsx, exportHtml, printPdf, preview, xlsx, renderFigures, initFigures, cleanReport, clearCache };
})();
