// Forecast Lab: benchmark every PV / load forecasting method and its value to the EMS.
'use strict';

const ForecastLab = (() => {
  let B = null, variable = 'pv', horizon = 'da';
  const picked = { pv: new Set(), load: new Set() };
  // Fixed colour per method (identity is stable across PV / load and every chart).
  const METHOD_COLOR = { smart_persistence: '#2a78d6', profile: '#2a78d6', ensemble: '#eb6834', ets: '#1baf7a', rls: '#eda100',
                         analog: '#e87ba4', climatology: '#008300', persistence: '#6250d6', weekly: '#e34948', mlp: '#8a5a00' };
  const colorOf = (id, c) => (id === 'perfect' ? c.text2 : METHOD_COLOR[id] || c.muted);

  function init() {
    $('#btnBench').onclick = run;
    $('#benchMetric').onchange = draw;
    $('#benchWeek').oninput = drawSeries;
    segmented('#benchVar', (v) => { variable = v; draw(); });
    segmented('#benchHorizon', (v) => { horizon = v; drawSeries(); });
  }
  function segmented(sel, cb) {
    $$(sel + ' button').forEach((b) => b.addEventListener('click', () => {
      $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b)); cb(b.dataset.v);
    }));
  }

  async function run() {
    if (!requireInputs()) return;
    setStatus('#benchStatus', 'Benchmarking all methods and re-running the EMS with each…');
    await busy('#btnBench', async () => {
      try {
        const t0 = performance.now();
        B = await api('/api/forecast/benchmark', { project: engineProject(), with_value: true });
        setStatus('#benchStatus', `✓ done in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
        for (const v of ['pv', 'load']) {
          picked[v] = new Set([v === 'pv' ? P.ems.pv_forecast : P.ems.load_forecast, 'persistence']);
        }
        $('#benchBody').hidden = false;
        draw();
      } catch (e) { setStatus('#benchStatus', e.message, 'err'); }
    });
  }

  function valueOf(id) {
    if (!B || !B.value) return null;
    const ref = B.value.find((v) => v.kind === 'reference');
    const v = B.value.find((x) => x.kind === variable && x.id === id);
    if (!ref || !v) return null;
    return { fuel: ref.fuel_l - v.fuel_l, hours: ref.unit_hours - v.unit_hours, npc: ref.npc - v.npc };
  }

  function draw() {
    if (!B) return;
    const metric = $('#benchMetric').value, blk = B[variable], c = COL(), cur = P.econ.currency;
    const inUse = variable === 'pv' ? P.ems.pv_forecast : P.ems.load_forecast;
    const leads = Array.from({ length: 48 }, (_, i) => i + 1);
    const scale = metric === 'skill' ? 1 : 100;
    const traces = blk.methods.filter((m) => m.id !== 'perfect' && !(metric === 'skill' && m.id === 'persistence')).map((m) => ({
      type: 'scatter', mode: 'lines', name: m.name, x: leads, y: m[metric].map((v) => v * scale),
      line: { color: colorOf(m.id, c), width: m.id === inUse ? 3.5 : 2, dash: m.id === 'noisy' ? 'dot' : 'solid' },
      hovertemplate: `%{x} h: %{y:.${metric === 'skill' ? 3 : 1}f}${metric === 'skill' ? '' : ' %'}<extra>${m.name}</extra>`,
    }));
    plot('chBenchLead', traces, {
      xaxis: { title: { text: 'Forecast horizon (hours after last measurement)' }, dtick: 6 },
      yaxis: { title: { text: { nmae: 'nMAE (%)', nrmse: 'nRMSE (%)', skill: 'Skill vs persistence', bias: 'Bias (%)' }[metric] }, zeroline: true },
      legend: { orientation: 'h', y: -0.25 }, hovermode: 'x unified',
    });

    const methods = blk.methods.filter((m) => m.id !== 'noisy');
    const vals = methods.map((m) => ({ m, v: valueOf(m.id) })).filter((x) => x.v);
    if (vals.length) {
      plot('chBenchValue', [{
        type: 'bar', orientation: 'h', y: vals.map((x) => x.m.name), x: vals.map((x) => x.v.fuel / 1000),
        marker: { color: vals.map((x) => colorOf(x.m.id, c)), cornerradius: 4 },
        text: vals.map((x) => `${fmtNum(x.v.fuel / 1000, 0)} kL · ${fmtNum(x.v.hours)} h`), textposition: 'auto', textfont: { color: c.text },
        hovertemplate: '%{y}<br>fuel saved %{x:,.0f} kL/yr vs load following<extra></extra>',
      }], { xaxis: { title: { text: 'Fuel saved vs load following, year 1 (kL)' } }, yaxis: { autorange: 'reversed', automargin: true }, showlegend: false, margin: { l: 10, r: 10, t: 10, b: 44 } });
    }
    if (B.value_note) setStatus('#benchStatus', B.value_note, '');

    const best24 = methods.filter((m) => m.id !== 'perfect').reduce((a, m) => (m.nrmse[23] < a.nrmse[23] ? m : a));
    $('#benchTable').innerHTML = `<table class="data"><tr><th>Method</th><th>nMAE 1 h</th><th>nMAE 6 h</th><th>nMAE 24 h</th><th>Skill 24 h</th><th>Fuel saved kL/yr</th><th>Genset h saved</th><th>NPC saving</th><th></th></tr>${
      blk.methods.map((m) => {
        const v = valueOf(m.id);
        return `<tr><td title="${escapeHtml(m.description)}"><span class="chip-dot" style="background:${colorOf(m.id, c)}"></span>${escapeHtml(m.name)}${m.id === best24.id ? '<span class="tag good">best day-ahead</span>' : ''}${m.id === inUse ? '<span class="tag">in use</span>' : ''}</td>
          <td>${fmtPct(m.nmae[0])}</td><td>${fmtPct(m.nmae[5])}</td><td>${fmtPct(m.nmae[23])}</td><td>${m.skill[23].toFixed(3)}</td>
          <td>${v ? fmtNum(v.fuel / 1000, 1) : '–'}</td><td>${v ? fmtNum(v.hours) : '–'}</td><td>${v ? fmtMoney(v.npc, cur) : '–'}</td>
          <td>${m.id === inUse || m.id === 'perfect' || m.id === 'noisy' ? '' : `<button class="btn small" data-use="${m.id}">Use in EMS</button>`}</td></tr>`;
      }).join('')}</table>`;
    $$('[data-use]').forEach((b) => (b.onclick = () => {
      if (variable === 'pv') P.ems.pv_forecast = b.dataset.use; else P.ems.load_forecast = b.dataset.use;
      P.diesel.strategy = 'predictive';
      syncForms(P); strategyHelp(); autosave(); draw();
      toast(`EMS now uses "${blk.methods.find((m) => m.id === b.dataset.use).name}" for ${variable === 'pv' ? 'PV' : 'load'} (strategy set to Predictive EMS). Re-run the simulation to see the effect.`);
    }));

    drawPick();
    drawSeries();
  }

  function drawPick() {
    const c = COL();
    $('#benchPick').innerHTML = B[variable].methods.filter((m) => m.id !== 'perfect').map((m) =>
      `<span class="chip ${picked[variable].has(m.id) ? 'on' : ''}" data-pick="${m.id}"><i style="background:${colorOf(m.id, c)}"></i>${escapeHtml(m.name)}</span>`).join('');
    $$('[data-pick]', $('#benchPick')).forEach((ch) => (ch.onclick = () => {
      const s = picked[variable]; s.has(ch.dataset.pick) ? s.delete(ch.dataset.pick) : s.add(ch.dataset.pick); drawPick(); drawSeries();
    }));
  }

  function drawSeries() {
    if (!B) return;
    const blk = B[variable], c = COL();
    const w = +$('#benchWeek').value, s = Math.min(w * 168, HOURS - 168), idx = Array.from({ length: 168 }, (_, i) => s + i);
    $('#benchWeekLabel').textContent = `${dateOfHour(s)} to ${dateOfHour(s + 167)}`;
    const ticks = idx.filter((h) => h % 24 === 0);
    const tr = [{ type: 'scatter', mode: 'lines', name: 'Actual', x: idx, y: idx.map((h) => blk.actual[h]), line: { color: c.load, width: 3 } }];
    blk.methods.filter((m) => picked[variable].has(m.id)).forEach((m) => tr.push({
      type: 'scatter', mode: 'lines', name: m.name, x: idx, y: idx.map((h) => m[horizon][h]),
      line: { color: colorOf(m.id, c), width: 1.8, dash: m.id === 'noisy' ? 'dot' : 'solid' },
    }));
    plot('chBenchSeries', tr.map((t) => ({ ...t, hovertemplate: '%{y:,.0f} kW<extra>' + t.name + '</extra>' })), {
      hovermode: 'x unified', xaxis: { tickvals: ticks, ticktext: ticks.map(dateOfHour) }, yaxis: { title: { text: 'kW' }, rangemode: 'tozero' } });
  }
  function reset() { B = null; $('#benchBody').hidden = true; setStatus('#benchStatus', ''); }
  return { init, reset, get result() { return B; } };
})();
