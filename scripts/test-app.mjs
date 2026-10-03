// CP2 behaviour tests: filters.js wired into the live page (app.js + index.html).
// Run: node scripts/test-app.mjs
// app.js is a browser script, so it runs in node:vm against a tiny fake DOM: just the APIs
// app.js touches (getElementById, querySelector(All), closest, classList, dataset, events,
// history.replaceState, location.search). d3/topojson are absent, so the map hides itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSite } from './load.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const site = loadSite();
const plain = v => JSON.parse(JSON.stringify(v));
const CHANGES = plain(site.CHANGES), C2R = plain(site.countryToRegion);

// ---------- fake DOM ----------
class Element {
  constructor(tag = 'div', { id, classes = [], dataset = {}, parent = null, textContent = '' } = {}) {
    this.tagName = tag.toUpperCase(); this.id = id || '';
    this._cls = new Set(classes); this.dataset = { ...dataset }; this.parentElement = parent;
    this.innerHTML = ''; this.textContent = textContent; this.value = ''; this.hidden = false; this.style = {};
    const s = this._cls;
    this.classList = {
      add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)),
      contains: c => s.has(c), toggle: (c, f) => { const on = f === undefined ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; }
    };
  }
  matches(sel) { return sel.split(',').some(one => matchOne(this, one.trim())); }
  closest(sel) { for (let e = this; e; e = e.parentElement) if (e.matches(sel)) return e; return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
}
class HTMLSelectElement extends Element {}
class HTMLFormElement extends Element {}
const camel = a => a.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function matchOne(el, sel) {
  const m = sel.match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!el._cls.has(c.slice(1))) return false;
  for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
    const [, name, val] = a.match(/^\[([\w-]+)(?:\^?="?([^"\]]*)"?)?\]$/) || [];
    if (!name) return false;
    if (name === 'id') { if (!el.id.startsWith(val || '')) return false; continue; }
    if (!name.startsWith('data-')) return false;
    const v = el.dataset[camel(name)];
    if (v === undefined || (val !== undefined && v !== val)) return false;
  }
  return true;
}

function makePage(search = '', hash = '') {
  const all = [];
  const add = (tag, opts) => { const e = new (opts && opts.ctor || Element)(tag, opts); all.push(e); return e; };
  for (const v of ['view-home', 'view-changelog']) add('section', { id: v, classes: v === 'view-home' ? [] : ['hidden'] });
  for (const id of ['changelog-list', 'proof-line', 'stat-countries', 'stat-changes', 'stat-upcoming', 'region-coverage', 'coverage-map', 'footer-verified']) add('div', { id });
  add('input', { id: 'search-input' });
  add('a', { classes: ['nav-link'], dataset: { view: 'view-changelog' } });
  for (const r of ['europe', 'apac', 'menat', 'latam', 'africa']) add('button', { classes: ['region-tab'], dataset: { region: r } });
  for (const f of ['all', 'payroll', 'reporting', 'infrastructure', 'upcoming', 'high-impact']) add('button', { classes: ['filter-btn'], dataset: { filter: f } });
  const select = add('select', { classes: ['country-selector'], ctor: HTMLSelectElement });
  const form = add('form', { classes: ['search-form'], ctor: HTMLFormElement });
  const clear = add('a', { classes: ['filter-clear'], dataset: { action: 'clear-filter' } });

  const listeners = {};
  const calls = [];
  const document = {
    readyState: 'complete',
    getElementById: id => all.find(e => e.id === id) || null,
    querySelector: sel => all.find(e => e.matches(sel)) || null,
    querySelectorAll: sel => all.filter(e => e.matches(sel)),
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    createElement: t => new Element(t)
  };
  const location = { search, pathname: '/', hash, href: 'https://example.test/' + search, origin: 'https://example.test' };
  const history = {
    replaceState: (st, title, url) => {
      calls.push(String(url));
      const u = new URL(String(url), 'https://example.test/');
      location.search = u.search; location.pathname = u.pathname; location.href = u.href; location.hash = u.hash;
    },
    pushState: () => { throw new Error('pushState must not be used (replaceState only)'); }
  };
  const forbidden = () => { throw new Error('browser storage must not be used'); };
  const storage = { getItem: forbidden, setItem: forbidden, removeItem: forbidden };
  const ctx = {
    document, location, history, URLSearchParams, URL, console, Element, HTMLSelectElement, HTMLFormElement,
    setTimeout, clearTimeout, localStorage: storage, sessionStorage: storage,
    scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  // Load scripts in index.html order (only our own files; vendor/reveal are not needed).
  const srcs = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^vendor\/|reveal\.js/.test(s));
  for (const s of srcs) vm.runInContext(read(s), ctx, { filename: s });
  const fire = (type, target) => { const ev = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (listeners[type] || []).forEach(fn => fn(ev)); };
  const list = () => document.getElementById('changelog-list').innerHTML;
  return {
    ctx, calls, list, fire, select, form, clear, srcs,
    // Simulates clicking a rendered link carrying data-action (as the delegated handler sees it).
    action: name => { assert.ok(list().includes(`data-action="${name}"`), `no data-action="${name}" rendered`); fire('click', new Element('a', { dataset: { action: name } })); },
    cards: () => (list().match(/class="item-card"/g) || []).length,
    btn: (cls, key, v) => all.find(e => e._cls.has(cls) && e.dataset[key] === v),
    lastParams: () => { assert.ok(calls.length, 'history.replaceState was never called'); return new URL(calls.at(-1), 'https://example.test/').searchParams; }
  };
}
const count = st => CHANGES.filter(c =>
  (!st.countries || st.countries.includes(c.country)) &&
  (!st.region || C2R[c.country] === st.region) &&
  (!st.filter || st.filter === 'all' || (st.filter === 'high-impact' ? c.impact === 'high' : st.filter === 'upcoming' ? c.upcoming : c.category === st.filter)) &&
  (!st.search || [c.title, c.name, c.detail && c.detail.lead].some(t => (t || '').toLowerCase().includes(st.search)))).length;

