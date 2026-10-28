// Project finance: ownership structure, presets, tariff components, results, cash-flow table.
'use strict';

const Finance = (() => {
  const F = () => P.finance;
  const isHost = () => F().model === 'host';

  const PRESETS = {
    generic: () => ({ tax_rate: 0.25, wht_pct: 0, sme_31e: false, gearing: 0.7, interest: 0.08, tenor: 12, grace: 0, repayment: 'sculpted', sizing: 'min',
      dscr_target: 1.3, dsra_months: 6, insurance_pct: 0.005, construction_years: 1, upfront_fee: 0.02, contingency_pct: 0.02, vat_pct: 0,
      receivable_days: 30, payable_days: 30, take_or_pay: 0, stage2_year: 0, tariff_mode: 'components', tariff_vat: 0, terminal: 'salvage',
      dep_method: 'sl', dep_life: 20, dep_life_bess: 10, dep_preset: 'sl_20', loss_cf_years: 5,
      components: [{ name: 'Energy tariff', v1: 0.12, v2: 0.12, idx: 0.02, pct: 0 }] }),
    // Indonesian IPP selling PV + BESS energy to PLN (staged A/B/E/F tariff)
    pln: () => {
      const fx = P.econ.currency === 'IDR' ? 1 : 15500;
      return { model: 'ppa', term: 20, tariff_mode: 'components', stage2_year: 11,
        components: [{ name: 'A (capital)', v1: 0.085, v2: 0.035, idx: 0, pct: 0 }, { name: 'B (fixed O&M)', v1: 0.025, v2: 0.025, idx: 0, pct: 0 },
                     { name: 'E (special facility)', v1: 0, v2: 0, idx: 0, pct: 0.3 }, { name: 'F (BESS)', v1: 0, v2: 0, idx: 0, pct: 0.6 }],
        take_or_pay: 0, ace_factor: 1, penalty_threshold: 0.9, penalty_rate: 0, tariff_vat: 0, solve: false,
        tax_rate: 0.22, wht_pct: 0.02, sme_31e: true, sme_low: Math.round(4.8e9 / fx), sme_high: Math.round(50e9 / fx), loss_cf_years: 5, tax_holiday_years: 0,
        dep_preset: 'id_g4', dep_method: 'db', dep_life: 20, dep_life_bess: 8,
        gearing: 0.7, interest: 0.074, tenor: 10, grace: 0, repayment: 'sculpted', sizing: 'min', dscr_target: 1.2, upfront_fee: 0.02, dsra_months: 6,
        construction_years: 1, contingency_pct: 0.02, vat_pct: 0.11, vat_recoverable: false, insurance_pct: 0.009, receivable_days: 60, payable_days: 30,
        terminal: 'transfer', equity_discount: 0.12 };
    },
    // Developer owns PV + BESS and sells kWh to an industrial host that keeps its gensets
    lease: () => {
      const fx = P.econ.currency === 'IDR' ? 1 : 15500;
      return { model: 'tpo', term: 20, tariff_mode: 'components', stage2_year: 0,
        components: [{ name: 'Lease tariff', v1: 0.15, v2: 0.15, idx: 0.015, pct: 0 }],
        take_or_pay: 0.9, ace_factor: 1, deemed_share: 0, tariff_vat: 0.11, solve: false,
        tax_rate: 0.22, wht_pct: 0.02, sme_31e: true, sme_low: Math.round(4.8e9 / fx), sme_high: Math.round(50e9 / fx), loss_cf_years: 5,
        dep_preset: 'sl_20', dep_method: 'sl', dep_life: 20, dep_life_bess: 10,
        gearing: 0.7, interest: 0.10, tenor: 10, grace: 0, repayment: 'equal', sizing: 'gearing', dscr_target: 1.2, upfront_fee: 0.01, dsra_months: 0,
        construction_years: 0, insurance_pct: 0.003, receivable_days: 30, payable_days: 30, terminal: 'transfer' };
    },
    diesel: () => ({ model: 'tpo', tariff_mode: 'diesel_discount', diesel_discount: 0.25, take_or_pay: 0.9, solve: false }),
  };
  const DEP = { id_g2: ['db', 8, 8], id_g3: ['db', 16, 8], id_g4: ['db', 20, 8], sl_20: ['sl', 20, 10], sl_term: ['sl', 0, 0] };

  function init() {
    $$('#finModels .model-card').forEach((c) => c.addEventListener('click', () => { F().model = c.dataset.v; onFieldChange('finance.model'); syncForms(P); }));
    $$('[data-fpreset]').forEach((b) => b.addEventListener('click', () => {
      Object.assign(F(), PRESETS[b.dataset.fpreset]());
      syncForms(P); paint(); autosave();
      toast(`Applied "${b.textContent}" terms. These are starting values; check them against the term sheet.`);
    }));
    $('#btnFin').onclick = async () => { await runSim(); showTab('fin'); };
    $('#btnFinCsv').onclick = exportCsv;
    paint();
  }
  // called from onFieldChange
  function onKey(key) {
    if (key === 'finance.dep_preset' && DEP[F().dep_preset]) {
      const [m, a, b] = DEP[F().dep_preset];
      const term = F().term || P.econ.lifetime;
      Object.assign(F(), { dep_method: m, dep_life: a || term, dep_life_bess: b || term });
      syncForms(P);
    } else if (/^finance\.dep_(method|life)/.test(key)) { F().dep_preset = 'custom'; syncForms(P); }
    paint();
  }
  function paint() {
    $$('#finModels .model-card').forEach((c) => c.classList.toggle('on', c.dataset.v === F().model));
    renderComponents();
    // where the debt-sizing haircut comes from, while it still holds the value "Use for debt sizing" set
    const A = P.resource_years && P.resource_years.applied, src = $('#finP90Src'), on = !!A && A.p90_factor === F().p90_factor;
    src.hidden = !on;
    if (on) src.textContent = `Revenue haircut ${A.p90_factor}: revenue P90 ÷ P50 of ${A.basis === 10 ? 'a 10-year average' : 'one year'} from the inter-annual variability run (Solar resource, ${A.database} ${A.from}–${A.to}).`;
  }

  function renderComponents() {
    const box = $('#finComps');
    if (isHost()) { box.innerHTML = '<p class="hint">Revenue of a host-owned plant is the avoided diesel cost: fuel, genset O&M and carbon cost of the diesel-only case minus what remains with the hybrid, taken year by year from the simulation.</p>'; return; }
    if (F().tariff_mode !== 'components') { box.innerHTML = '<p class="hint">Tariff each year = (1 − discount) × the diesel-only fuel + genset O&M cost per kWh, so it follows the fuel price escalation.</p>'; return; }
    const st2 = F().stage2_year > 0, cur = escapeHtml(P.econ.currency);
    box.innerHTML = `<table class="data comp-table" style="margin-top:12px"><tr><th>Component</th><th>Stage 1 ${cur}/kWh</th>${st2 ? `<th>Stage 2</th>` : ''}<th>Index %/yr</th><th>% of fixed</th><th></th></tr>${
      F().components.map((c, i) => `<tr><td><input class="name" data-ci="${i}" data-cf="name" value="${escapeHtml(c.name)}"></td>
        <td><input type="number" step="0.0001" data-ci="${i}" data-cf="v1" value="${+c.v1}" ${c.pct > 0 ? 'disabled' : ''}></td>
        ${st2 ? `<td><input type="number" step="0.0001" data-ci="${i}" data-cf="v2" value="${+c.v2}" ${c.pct > 0 ? 'disabled' : ''}></td>` : ''}
        <td><input type="number" step="0.1" data-ci="${i}" data-cf="idx" value="${+(c.idx * 100).toFixed(4)}"></td>
        <td><input type="number" step="1" data-ci="${i}" data-cf="pct" value="${+(c.pct * 100).toFixed(4)}"></td>
        <td><button class="btn ghost small" data-cdel="${i}" title="Remove">✕</button></td></tr>`).join('')}</table>
      <div class="row gap"><button class="btn small" id="compAdd">+ Component</button>
      <span class="hint inline" style="margin:0">"% of fixed" makes an adder on the sum of the fixed components, e.g. PLN component F = 60 % × (A + B).</span></div>`;
    $$('[data-ci]', box).forEach((inp) => inp.addEventListener('change', () => {
      const c = F().components[+inp.dataset.ci], k = inp.dataset.cf;
      c[k] = k === 'name' ? inp.value : (k === 'idx' || k === 'pct' ? (+inp.value || 0) / 100 : +inp.value || 0);
      if (k === 'v1' && !st2) c.v2 = c.v1;
      if (k === 'pct') $$(`[data-ci="${inp.dataset.ci}"][data-cf^="v"]`, box).forEach((x) => (x.disabled = c.pct > 0));
      autosave();
    }));
    $$('[data-cdel]', box).forEach((b) => b.addEventListener('click', () => { F().components.splice(+b.dataset.cdel, 1); autosave(); renderComponents(); }));
    $('#compAdd').onclick = () => { F().components.push({ name: 'New component', v1: 0, v2: 0, idx: 0, pct: 0 }); autosave(); renderComponents(); };
  }

  // ------------------------------------------------------------------------------------------- results
  function render() {
    const R = SIM && SIM.finance;
    $('#finEmpty').hidden = !!R; $('#finBody').hidden = !R;
    if (!R) return;
    const m = R.metrics, cur = P.econ.currency, Y = R.years, c = COL(), host = R.model === 'host';
    const hov = (t) => ({ ...t, hovertemplate: 'year %{x}: %{y:,.0f} ' + cur + '<extra>' + t.name + '</extra>' });
    const sv = R.solved;
    $('#finSolved').hidden = !sv;
    if (sv) $('#finSolved').innerHTML = sv.ok ? `Tariff solved for a ${fmtPct(F().target_irr)} ${escapeHtml(F().solve_for)} IRR: the input tariff scaled by <b>${fmtNum(m.tariff_scale, 4)}</b> → year-1 tariff <b>${escapeHtml(cur)} ${fmtNum(m.tariff_y1, 4)}/kWh</b>.` : '⚠ ' + escapeHtml(sv.reason);
    const yrs = (x) => (x == null ? 'never' : fmtNum(x, 1) + ' yr');
    $('#finKpis').innerHTML = kpis([
      ['Equity IRR (after tax)', fmtPct(m.equity_irr, 2), `NPV ${fmtMoney(m.equity_npv, cur)} at ${fmtPct(F().equity_discount)}`, true],
      ['Project IRR (after tax)', fmtPct(m.project_irr, 2), `NPV ${fmtMoney(m.project_npv, cur)} at ${fmtPct(P.econ.discount_rate)}`, true],
      [host ? 'Avoided cost, year 1' : 'Tariff, year 1', `${cur} ${fmtNum(m.tariff_y1, 4)}`, host ? 'per kWh of renewable energy' : `LPPA ${fmtNum(m.lppa_nominal, 4)} nominal · ${fmtNum(m.lppa_real, 4)} real`, true],
      ['LCOE (unlevered, pre-tax)', `${cur} ${fmtNum(m.lcoe_nominal, 4)}`, `real ${fmtNum(m.lcoe_real, 4)} /kWh`],
      ['Equity payback', yrs(m.equity_payback), `project ${yrs(m.project_payback)}`],
      ['Minimum DSCR', fmtNum(m.dscr_min, 2), m.dscr_avg == null ? 'no debt' : `average ${fmtNum(m.dscr_avg, 2)} · LLCR ${fmtNum(m.llcr, 2)}`],
      ['Debt', fmtMoney(m.debt, cur), `${fmtPct(m.debt_fraction, 1)} of total cost · DSCR capacity ${fmtMoney(m.debt_dscr_capacity, cur)}`],
      ['Total installed cost', fmtMoney(m.total_installed_cost, cur), `hard ${fmtMoney(m.hard_capex, cur)} · IDC ${fmtMoney(m.idc, cur)} · fee ${fmtMoney(m.financing_fee, cur)}`],
      ['Equity', fmtMoney(m.equity, cur), `DSRA at COD ${fmtMoney(m.dsra_initial, cur)}`],
      ...(host ? [] : [['Host savings vs diesel', fmtPct(m.host_saving_pct, 1), `NPV ${fmtMoney(m.host_npv_savings, cur)} over ${m.term} yr`],
        ['PLN-style levelised tariff', `${cur} ${fmtNum(m.pln_levelised_tariff, 4)}`, 'annuity of the tariff series']]),
    ]);
    const yr = Y.map((y) => y.year);
    plot('chFinCash', [{ type: 'bar', x: yr, y: Y.map((y) => y.equity_cf), marker: { color: Y.map((y) => (y.equity_cf >= 0 ? c.gen : c.unmet)), cornerradius: 3 },
      hovertemplate: 'year %{x}: %{y:,.0f} ' + cur + '<extra></extra>' }], { showlegend: false, xaxis: { title: { text: 'Year (0 = construction / COD)' } }, yaxis: { title: { text: cur } } });
    plot('chFinCum', [
      { type: 'scatter', mode: 'lines', name: 'Equity', x: yr, y: R.equity_cum, line: { color: c.gen, width: 2.5 } },
      { type: 'scatter', mode: 'lines', name: 'Project (unlevered)', x: yr, y: R.project_cum, line: { color: c.text2, width: 2, dash: 'dash' } },
    ].map(hov),
      { xaxis: { title: { text: 'Year' } }, yaxis: { title: { text: cur + ' cumulative' }, zeroline: true }, hovermode: 'x unified' });
    const dy = Y.filter((y) => y.dscr != null);
    plot('chFinDscr', dy.length ? [{ type: 'bar', x: dy.map((y) => y.year), y: dy.map((y) => y.dscr), marker: { color: c.bess, cornerradius: 3 }, hovertemplate: 'year %{x}: DSCR %{y:.2f}<extra></extra>' }] : [],
      { showlegend: false, xaxis: { title: { text: 'Year' } }, yaxis: { title: { text: 'CFADS / debt service' }, rangemode: 'tozero' },
        shapes: dy.length ? [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: F().dscr_target, y1: F().dscr_target, line: { color: c.unmet, dash: 'dot', width: 1.5 } }] : [],
        annotations: dy.length ? [] : [{ text: 'No debt', showarrow: false, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, font: { color: c.muted } }] });
    const op = Y.slice(1);
    if (host) {
      $('#finHostCard').querySelector('h3').textContent = 'Avoided diesel cost vs cost of the new assets';
      plot('chFinHost', [
        { type: 'bar', name: 'Avoided diesel cost', x: op.map((y) => y.year), y: op.map((y) => y.revenue), marker: { color: c.bess } },
        { type: 'bar', name: 'O&M, insurance, replacements', x: op.map((y) => y.year), y: op.map((y) => -y.opex), marker: { color: c.unmet } },
      ].map(hov), { barmode: 'relative', yaxis: { title: { text: cur } }, xaxis: { title: { text: 'Year' } } });
    } else {
      $('#finHostCard').querySelector('h3').textContent = 'Host energy cost: diesel only vs with the plant';
      plot('chFinHost', [
        { type: 'scatter', mode: 'lines', name: 'Diesel only', x: op.map((y) => y.year), y: op.map((y) => y.host_baseline), line: { color: c.unmet, width: 2.5 } },
        { type: 'scatter', mode: 'lines', name: 'With the plant (tariff + remaining diesel)', x: op.map((y) => y.year), y: op.map((y) => y.host_cost), line: { color: c.gen, width: 2.5 } },
      ].map(hov), { yaxis: { title: { text: cur + ' per year' }, rangemode: 'tozero' }, xaxis: { title: { text: 'Year' } }, hovermode: 'x unified' });
    }
    renderTable(R);
  }

  const ROWS = (host) => [
    ['g', 'Energy'], ['energy', 'Renewable energy delivered (kWh)'], ...(host ? [] : [['billed', 'Energy billed (kWh)'], ['ace', 'Contracted energy (kWh)']]),
    ['tariff', host ? 'Avoided cost per kWh' : 'Tariff per kWh', 4],
    ['g', 'Operating cash flow'], ['revenue', host ? 'Avoided diesel cost' : 'Revenue'], ['opex_om', '– O&M (PV, BESS, wind)'], ['replacements', '– Replacements'],
    ['fixed_opex', '– Fixed opex & land lease'], ['insurance', '– Insurance'], ['opex', 'Total operating cost', 0, 'total'], ['ebitda', 'EBITDA', 0, 'total'],
    ['g', 'Tax'], ['depreciation', 'Depreciation'], ['interest', 'Interest'], ['taxable', 'Taxable income'], ['tax', 'Income tax'], ...(host ? [] : [['wht', 'Withholding (credited)']]),
    ['net_income', 'Net income', 0, 'total'],
    ['g', 'Debt'], ['cfads', 'Cash flow available for debt service', 0, 'total'], ['debt_balance', 'Opening debt balance'], ['principal', 'Principal'],
    ['debt_service', 'Debt service'], ['dscr', 'DSCR', 2], ['dsra', 'DSRA balance'],
    ['g', 'Returns'], ['d_wc', 'Change in working capital'], ['project_cf', 'Project cash flow (unlevered, after tax)', 0, 'total'], ['equity_cf', 'Equity cash flow (after tax)', 0, 'total'],
    ...(host ? [] : [['g', 'Host'], ['host_baseline', 'Diesel-only cost'], ['host_cost', 'Cost with the plant'], ['host_saving', 'Host saving', 0, 'total']]),
  ];
  function renderTable(R) {
    const Y = R.years, host = R.model === 'host';
    const head = `<tr><th>${escapeHtml(P.econ.currency)}</th>${Y.map((y) => `<th>${y.year}</th>`).join('')}</tr>`;
    const body = ROWS(host).map(([k, label, dp, cls]) => k === 'g' ? `<tr class="group"><td colspan="${Y.length + 1}">${label}</td></tr>`
      : `<tr class="${cls || ''}"><td>${label}</td>${Y.map((y) => `<td>${y[k] == null ? '' : fmtNum(y[k], dp || 0)}</td>`).join('')}</tr>`).join('');
    $('#finTable').innerHTML = `<table class="data">${head}${body}</table>`;
  }
  function exportCsv() {
    const R = SIM && SIM.finance; if (!R) return;
    const host = R.model === 'host';
    const lines = [['Item'].concat(R.years.map((y) => 'Y' + y.year)).join(',')];
    ROWS(host).filter((r) => r[0] !== 'g').forEach(([k, label]) => lines.push(['"' + label + '"'].concat(R.years.map((y) => (y[k] == null ? '' : +(+y[k]).toFixed(4)))).join(',')));
    download((P.name || 'project') + '_cashflow.csv', lines.join('\n'), 'text/csv');
  }
  return { init, onKey, render, paint, ROWS };
})();
