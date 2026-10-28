// Sign-in, landing page, local user profiles, saved projects (on disk via the engine) and autosave.
'use strict';

const Home = (() => {
  let users = [], user = null, projects = [], saveTimer = null, saving = false, pendingSave = false, tpl = 'blank';
  let terms = { version: '', md: '' };   // TERMS.md, served by the engine; its "Version" line decides who must accept again
  const KEY_USER = 'soloptima.user';
  const COLORS = ['#0f7466', '#2a78d6', '#b5760a', '#6250d6', '#c2416c', '#1e7b34', '#8a5a00', '#3d6b8f'];
  const hash = (s) => [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const colorOf = (s) => COLORS[hash(s) % COLORS.length];
  const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
  const avatarHtml = (u, cls = '') => (AVATAR.test(u.avatar || '')
    ? `<span class="avatar pic ${cls}"><img src="${u.avatar}" alt=""></span>`
    : `<span class="avatar ${cls}" style="background:${colorOf(u.id)}">${escapeHtml(initials(u.name))}</span>`);
  const TEMPLATES = {
    blank: { name: 'Blank project', desc: '1 MWp PV, 1 MWh battery, 4 × 500 kW gensets. Set your own site and load.' },
    example: { name: 'Example study', desc: 'Off-grid industrial site: 30 MWp PV, 6.6 MWh battery, 20 × 1.8 MW gensets, PVGIS data included.' },
    industrial: { name: 'Industrial 24/7', desc: 'Continuous process load, 5 MW average, 6 × 1.5 MW gensets.' },
    village: { name: 'Village mini-grid', desc: 'Evening-peaking residential load, 250 kW average, 3 × 200 kW gensets.' },
  };

  // ---------------------------------------------------------------- boot
  async function boot() {
    $('#btnHome').onclick = () => goHome();
    $('#crumbProjects').onclick = () => goHome();
    $('#userBtn').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
    document.addEventListener('click', (e) => { if (!$('#userMenu').hidden && !e.target.closest('#userMenu, #userBtn')) toggleMenu(false); }, true);
    $('#btnNew').onclick = () => showNewForm(true);
    $('#npCancel').onclick = () => showNewForm(false);
    $('#npCreate').onclick = createFromForm;
    $('#npName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createFromForm(); });
    $('#btnExample').onclick = () => createProject('example', 'Example study: off-grid industrial site');
    $('#fileOpen').onchange = importFile;
    $('#projSearch').oninput = renderGrid;
    $('#projSort').onchange = renderGrid;
    window.addEventListener('beforeunload', (e) => { if (pendingSave || saving) { flush(); e.preventDefault(); } });
    window.addEventListener('hashchange', route);
    $('#btnReport').onclick = () => Reports.openForm();
    $('a.skip').onclick = (e) => {
      e.preventDefault();
      const m = $$('main').find((x) => x.offsetParent !== null);
      if (m) { m.tabIndex = -1; m.focus(); }
    };
    $$('[data-legal]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); showLegal(a.dataset.legal); }));
    $$('[data-reports]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); a.dataset.reports === 'new' ? Reports.openForm() : Reports.openList(); }));
    await loadTerms();
    try { users = await api('/api/users'); } catch (e) { users = []; toast(e.message, true); }
    const last = users.find((u) => u.id === storeGet(KEY_USER));
    if (last && accepted(last)) await signIn(last.id);
    else showSignIn(last ? 'terms' : 'choose', last);
  }
  async function loadTerms() {
    try {
      const r = await fetch('/api/legal?doc=terms');
      const md = await r.text();
      if (r.ok) terms = { md, version: (md.match(/^Version\s+([\w.]+)/m) || [])[1] || '' };
    } catch (e) { /* shown on the sign-in page */ }
  }
  const accepted = (u) => !!(u && terms.version && u.terms_version === terms.version);
  // projects edited before profiles existed live in browser storage: move them into the first profile once
  async function migrateLocal() {
    const s = storeGet(STORE_KEY);
    if (!s || storeGet('soloptima.migrated')) return;
    try {
      const p = JSON.parse(s);
      if (!p.id) {   // projects opened from disk carry an id; only pre-profile browser projects lack one
        migrate(p);
        await api('/api/project?user=' + user.id, { project: p, meta: metaOf(p) });
        toast('Moved the project from this browser into your saved projects.');
      }
      storeSet('soloptima.migrated', '1');
    } catch (e) { /* keep it in browser storage */ }
  }

  async function route() {
    if (!user) { showSignIn('choose'); return; }
    const m = (location.hash || '').match(/p=([\w-]+)(?:&t=(\w+))?/);
    if (m && user) {
      if (P.id !== m[1] || document.body.classList.contains('home-mode')) await openProject(m[1], m[2]);
      else if (m[2]) showTab(m[2]);
    } else showHome();
  }

  // ---------------------------------------------------------------- users
  function paintUser() {
    const b = $('#userBtn');
    const pic = !!(user && AVATAR.test(user.avatar || ''));
    if (pic) b.innerHTML = `<img src="${user.avatar}" alt="">`; else b.textContent = user ? initials(user.name) : '+';
    b.classList.toggle('pic', pic);
    b.style.background = pic ? '' : user ? colorOf(user.id) : 'var(--muted)';
    b.title = user ? `Switch user (${user.name})` : 'Create a profile';
  }
  function toggleMenu(force) {
    const m = $('#userMenu');
    const open = force === undefined ? m.hidden : force;
    m.hidden = !open;
    $('#userBtn').setAttribute('aria-expanded', String(open));
    if (!open) return;
    m.innerHTML = `<h4>Profiles on this computer</h4>${users.map((u) => `<button class="menu-item ${user && u.id === user.id ? 'active' : ''}" data-u="${u.id}">
        ${avatarHtml(u)}${escapeHtml(u.name)}<span class="spacer"></span><small style="color:var(--muted)">${u.projects}</small></button>`).join('')}
      <button class="menu-item" id="addUser">Add a profile…</button>
      ${user ? `<button class="menu-item" id="signOut">Sign out</button><button class="menu-item" id="delUser" style="color:var(--danger)">Remove profile "${escapeHtml(user.name)}"…</button>` : ''}
      <hr>${user ? '<button class="menu-item" id="menuSettings">Settings…</button>' : ''}<button class="menu-item" id="menuReports">Bug reports and feedback</button>
      <button class="menu-item" id="menuTerms">Terms of use and licence</button>
      <hr><div class="hint" id="dataDir" style="margin:4px 8px 6px;font-size:12px;word-break:break-all"></div>
      <button class="menu-item" id="quitApp">Quit Soloptima</button>`;
    $$('[data-u]', m).forEach((b) => (b.onclick = () => switchUser(b.dataset.u)));
    $('#addUser', m).onclick = async () => { toggleMenu(false); await flush(); toSignIn('new'); };
    $('#menuReports', m).onclick = () => { toggleMenu(false); Reports.openList(); };
    const st = $('#menuSettings', m);
    if (st) st.onclick = () => { toggleMenu(false); openSettings(); };
    $('#menuTerms', m).onclick = () => { toggleMenu(false); showLegal('terms'); };
    const out = $('#signOut', m);
    if (out) out.onclick = async () => {
      toggleMenu(false);
      await flush();
      user = null; storeSet(KEY_USER, ''); paintUser();
      toSignIn('choose');
    };
    api('/api/info').then((i) => { const d = $('#dataDir'); if (d) d.textContent = 'Projects are saved in ' + i.data_dir; }).catch(() => {});
    $('#quitApp', m).onclick = async () => {
      await flush();
      try { await api('/api/shutdown', {}, 'POST'); } catch (e) { /* already stopping */ }
      document.body.innerHTML = '<main style="max-width:520px;margin:18vh auto;padding:24px;font:16px/1.6 var(--font);color:var(--text)"><h1>Soloptima has stopped</h1><p class="lead">Your projects are saved. You can close this tab. Start Soloptima again from its icon to continue.</p></main>';
    };
    const del = $('#delUser', m);
    if (del) del.onclick = async () => {
      if (!confirm(`Remove the profile "${user.name}" and all ${user.projects} of its saved projects from this computer? This cannot be undone.`)) return;
      try {
        await api('/api/users/delete?id=' + user.id, {}, 'POST');
        users = await api('/api/users'); user = null; storeSet(KEY_USER, '');
        toggleMenu(false); paintUser(); toSignIn('choose');
      } catch (e) { toast(e.message, true); }
    };
  }
  async function switchUser(id) {
    await flush();
    toggleMenu(false);
    const u = users.find((x) => x.id === id);
    if (!accepted(u)) { user = null; paintUser(); toSignIn('terms', u); return; }
    user = u; storeSet(KEY_USER, u.id); paintUser();
    if (location.hash) history.pushState(null, '', location.pathname);
    await goHome();
  }

  // ---------------------------------------------------------------- sign-in and terms
  function toSignIn(mode, who) {
    if (location.hash) history.replaceState(null, '', location.pathname);
    showSignIn(mode, who);
  }
  const hideSignIn = () => { document.body.classList.remove('signin-mode'); $('#signin').hidden = true; };
  // Profiles are local and have no password: projects are plain files in the data folder, so a password would protect
  // nothing. A profile must accept the current terms of use and the licence before it can open the app.
  function showSignIn(mode, who) {
    document.body.classList.add('home-mode', 'signin-mode');
    $('#home').hidden = true;
    const el = $('#signin');
    el.hidden = false;
    if (mode === 'choose' && !users.length) mode = 'new';
    const termsBlock = terms.version
      ? `<div class="terms-box md" tabindex="0" aria-label="Terms of use">${mdToHtml(terms.md)}</div>
         <label class="check accept"><input type="checkbox" id="siAccept"><span>I have read and accept the <a href="" data-legal="terms">terms of use</a> (version ${escapeHtml(terms.version)}) and the <a href="" data-legal="license">PolyForm Noncommercial licence</a>.</span></label>`
      : '<p class="si-error">The terms of use (TERMS.md) are missing next to the web folder, so no profile can be created or opened. Reinstall Soloptima.</p>';
    let body;
    if (mode === 'choose') {
      body = `<h2>Choose your profile</h2><p class="hint">Profiles keep each person's projects apart on this computer.</p>
        <div class="si-users">${users.map((u) => `<button class="si-user" data-si="${u.id}">${avatarHtml(u)}
          <span><b>${escapeHtml(u.name)}</b><small>${escapeHtml(u.organisation || '')}${u.organisation ? ' · ' : ''}${u.projects} project${u.projects === 1 ? '' : 's'}${accepted(u) || !terms.version ? '' : ' · must accept the terms'}</small></span></button>`).join('')}</div>
        <button class="btn" id="siNew">Create a new profile</button>`;
    } else if (mode === 'terms') {
      const before = !terms.version ? '' : who && who.terms_version ? `You accepted version ${escapeHtml(who.terms_version)} on ${escapeHtml(String(who.terms_accepted || '').slice(0, 10))}; the terms have changed since.` : 'Accept the terms of use and the licence to continue.';
      body = `<h2>Welcome back, ${escapeHtml(who ? who.name.split(/\s+/)[0] : '')}</h2>${before ? `<p class="hint">${before}</p>` : ''}${termsBlock}
        <div class="row gap"><button class="btn" id="siBack">Back</button>${terms.version ? '<button class="btn primary" id="siGo" disabled>Accept and continue</button>' : ''}</div>`;
    } else {
      body = `<h2>Create your profile</h2><p class="hint">Stored only on this computer. No account or internet connection is needed.</p>
        <div class="grid-2 si-fields"><label>Name<input id="siName" maxlength="60" autocomplete="name"></label>
          <label><span>Organisation <small>optional</small></span><input id="siOrg" maxlength="120" autocomplete="organization"></label></div>
        <label class="si-fields"><span>Email <small>optional, added to the bug reports you write</small></span><input id="siEmail" type="email" maxlength="120" autocomplete="email"></label>
        ${termsBlock}
        <div class="row gap">${users.length ? '<button class="btn" id="siBack">Back</button>' : ''}${terms.version ? '<button class="btn primary" id="siGo" disabled>Create profile and continue</button>' : ''}</div>`;
    }
    el.innerHTML = `<main class="si-main"><section class="si-intro"><h1>Welcome to Soloptima</h1>
        <p class="lead">Design electrical architecture, optimize hourly dispatch, and validate project bankability in a single desktop workspace.</p>
        <p class="hint">No cloud account required. Project files and reports stay on your computer.</p></section>
      <section class="si-panel card">${body}</section></main>
      <footer class="app-foot"><a href="" data-legal="terms">Terms of use</a> · <a href="" data-legal="license">Licence (PolyForm Noncommercial 1.0.0)</a> · <a href="" data-legal="notices">Third-party notices</a> · <a href="" data-reports="new">Report a problem</a></footer>`;
    $$('[data-legal]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); showLegal(a.dataset.legal); }));
    $$('[data-reports]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); Reports.openForm(); }));
    wireJumps(el);
    $$('[data-si]', el).forEach((b) => (b.onclick = () => { const u = users.find((x) => x.id === b.dataset.si); if (accepted(u)) signIn(u.id); else showSignIn('terms', u); }));
    const nw = $('#siNew', el), back = $('#siBack', el), go = $('#siGo', el), acc = $('#siAccept', el), name = $('#siName', el);
    if (nw) nw.onclick = () => showSignIn('new');
    if (back) back.onclick = () => showSignIn('choose');
    if (!go) return;
    const ready = () => { go.disabled = !(acc && acc.checked && (!name || name.value.trim())); };
    if (acc) acc.onchange = ready;
    if (name) { name.oninput = ready; name.focus(); }
    go.onclick = async () => {
      go.disabled = true;
      try {
        let id = who && who.id;
        if (mode === 'terms') await api('/api/users/terms?id=' + who.id, { version: terms.version });
        else id = (await api('/api/users', { name: name.value.trim(), organisation: $('#siOrg', el).value.trim(), email: $('#siEmail', el).value.trim(), terms_version: terms.version })).id;
        users = await api('/api/users');
        await signIn(id);
      } catch (e) { toast(e.message, true); ready(); }
    };
  }
  async function signIn(id) {
    user = users.find((u) => u.id === id) || null;
    if (!user) { showSignIn('choose'); return; }
    storeSet(KEY_USER, user.id);
    hideSignIn();
    paintUser();
    await migrateLocal();
    await loadProjects();
    await route();
  }
  // Terms, licence and third-party notices in a dialog (Markdown files next to the web folder)
  async function showLegal(doc) {
    const d = $('#dlgLegal'), titles = { terms: 'Terms of use', license: 'Licence', notices: 'Third-party notices' };
    let html;
    try {
      const r = await fetch('/api/legal?doc=' + doc);
      const t = await r.text();
      html = r.ok ? mdToHtml(t) : `<p class="si-error">${escapeHtml(t)}</p>`;
    } catch (e) { html = '<p class="si-error">Cannot reach the Soloptima engine.</p>'; }
    d.innerHTML = `<div class="dlg-body"><div class="dlg-head"><h2>${titles[doc]}</h2><button class="btn ghost small" data-close>Close</button></div>
      <div class="md legal">${html}</div></div>`;
    $('[data-close]', d).onclick = () => d.close();
    wireJumps(d);
    if (!d.open) d.showModal();
  }

  // ---------------------------------------------------------------- projects
  async function loadProjects() {
    projects = user ? await api('/api/projects?user=' + user.id).catch(() => []) : [];
    if (user) { const u = users.find((x) => x.id === user.id); if (u) u.projects = projects.length; }
  }
  function metaOf(p) {
    const m = { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, gensets: p.diesel.units, genset_kw: p.diesel.unit_kw,
      wind_units: p.wind ? p.wind.units : 0, lat: p.location.lat, lon: p.location.lon, currency: p.econ.currency, strategy: p.diesel.strategy };
    if (SIM && P === p && !simStale()) {   // results from other inputs give no badges
      m.re = SIM.result.re_fraction; m.lcoe = SIM.result.econ.lcoe; m.npv_savings = SIM.comparison.npv_savings;
      if (SIM.finance && SIM.finance.metrics) { m.equity_irr = SIM.finance.metrics.equity_irr; m.fin_model = SIM.finance.model; }
    }
    return m;
  }
  function showHome() {
    hideSignIn();
    document.body.classList.add('home-mode');
    $('#home').hidden = false;
    renderHome();
  }
  async function goHome() {
    await flush();
    if (!user) { showSignIn('choose'); return; }
    if (location.hash) history.pushState(null, '', location.pathname);
    await loadProjects();
    showHome();
  }
  function enterWorkspace() {
    hideSignIn();
    document.body.classList.remove('home-mode');
    $('#home').hidden = true;
    setTimeout(() => { Layout.invalidate(); resizeVisibleCharts(); }, 60);
  }
  function renderHome() {
    const hr = new Date().getHours();
    const part = hr < 11 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    $('#homeGreeting').textContent = `${part}, ${user.name.split(/\s+/)[0]}`;
    const totPv = projects.reduce((a, p) => a + (p.pv_kwp || 0), 0), totBess = projects.reduce((a, p) => a + (p.bess_kwh || 0), 0);
    const last = projects[0];
    $('#homeStats').innerHTML = `<div><b>${projects.length}</b>saved project${projects.length === 1 ? '' : 's'}</div>
      <div><b>${fmtNum(totPv / 1000, 1)} MWp</b>PV across projects</div><div><b>${fmtNum(totBess / 1000, 1)} MWh</b>storage across projects</div>
      ${last ? `<div><b>${escapeHtml(relTime(last.updated))}</b>last edit · ${escapeHtml(last.name)}</div>` : ''}`;
    renderTemplates();
    renderGrid();
  }
  function relTime(iso) {
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(d)) return '';
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    if (d < 86400 * 30) return `${Math.round(d / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  }
  // Generated cover: sky gradient + sun + PV rows, tinted per project so cards are recognisable at a glance.
  // The sun is a separate layer between sky and ground so it can cross the sky (style.css); the negative delay
  // starts each project at its own time of day.
  function cover(p) {
    const h = hash(p.id), hue = h % 360, t = -((h >>> 8) % 400) / 10;
    const rows = Array.from({ length: 5 }, (_, i) => `<path d="M${-10 + i * 6} ${70 + i * 5}h${120 - i * 4}" stroke="rgba(255,255,255,${0.22 + i * 0.07})" stroke-width="3"/>`).join('');
    return `<svg viewBox="0 0 100 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="g${h}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue},38%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},45%,28%)"/></linearGradient></defs>
      <rect width="100" height="92" fill="url(#g${h})"/></svg><span class="sun" style="--t:${t}s" aria-hidden="true"><i></i></span>
      <svg viewBox="0 0 100 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M0 64 Q30 52 60 60 T100 56 V92 H0z" fill="rgba(0,0,0,.18)"/>${rows}</svg>`;
  }
  function renderGrid() {
    const q = ($('#projSearch').value || '').toLowerCase(), sort = $('#projSort').value;
    let list = projects.filter((p) => !q || (p.name || '').toLowerCase().includes(q));
    if (sort === 'name') list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (sort === 'pv') list.sort((a, b) => (b.pv_kwp || 0) - (a.pv_kwp || 0));
    $('#projCount').textContent = projects.length;
    const grid = $('#projectGrid');
    if (!projects.length) {
      grid.innerHTML = `<div class="home-empty" style="grid-column:1/-1">
        <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.4"><rect x="3" y="11" width="18" height="8" rx="1"/><path d="M6 11l2-6h8l2 6M12 5v14M3 15h18"/></svg>
        <h3>No projects yet</h3><p>Start a blank project for your site, or open the example study to see a complete PV, battery and diesel analysis.</p>
        <div class="row" style="gap:8px;justify-content:center"><button class="btn primary" id="emptyNew">New project</button><button class="btn" id="emptyEx">Open the example study</button></div></div>`;
      $('#emptyNew').onclick = () => showNewForm(true);
      $('#emptyEx').onclick = () => createProject('example', 'Example study: off-grid industrial site');
      return;
    }
    if (!list.length) { grid.innerHTML = `<p class="hint" style="grid-column:1/-1">No project matches "${escapeHtml(q)}".</p>`; return; }
    const cur = (p) => p.currency || 'USD';
    grid.innerHTML = list.map((p) => `<article class="pcard" data-open="${p.id}" tabindex="0" aria-label="Open ${escapeHtml(p.name)}">
      <div class="cover">${cover(p)}<span class="loc">${p.lat != null ? `${(+p.lat).toFixed(3)}, ${(+p.lon).toFixed(3)}` : ''}</span></div>
      <div class="body"><h3>${escapeHtml(p.name || 'Untitled')}</h3>
        <div class="specs"><span><b>${fmtNum((p.pv_kwp || 0) / 1000, 2)}</b> MWp PV</span><span><b>${fmtNum((p.bess_kwh || 0) / 1000, 1)}</b> MWh BESS</span>
          <span><b>${fmtNum(p.gensets || 0)} × ${fmtNum(p.genset_kw || 0)}</b> kW diesel</span>${p.wind_units ? `<span><b>${fmtNum(p.wind_units)}</b> wind</span>` : ''}</div>
        <div class="res">${p.re != null ? `<span>RE <b>${fmtPct(p.re, 1)}</b></span>` : ''}${p.lcoe != null ? `<span>LCOE <b>${fmtNum(p.lcoe, 3)}</b> ${escapeHtml(cur(p))}/kWh</span>` : ''}
          ${p.equity_irr != null ? `<span>Equity IRR <b>${fmtPct(p.equity_irr, 1)}</b></span>` : ''}${p.re == null ? '<span>Not simulated yet</span>' : ''}</div></div>
      <div class="foot"><time datetime="${p.updated}">Edited ${escapeHtml(relTime(p.updated))}</time>
        <button class="btn ghost small" data-dup="${p.id}">Duplicate</button>
        <button class="btn ghost small" data-exp="${p.id}" title="Download .json">Export</button>
        <button class="btn ghost small danger" data-del="${p.id}">Delete</button></div></article>`).join('');
    $$('[data-open]', grid).forEach((c) => {
      c.addEventListener('click', (e) => { if (!e.target.closest('button')) openProject(c.dataset.open); });
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === c) openProject(c.dataset.open); });
    });
    $$('[data-dup]', grid).forEach((b) => (b.onclick = async () => {
      try { await api(`/api/project/duplicate?user=${user.id}&id=${b.dataset.dup}`, {}, 'POST'); await loadProjects(); renderHome(); toast('Project duplicated'); } catch (e) { toast(e.message, true); }
    }));
    $$('[data-exp]', grid).forEach((b) => (b.onclick = async () => {
      try {
        const r = await fetch(`/api/project?user=${user.id}&id=${b.dataset.exp}`);
        if (!r.ok) { toast('Export failed (HTTP ' + r.status + ').', true); return; }
        const p = await r.json();   // the API keys stay out of the file, as with Export .json in the top bar (app.js)
        const name = (projects.find((x) => x.id === b.dataset.exp) || {}).name || 'project';
        download(name.replace(/[^\w\- ]+/g, '_') + '.json', JSON.stringify(withoutKeys(p)), 'application/json');
        if (hasKeys(p)) toast('API keys were left out of the exported file');
      } catch (e) { toast(e.message, true); }
    }));
    $$('[data-del]', grid).forEach((b) => (b.onclick = async () => {
      const p = projects.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete "${p ? p.name : 'this project'}" from this computer? This cannot be undone. Export it first if you may need it again.`)) return;
      try { await api(`/api/project/delete?user=${user.id}&id=${b.dataset.del}`, {}, 'POST'); await loadProjects(); renderHome(); } catch (e) { toast(e.message, true); }
    }));
  }
  function renderTemplates() {
    $('#npTemplates').innerHTML = Object.entries(TEMPLATES).map(([k, t]) => `<button class="tpl ${k === tpl ? 'on' : ''}" data-tpl="${k}"><b>${t.name}</b><span>${t.desc}</span></button>`).join('');
    $$('[data-tpl]').forEach((b) => (b.onclick = () => { tpl = b.dataset.tpl; renderTemplates(); }));
  }
  function showNewForm(on) {
    $('#newProject').hidden = !on;
    if (on) { renderTemplates(); $('#npName').value = ''; $('#npName').focus(); $('#newProject').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
  async function createFromForm() {
    const name = $('#npName').value.trim() || TEMPLATES[tpl].name;
    await createProject(tpl, name);
  }
  async function buildTemplate(kind) {
    if (kind === 'example') {
      const r = await fetch('examples/example_study.json');
      return r.json();
    }
    const p = defaultProject();
    if (kind === 'industrial') {
      Object.assign(p.load, { template: 'continuous', target_avg: 5000 });
      Object.assign(p.diesel, { unit_kw: 1500, units: 6 });
      Object.assign(p.pv, { capacity_kwp: 5000 });
      Object.assign(p.bess, { energy_kwh: 5000, power_kw: 2500 });
      p.equipment.sel.genset = null;
    }
    if (kind === 'village') {
      Object.assign(p.load, { template: 'residential', target_avg: 250, var_day: 0.08, var_hour: 0.05 });
      Object.assign(p.diesel, { unit_kw: 200, units: 3, min_units_online: 0 });
      Object.assign(p.pv, { capacity_kwp: 600 });
      Object.assign(p.bess, { energy_kwh: 1500, power_kw: 500 });
      p.equipment.sel.genset = null;
    }
    return p;
  }
  async function createProject(kind, name) {
    if (!user) { toast('Create a profile first.', true); return; }
    try {
      setStatus('#npStatus', 'Creating…');
      const p = await buildTemplate(kind);
      p.name = name;
      delete p.id;
      migrate(p);
      if (p.load.source === 'synthetic' || !p.load.kw) { const keep = P; P = p; generateLoad(false); P = keep; }
      const meta = await api('/api/project?user=' + user.id, { project: p, meta: metaOf(p) });
      showNewForm(false); setStatus('#npStatus', '');
      await loadProjects();
      await openProject(meta.id, 'site');
    } catch (e) { setStatus('#npStatus', e.message, 'err'); toast(e.message, true); }
  }
  async function importFile(e) {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    if (!user) { toast('Create a profile first.', true); return; }
    try {
      const p = JSON.parse(await readFile(f));
      if (!p.location || !p.pv) throw new Error('This file is not a Soloptima project.');
      delete p.id;
      migrate(p);
      const meta = await api('/api/project?user=' + user.id, { project: p, meta: metaOf(p) });
      await loadProjects();
      await openProject(meta.id);
      toast('Imported ' + f.name);
    } catch (err) { toast('Could not import: ' + err.message, true); }
  }
  async function openProject(id, tab) {
    try {
      const r = await fetch(`/api/project?user=${user.id}&id=${id}`);
      if (!r.ok) throw new Error('Project not found.');
      const p = await r.json();
      setProject(p);
      Console.renderSaved();
      enterWorkspace();
      setSaveState('saved');
      const t = tab || (p.ui && p.ui.tab) || 'site';
      showTab(t);
      history.replaceState(null, '', `#p=${id}&t=${t}`);
    } catch (e) { toast(e.message, true); showHome(); }
  }

  // ---------------------------------------------------------------- settings
  // The profile (name, picture, organisation, email), the projects folder and the caches
  async function openSettings() {
    let S;
    try { S = await api('/api/settings'); } catch (e) { toast(e.message, true); return; }
    const d = $('#dlgSettings');
    let pic = AVATAR.test(user.avatar || '') ? user.avatar : '';
    const fixed = S.source === 'option';
    d.innerHTML = `<div class="dlg-body settings">
      <div class="dlg-head"><h2>Settings</h2><button type="button" class="btn ghost small" data-close>Close</button></div>
      <section class="set-sec"><h3>Profile</h3>
        <div class="set-profile"><span id="stAvatar"></span>
          <div class="row gap"><button type="button" class="btn small" id="stPic">Change picture…</button><button type="button" class="btn ghost small" id="stPicDel">Remove picture</button>
            <input type="file" id="stPicFile" accept="image/png,image/jpeg,image/webp" hidden></div></div>
        <div class="grid-2"><label>Name<input id="stName" maxlength="60" autocomplete="name"></label>
          <label><span>Organisation <small>optional</small></span><input id="stOrg" maxlength="120" autocomplete="organization"></label></div>
        <label><span>Email <small>optional, added to the bug reports you write</small></span><input id="stEmail" type="email" maxlength="120" autocomplete="email"></label>
        <div class="row gap"><button type="button" class="btn primary small" id="stSave">Save profile</button><span class="status inline" id="stProfileMsg" role="status"></span></div>
      </section>
      <section class="set-sec"><h3>Projects folder</h3>
        <p class="hint">The profiles, projects and bug reports of everyone using Soloptima on this computer are kept in this folder.</p>
        <code class="set-path" id="stDir"></code>
        ${S.note ? `<p class="status err inline">${escapeHtml(S.note)}</p>` : ''}
        ${fixed ? '<p class="hint">Soloptima was started with the --data option, which sets the folder for this run.</p>' : `
        <label>New folder<span class="set-pick"><input id="stDirNew" placeholder="Full path of a folder" spellcheck="false" autocomplete="off"><button type="button" class="btn small" id="stBrowse">Browse…</button></span></label>
        <fieldset class="set-mode"><legend>What to do with it</legend>
          <label class="check"><input type="radio" name="stMode" value="move" checked><span><b>Move my data there.</b> Everything is copied to the new folder. The current folder stays as it is, as a backup you can delete later.</span></label>
          <label class="check"><input type="radio" name="stMode" value="use"><span><b>Open the data already in that folder</b>, for example a backup or a folder synced from another computer.</span></label></fieldset>
        <div class="row gap"><button type="button" class="btn small" id="stDirGo" disabled>Change folder</button>${S.source === 'default' ? '' : '<button type="button" class="btn ghost small" id="stDirDef">Use the default folder</button>'}<span class="status inline" id="stDirMsg" role="status"></span></div>`}
      </section>
      <section class="set-sec"><h3>Cache</h3>
        <p class="hint">Clears the weather data and PV yield checks downloaded since Soloptima started, finished optimisation and variability runs held by the engine, the satellite images of the report and files left by interrupted saves. Profiles, projects, reports and the results on screen are not touched; data is downloaded again when needed.</p>
        <div class="row gap"><button type="button" class="btn small" id="stClear">Clear cache</button><span class="status inline" id="stCacheMsg" role="status"></span></div>
      </section></div>`;
    $$('[data-close]', d).forEach((b) => (b.onclick = () => d.close()));
    const name = $('#stName', d), org = $('#stOrg', d), email = $('#stEmail', d);
    name.value = user.name; org.value = user.organisation || ''; email.value = user.email || '';
    $('#stDir', d).textContent = S.data_dir;
    const paintPic = () => {
      $('#stAvatar', d).innerHTML = avatarHtml({ id: user.id, name: name.value.trim() || user.name, avatar: pic }, 'big');
      $('#stPicDel', d).hidden = !pic;
    };
    paintPic();
    name.oninput = paintPic;
    $('#stPic', d).onclick = () => $('#stPicFile', d).click();
    $('#stPicFile', d).onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { pic = await avatarImage(f); paintPic(); setStatus($('#stProfileMsg', d), 'Save the profile to keep the new picture.'); } catch (err) { setStatus($('#stProfileMsg', d), `${f.name}: the image could not be read.`, 'err'); }
    };
    $('#stPicDel', d).onclick = () => { pic = ''; paintPic(); setStatus($('#stProfileMsg', d), 'Save the profile to remove the picture.'); $('#stPic', d).focus(); };
    $('#stSave', d).onclick = async () => {
      if (!name.value.trim()) { setStatus($('#stProfileMsg', d), 'Enter a name.', 'err'); name.focus(); return; }
      try {
        const u = await api('/api/users/update?id=' + user.id, { name: name.value.trim(), organisation: org.value.trim(), email: email.value.trim(), avatar: pic });
        user = { ...u, projects: user.projects };
        users = users.map((x) => (x.id === user.id ? user : x));
        paintUser();
        setStatus($('#stProfileMsg', d), 'Profile saved.', 'ok');
      } catch (err) { setStatus($('#stProfileMsg', d), err.message, 'err'); }
    };
    if (!fixed) {
      const dir = $('#stDirNew', d), go = $('#stDirGo', d), browse = $('#stBrowse', d), msg = $('#stDirMsg', d);
      dir.oninput = () => { go.disabled = !dir.value.trim(); };
      browse.onclick = async () => {
        browse.disabled = true;
        setStatus(msg, 'Choose a folder in the window that opened (it may be behind the browser).');
        try {
          const r = await api('/api/settings/pick-folder', {});
          setStatus(msg, '');
          if (r.path) { dir.value = r.path; dir.oninput(); go.focus(); }
        } catch (err) { setStatus(msg, err.message, 'err'); }
        browse.disabled = false;
      };
      const def = $('#stDirDef', d);
      if (def) def.onclick = () => { dir.value = S.default_dir; dir.oninput(); go.focus(); };
      go.onclick = async () => {
        const mode = $('input[name=stMode]:checked', d).value;
        go.disabled = true;
        setStatus(msg, mode === 'move' ? 'Copying…' : 'Opening the folder…');
        try {
          await flush();   // the open project is saved to the current folder first
          const r = await api('/api/settings/data-dir', { path: dir.value.trim(), mode });
          await folderChanged(d);
          if (!d.open) toast(`Projects folder changed to ${r.data_dir}. Choose a profile.`);
          else {
            $('#stDir', d).textContent = r.data_dir;
            dir.value = '';
            setStatus(msg, mode === 'move' ? `Copied ${fmtNum(r.copied)} files. The previous folder ${r.previous} is unchanged.` : 'Now using this folder.', 'ok');
          }
        } catch (err) { setStatus(msg, err.message, 'err'); go.disabled = !dir.value.trim(); }
      };
    }
    $('#stClear', d).onclick = async () => {
      const b = $('#stClear', d), msg = $('#stCacheMsg', d);
      b.disabled = true;
      try {
        const r = await api('/api/cache/clear', {});
        const imgs = Report.clearCache();
        // a project kept in this browser before profiles existed, already moved to the projects folder
        if (storeGet('soloptima.migrated') && storeGet(STORE_KEY)) try { localStorage.removeItem(STORE_KEY); } catch (e) { /* storage blocked */ }
        const n = (k, one, many) => (k ? `${fmtNum(k)} ${k === 1 ? one : many}` : '');
        const parts = [n(r.weather_sets, 'weather data set', 'weather data sets'), n(r.yield_checks, 'PV yield check', 'PV yield checks'),
          n(r.results, 'finished run', 'finished runs'), n(imgs, 'satellite image', 'satellite images'), n(r.temp_files, 'leftover file', 'leftover files')].filter(Boolean);
        setStatus(msg, parts.length ? `Cleared ${parts.join(', ')}.` : 'The cache was already empty.', 'ok');
      } catch (err) { setStatus(msg, err.message, 'err'); }
      b.disabled = false;
    };
    d.showModal();
    name.focus();
  }
  // After a folder change: the same profile carries on (its data was copied), otherwise choose one from the new folder
  async function folderChanged(d) {
    users = await api('/api/users').catch(() => []);
    const same = users.find((u) => u.id === user.id);
    if (!same) {
      d.close();
      user = null; storeSet(KEY_USER, ''); paintUser();
      toSignIn('choose');
      return;
    }
    user = same;
    paintUser();
    await loadProjects();
    if (!document.body.classList.contains('home-mode') && !projects.some((p) => p.id === P.id)) await goHome();
  }
  // A profile picture: the centre square of the image at 160 px. PNG keeps its transparency; other images become JPEG.
  async function avatarImage(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('not an image');
    const bmp = await createImageBitmap(file), s = Math.min(bmp.width, bmp.height), c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d'), png = file.type === 'image/png';
    if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, 160, 160); }
    g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 160, 160);
    if (bmp.close) bmp.close();
    return c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
  }

  // ---------------------------------------------------------------- saving
  function setSaveState(s) {
    const el = $('#saveState');
    el.className = 'save-state ' + (s === 'saving' ? 'saving' : s === 'dirty' || s === 'error' ? 'unsaved' : '');
    el.textContent = s === 'saving' ? 'Saving…' : s === 'dirty' ? 'Unsaved changes' : s === 'error' ? 'Save failed' : `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  function queueSave() {
    if (!user || !P || !P.id || document.body.classList.contains('home-mode')) return false;
    pendingSave = true;
    setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1200);
    return true;
  }
  async function flush() {
    clearTimeout(saveTimer);
    while (saving) await new Promise((r) => setTimeout(r, 100));
    if (!pendingSave || !user || !P || !P.id) return;
    saving = true; pendingSave = false;
    setSaveState('saving');
    try {
      const copy = { ...P, layout: { ...P.layout, result: P.layout.result ? { ...P.layout.result, tables: [] } : null } };
      await api(`/api/project?user=${user.id}&id=${P.id}`, { project: copy, meta: metaOf(P) });
      setSaveState('saved');
    } catch (e) { setSaveState('error'); pendingSave = true; toast('Could not save: ' + e.message, true); }
    saving = false;
  }
  function tabChanged(t) {
    if (!P || !P.id) return;
    P.ui = { ...(P.ui || {}), tab: t };
    history.replaceState(null, '', `#p=${P.id}&t=${t}`);
  }
  return { boot, queueSave, tabChanged, current: () => user, showLegal, openSettings };
})();