// ---------- tests ----------
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 4).join('\n     ')}`); }
}

test('harness.sanity: current page loads and renders the home view', () => {
  const p = makePage('');
  assert.equal(p.ctx.document.getElementById('view-home').classList.contains('hidden'), false);
  assert.match(p.ctx.document.getElementById('proof-line').textContent, new RegExp(`^${CHANGES.length} tracked changes`));
  assert.equal(p.cards(), 0, 'no changelog cards on a plain home load');
});

test('harness.sanity: nav to changelog renders every change', () => {
  const p = makePage('');
  p.fire('click', p.btn('nav-link', 'view', 'view-changelog'));
  assert.equal(p.cards(), CHANGES.length);
});

test('index.script_order: filters.js before app.js, no inline script', () => {
  const html = read('index.html');
  const i = html.indexOf('<script src="filters.js"></script>'), j = html.indexOf('<script src="app.js"></script>');
  assert.ok(i >= 0, 'index.html has no <script src="filters.js">');
  assert.ok(j > i, 'filters.js must load before app.js');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script> found');
});

test('wiring.uses_applyFilters / readUrlState (app.js text)', () => {
  const js = read('app.js');
  assert.match(js, /PayrollFilters\.applyFilters\s*\(/);
  assert.match(js, /PayrollFilters\.(readUrlState|readSelection)\s*\(/);
  assert.match(js, /history\.replaceState\s*\(/);
  assert.ok(!/\b(localStorage|sessionStorage|document\.cookie)\b/.test(js), 'no browser storage');
  assert.ok(!/\bcurrentCountry\b/.test(js), 'currentCountry should be replaced by the countries state');
});

test('url.countries: ?countries=poland,germany shows only those countries', () => {
  const p = makePage('?countries=poland,germany');
  const want = count({ countries: ['poland', 'germany'] });
  assert.ok(want > 0);
  assert.equal(p.cards(), want);
  assert.equal(p.ctx.document.getElementById('view-changelog').classList.contains('hidden'), false, 'changelog view shown');
});

test('url.legacy: ?country=poland works and is rewritten to ?countries=poland', () => {
  const p = makePage('?country=poland');
  assert.equal(p.cards(), count({ countries: ['poland'] }));
  const q = p.lastParams();
  assert.equal(q.get('countries'), 'poland');
  assert.equal(q.get('country'), null);
});

test('url.state: ?filter=, ?region=, ?q= are honoured on load', () => {
  const p = makePage('?countries=poland,in&filter=payroll&region=europe');
  assert.equal(p.cards(), count({ countries: ['poland', 'in'], filter: 'payroll', region: 'europe' }));
  const p2 = makePage('?q=tax');
  assert.equal(p2.cards(), count({ search: 'tax' }));
});

test('xss: unknown codes are dropped and never echoed', () => {
  const p = makePage('?countries=' + encodeURIComponent('<img src=x onerror=1>') + ',xx');
  assert.ok(!/<img|onerror|\bxx\b/.test(p.list()), 'URL value reached the HTML');
  for (const u of p.calls) assert.ok(!/img|onerror|xx/i.test(decodeURIComponent(u)), `invalid code echoed into URL: ${u}`);
  const p2 = makePage('?countries=poland,' + encodeURIComponent('<b>x</b>'));
  assert.equal(p2.cards(), count({ countries: ['poland'] }));
  assert.equal(p2.lastParams().get('countries'), 'poland');
});

test('filter buttons keep countries and update the URL', () => {
  const p = makePage('?countries=poland,germany');
  p.fire('click', p.btn('filter-btn', 'filter', 'high-impact'));
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'], filter: 'high-impact' }));
  const q = p.lastParams();
  assert.equal(q.get('countries'), 'poland,germany');
  assert.equal(q.get('filter'), 'high-impact');
  p.fire('click', p.btn('filter-btn', 'filter', 'upcoming'));
  assert.equal(p.lastParams().get('filter'), 'upcoming');
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'], filter: 'upcoming' }));
});

test('region tab intersects with picked countries and updates the URL', () => {
  const p = makePage('?countries=poland,in');
  p.fire('click', p.btn('region-tab', 'region', 'apac'));
  assert.equal(p.cards(), count({ countries: ['poland', 'in'], region: 'apac' }));
  assert.ok(p.cards() > 0 && p.cards() < count({ countries: ['poland', 'in'] }));
  const q = p.lastParams();
  assert.equal(q.get('region'), 'apac');
  assert.equal(q.get('countries'), 'poland,in');
});

test('search combines with countries and writes ?q=', () => {
  const p = makePage('?countries=poland,germany');
  p.ctx.document.getElementById('search-input').value = 'Wage';
  p.fire('submit', p.form);
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'], search: 'wage' }));
  assert.ok(p.cards() > 0);
  const q = p.lastParams();
  assert.equal((q.get('q') || '').toLowerCase(), 'wage');
  assert.equal(q.get('countries'), 'poland,germany');
});

test('header select sets countries to that one country', () => {
  const p = makePage('?countries=poland,germany&filter=payroll');
  p.select.value = 'uk';
  p.fire('change', p.select);
  assert.equal(p.lastParams().get('countries'), 'uk');
  assert.ok(p.cards() > 0);
  assert.ok(/United Kingdom|uk/i.test(p.list()));
  assert.equal(p.cards() <= count({ countries: ['uk'] }), true);
});

test('clear resets everything and removes the query', () => {
  const p = makePage('?countries=poland&filter=high-impact&region=europe&q=tax');
  p.fire('click', p.clear);
  assert.equal(p.cards(), CHANGES.length);
  assert.ok(p.calls.length, 'replaceState not called on clear');
  const u = new URL(p.calls.at(-1), 'https://example.test/');
  assert.equal(u.search, '', `clear left a query: ${p.calls.at(-1)}`);
  assert.equal(u.pathname, '/');
});

test('xss.rule: validate.mjs flags unescaped ${countries}/${state}/${selection}; real app.js passes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-validate-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'index.html', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(tmp, '.well-known'), { recursive: true });
    const run = js => {
      fs.writeFileSync(path.join(tmp, 'app.js'), js);
      try { return execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' }); }
      catch (e) { return String(e.stdout) + String(e.stderr); }
    };
    const base = read('app.js');
    assert.ok(!/unescaped user-controlled value/.test(run(base)), 'real app.js flagged');
    for (const name of ['countries', 'state.countries', 'selection', 'state.search']) {
      const out = run(base + `\n    document.body.innerHTML = \`<b>\${${name}}</b>\`;\n`);
      assert.match(out, new RegExp('unescaped user-controlled value in template: ' + name.replace('.', '\\.')), `\${${name}} not flagged`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('empty intersection: region outside picked countries explains and offers both escapes', () => {
  const p = makePage('?countries=germany');
  p.fire('click', p.btn('region-tab', 'region', 'apac'));
  assert.equal(p.cards(), 0);
  let q = p.lastParams();
  assert.equal(q.get('countries'), 'germany', 'region switch must keep countries');
  assert.equal(q.get('region'), 'apac');
  assert.match(p.list(), /None of your selected countries \(🇩🇪 Germany\) are in APAC\./);
  assert.ok(!/No changes match this filter/.test(p.list()), 'generic empty state shown instead');
  assert.match(p.list(), /data-action="show-region"[^>]*>Show all of APAC</);
  assert.match(p.list(), /data-action="show-countries"[^>]*>Show my countries in all regions</);
  p.action('show-region');
  q = p.lastParams();
  assert.equal(q.get('countries'), null);
  assert.equal(q.get('region'), 'apac');
  assert.equal(p.cards(), count({ region: 'apac' }));

  const p2 = makePage('?countries=germany&region=apac');
  assert.match(p2.list(), /None of your selected countries/);
  p2.action('show-countries');
  q = p2.lastParams();
  assert.equal(q.get('countries'), 'germany');
  assert.equal(q.get('region'), null);
  assert.equal(p2.cards(), count({ countries: ['germany'] }));
  assert.ok(p2.cards() > 0);
});

test('banner: search with countries keeps countries and names query and countries', () => {
  const p = makePage('?countries=germany');
  p.ctx.document.getElementById('search-input').value = 'tax';
  p.fire('submit', p.form);
  assert.equal(p.lastParams().get('countries'), 'germany');
  assert.equal(p.lastParams().get('q'), 'tax');
  assert.match(p.list(), /Showing results for "<strong>tax<\/strong>" in <strong>🇩🇪 Germany<\/strong>/);
  assert.match(p.list(), /data-action="clear-filter"/);
  const p2 = makePage('?countries=germany&q=' + encodeURIComponent('<i>x</i>'));
  assert.ok(!p2.list().includes('<i>x</i>'), 'query not escaped in banner');
});

test('url.hash: filter click preserves location.hash', () => {
  const p = makePage('?countries=poland', '#changelog');
  p.fire('click', p.btn('filter-btn', 'filter', 'payroll'));
  const u = new URL(p.calls.at(-1), 'https://example.test/');
  assert.equal(u.hash, '#changelog');
  assert.equal(u.searchParams.get('filter'), 'payroll');
});

test('carry-over rules: selectRegion keeps all; goToCountry resets; performSearch keeps all', () => {
  // selectRegion: keeps countries, filter and search.
  const p = makePage('?countries=poland,in&filter=payroll&q=tax');
  p.fire('click', p.btn('region-tab', 'region', 'europe'));
  let q = p.lastParams();
  assert.deepEqual([q.get('countries'), q.get('filter'), q.get('q'), q.get('region')], ['poland,in', 'payroll', 'tax', 'europe']);
  // performSearch: keeps countries, region and filter.
  p.ctx.document.getElementById('search-input').value = 'Wage';
  p.fire('submit', p.form);
  q = p.lastParams();
  assert.deepEqual([q.get('countries'), q.get('filter'), q.get('q'), q.get('region')], ['poland,in', 'payroll', 'wage', 'europe']);
  // goToCountry: single country, its own region, filter and search reset.
  p.select.value = 'jp';
  p.fire('change', p.select);
  q = p.lastParams();
  assert.deepEqual([q.get('countries'), q.get('filter'), q.get('q'), q.get('region')], ['jp', null, null, C2R.jp]);
  assert.equal(p.cards(), count({ countries: ['jp'], region: C2R.jp }));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
