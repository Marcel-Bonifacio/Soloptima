// Site geometry in and out of the layout map: PV areas, exclusion zones, buildings and trees from KML, KMZ or GeoJSON files,
// the layout written as GeoJSON or KML, and building outlines from OpenStreetMap (Overpass API).
'use strict';

const GeoData = (() => {
  const MAX_ITEMS = 2000, MAX_RING = 5000, MAX_CORNERS = 200000, MAX_FILE = 50 << 20, MAX_OSM = 3000;

  // ---------------------------------------------------------------- reading
  // A ring of [lat, lon] pairs from [lon, lat(, alt)] positions, without the closing repeat of the first corner; null unless
  // it has 3 to MAX_RING corners, all finite and in range.
  function ring(pos) {
    if (!Array.isArray(pos)) return null;
    const r = [];
    for (const c of pos) {
      if (!Array.isArray(c) || c.length < 2) return null;
      const lon = +c[0], lat = +c[1];
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
      r.push([lat, lon]);
    }
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    return r.length >= 3 && r.length <= MAX_RING ? r : null;
  }
  // Items of a file: { kind: 'polygon' | 'hole' | 'point', latlngs or latlng, name, props }. A polygon's holes come right after
  // it; props are the file's properties (the names the layout export writes are read back on import).
  function collector() {
    const items = [];
    let skipped = 0, corners = 0;
    const full = () => items.length >= MAX_ITEMS || corners >= MAX_CORNERS;
    return {
      items: () => ({ items, skipped }),
      polygon(rings, props, name) {
        if (full() || !Array.isArray(rings)) return;
        const outer = ring(rings[0]);
        if (!outer) { skipped++; return; }
        items.push({ kind: 'polygon', latlngs: outer, props, name });
        corners += outer.length;
        for (const h of rings.slice(1)) {
          const r = ring(h);
          if (r && !full()) { items.push({ kind: 'hole', latlngs: r, name }); corners += r.length; }
        }
      },
      point(c, props, name) {
        if (full()) return;
        if (!Array.isArray(c) || !(Math.abs(+c[1]) <= 90 && Math.abs(+c[0]) <= 180)) { skipped++; return; }
        items.push({ kind: 'point', latlng: [+c[1], +c[0]], props, name });
      },
    };
  }

  function fromGeoJSON(j) {
    const c = collector();
    const add = (g, props, name) => {
      if (!g || typeof g !== 'object') return;
      if (g.type === 'Polygon') c.polygon(g.coordinates, props, name);
      else if (g.type === 'MultiPolygon') (g.coordinates || []).forEach((r) => c.polygon(r, props, name));
      else if (g.type === 'Point') c.point(g.coordinates, props, name);
      else if (g.type === 'MultiPoint') (g.coordinates || []).forEach((p) => c.point(p, props, name));
      else if (g.type === 'GeometryCollection') (g.geometries || []).forEach((x) => add(x, props, name));
    };
    const feature = (f) => {
      const props = f && f.properties && typeof f.properties === 'object' ? f.properties : {};
      add(f && f.geometry, props, typeof props.name === 'string' ? props.name : '');
    };
    if (j && j.type === 'FeatureCollection' && Array.isArray(j.features)) j.features.forEach(feature);
    else if (j && j.type === 'Feature') feature(j);
    else add(j, {}, '');
    return c.items();
  }

  function fromKML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('the file is not readable KML');
    const c = collector();
    const tag = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
    const coords = (el) => (el ? el.textContent.trim().split(/\s+/).filter(Boolean).map((t) => t.split(',').map(Number)) : null);
    for (const pm of tag(doc, 'Placemark')) {
      const nameEl = Array.from(pm.children).find((x) => x.localName === 'name');
      const name = nameEl ? nameEl.textContent.trim().slice(0, 100) : '';
      const props = {};
      for (const d of tag(pm, 'Data')) {
        const v = tag(d, 'value')[0], key = d.getAttribute('name') || '';
        if (v && /^[a-z_]{1,32}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)) props[key] = v.textContent.trim().slice(0, 100);
      }
      for (const pg of tag(pm, 'Polygon')) {
        const ringOf = (b) => { const lr = tag(b, 'coordinates')[0]; return coords(lr); };
        const outer = tag(pg, 'outerBoundaryIs')[0];
        if (!outer) continue;
        c.polygon([ringOf(outer), ...tag(pg, 'innerBoundaryIs').map(ringOf)], props, name);
      }
      for (const pt of tag(pm, 'Point')) { const p = coords(tag(pt, 'coordinates')[0]); if (p) c.point(p[0], props, name); }
    }
    return c.items();
  }

  // The KML document of a KMZ (zip) file: the central directory names the entries, doc.kml or else the first .kml is taken,
  // stored or deflated, at most MAX_FILE unpacked.
  async function unzipKml(buf) {
    const u8 = new Uint8Array(buf), b = new DataView(buf);
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (b.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('the file is not a KMZ (zip) archive');
    const entries = b.getUint16(e + 10, true);
    let p = b.getUint32(e + 16, true), pick = null;
    for (let k = 0; k < entries && p + 46 <= u8.length && b.getUint32(p, true) === 0x02014b50; k++) {
      const nl = b.getUint16(p + 28, true), xl = b.getUint16(p + 30, true), cl = b.getUint16(p + 32, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      if (/\.kml$/i.test(name) && (!pick || /(^|\/)doc\.kml$/i.test(name)))
        pick = { method: b.getUint16(p + 10, true), size: b.getUint32(p + 20, true), unpacked: b.getUint32(p + 24, true), at: b.getUint32(p + 42, true) };
      p += 46 + nl + xl + cl;
    }
    if (!pick) throw new Error('the KMZ archive holds no KML document');
    if (pick.unpacked > MAX_FILE) throw new Error('the KML document in the archive is over 50 MB');
    const q = pick.at;
    if (q + 30 > u8.length || b.getUint32(q, true) !== 0x04034b50) throw new Error('the KMZ archive is damaged');
    const start = q + 30 + b.getUint16(q + 26, true) + b.getUint16(q + 28, true);
    if (start + pick.size > u8.length) throw new Error('the KMZ archive is damaged');
    const data = u8.subarray(start, start + pick.size);
    if (pick.method === 0) return new TextDecoder().decode(data);
    if (pick.method !== 8) throw new Error('the KMZ archive uses a compression this program does not read');
    if (typeof DecompressionStream === 'undefined') throw new Error('this system cannot unpack KMZ archives: save the file as KML');
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_FILE) { reader.cancel(); throw new Error('the KML document in the archive is over 50 MB'); }
      parts.push(value);
    }
    return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
  }

  // Items of a KML, KMZ or GeoJSON file (see collector).
  async function read(file) {
    if (file.size > MAX_FILE) throw new Error('the file is over 50 MB');
    const name = file.name.toLowerCase();
    if (name.endsWith('.kmz')) return fromKML(await unzipKml(await file.arrayBuffer()));
    const text = await readFile(file);
    if (name.endsWith('.kml') || /^\s*</.test(text)) return fromKML(text);
    return fromGeoJSON(JSON.parse(text));
  }

  // ---------------------------------------------------------------- writing
  // Kinds of layout items: the folder name and the KML line and fill colours (aabbggrr).
  const KINDS = { site: ['PV areas', 'ff00a1ed', '1000a1ed'], exclusion: ['Exclusion zones', 'ff4849e3', '404849e3'], building: ['Buildings', 'ff3a4a5d', '9960758a'],
                  tree: ['Trees', 'ff327d2e', '8047a043'], table: ['Tables', 'ffd6782a', 'b0e58739'] };
  // Properties of a layout item under the project file's names; soloptima says which kind it is.
  function propsOf(g) {
    const { type, latlngs, center, kind, path, ...rest } = g;   // a path's strip is its geometry; its centre line stays inside the project
    return { soloptima: type === 'obstacle' ? kind : type, ...rest };
  }
  // The layout's areas and objects, then its tables, as [properties, [lat, lon] ring or point].
  const items = (L) => (L.polygons || []).map((g) => [propsOf(g), g.center || g.latlngs]).concat(((L.result && L.result.tables) || []).map((t) => [{ soloptima: 'table' }, t]));
  const isPoint = (shape) => typeof shape[0] === 'number';

  // GeoJSON (RFC 7946: longitude first, rings closed); trees as points.
  function toGeoJSON(L) {
    const features = items(L).map(([props, shape]) => ({ type: 'Feature', properties: props,
      geometry: isPoint(shape) ? { type: 'Point', coordinates: [shape[1], shape[0]] }
                               : { type: 'Polygon', coordinates: [[...shape, shape[0]].map(([la, lo]) => [lo, la])] } }));
    return JSON.stringify({ type: 'FeatureCollection', features });
  }

  // KML with a folder per kind; the properties go to ExtendedData, so the file reads back into the layout.
  function toKML(L, title) {
    const folders = Object.fromEntries(Object.keys(KINDS).map((k) => [k, []]));
    const count = {};
    for (const [props, shape] of items(L)) {
      const kind = props.soloptima;
      if (!folders[kind]) continue;
      count[kind] = (count[kind] || 0) + 1;
      const name = kind === 'building' || kind === 'tree' ? `${kind === 'tree' ? 'Tree' : 'Building'} ${props.height} m` : `${KINDS[kind][0].replace(/s$/, '')} ${count[kind]}`;
      const data = Object.entries(props).filter(([, v]) => v != null).map(([k, v]) => `<Data name="${escapeHtml(k)}"><value>${escapeHtml(v)}</value></Data>`).join('');
      const geom = isPoint(shape) ? `<Point><coordinates>${shape[1]},${shape[0]},0</coordinates></Point>`
        : `<Polygon><outerBoundaryIs><LinearRing><coordinates>${[...shape, shape[0]].map(([la, lo]) => `${lo},${la},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
      folders[kind].push(`<Placemark><name>${escapeHtml(name)}</name><styleUrl>#${kind}</styleUrl><ExtendedData>${data}</ExtendedData>${geom}</Placemark>`);
    }
    const styles = Object.entries(KINDS).map(([k, [, line, fill]]) =>
      `<Style id="${k}"><LineStyle><color>${line}</color><width>2</width></LineStyle><PolyStyle><color>${fill}</color></PolyStyle></Style>`).join('');
    const body = Object.entries(folders).filter(([, v]) => v.length).map(([k, v]) => `<Folder><name>${KINDS[k][0]}</name>${v.join('')}</Folder>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeHtml(title)}</name>${styles}${body}</Document></kml>\n`;
  }

  // ---------------------------------------------------------------- OpenStreetMap
  // Building outlines in a box (south, west, north, east) from the public Overpass API: one request at a time, results kept
  // for the session, a 30 s pause when the server is busy or asks for one (HTTP 406, 429, 502, 503, 504), as its usage policy
  // requires.
  const osmCache = new Map();
  let osmBusy = false, osmPauseUntil = 0;
  async function osmBuildings(s, w, n, e) {
    const key = [s, w, n, e].map((x) => x.toFixed(5)).join(',');
    if (osmCache.has(key)) return osmCache.get(key);
    if (osmBusy) throw new Error('a request to OpenStreetMap is still running');
    const wait = Math.ceil((osmPauseUntil - Date.now()) / 1000);
    if (wait > 0) throw new Error(`the OpenStreetMap server asked for a pause: try again in ${wait} s`);
    osmBusy = true;
    try {
      const q = `[out:json][timeout:25][maxsize:33554432];way["building"](${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)});out geom 3000;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }) });
      if ([406, 429, 502, 503, 504].includes(r.status)) { osmPauseUntil = Date.now() + 30000; throw new Error('the OpenStreetMap server is busy: try again in 30 s'); }
      if (!r.ok) throw new Error(`OpenStreetMap answered HTTP ${r.status}`);
      const j = await r.json();
      const list = [];
      for (const el of Array.isArray(j.elements) ? j.elements : []) {
        if (list.length >= MAX_OSM) break;
        if (!el || el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const ll = ring(el.geometry.map((g) => [g && g.lon, g && g.lat]));
        if (ll) list.push({ latlngs: ll, height: osmHeight(el.tags || {}) });
      }
      osmCache.set(key, list);
      return list;
    } finally { osmBusy = false; }
  }
  // Height of an OSM building, m: its height tag (metres, or feet with ft or '), else 3 m per storey (building:levels and
  // roof:levels); null when neither is given.
  function osmHeight(t) {
    const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?\s*$/i.exec(String(t.height || ''));
    if (m) {
      const h = +m[1] * (m[2] && m[2].toLowerCase() !== 'm' ? 0.3048 : 1);
      if (h > 0 && h <= 1000) return Math.round(h * 10) / 10;
    }
    const lv = parseFloat(t['building:levels']), roof = parseFloat(t['roof:levels']) || 0;
    return lv > 0 && lv < 300 ? (lv + Math.max(0, roof)) * 3 : null;
  }

  return { read, toGeoJSON, toKML, osmBuildings };
})();
