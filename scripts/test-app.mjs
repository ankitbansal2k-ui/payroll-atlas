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
import { createRequire } from 'node:module';
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
  addEventListener(t, fn) { ((this._ls ||= {})[t] ||= []).push(fn); }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  // CP4: attributes (disabled / aria-label are attribute-backed), click spy, detach.
  setAttribute(n, v) { (this._attrs ||= {})[n] = String(v); if (n === 'disabled') this._disabled = true; }
  getAttribute(n) { if (n === 'disabled') return this._disabled ? '' : null; const a = this._attrs || {}; return n in a ? a[n] : null; }
  hasAttribute(n) { return this.getAttribute(n) !== null; }
  removeAttribute(n) { if (this._attrs) delete this._attrs[n]; if (n === 'disabled') this._disabled = false; }
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = !!v; }
  get ariaLabel() { return this.getAttribute('aria-label'); }
  set ariaLabel(v) { this.setAttribute('aria-label', v); }
  click() { (this._onclickSpy || (() => {}))(this); }
  appendChild(c) { c.parentElement = this; return c; }
  removeChild(c) { c.parentElement = null; return c; }
  remove() { this.parentElement = null; }
}
class HTMLSelectElement extends Element {}
class HTMLFormElement extends Element {}
class HTMLInputElement extends Element {
  constructor(tag = 'input', opts = {}) { super(tag, opts); this.type = opts.type || 'text'; this.name = opts.name || ''; this.checked = !!opts.checked; this.disabled = !!opts.disabled; if (opts.value !== undefined) this.value = opts.value; }
}
class HTMLDetailsElement extends Element { constructor(tag = 'details', opts = {}) { super(tag, opts); this.open = false; } }
const camel = a => a.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function matchOne(el, sel) {
  if (/^#[\w-]+$/.test(sel)) return el.id === sel.slice(1);
  const m = sel.match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!el._cls.has(c.slice(1))) return false;
  for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
    const [, name, val] = a.match(/^\[([\w-]+)(?:\^?="?([^"\]]*)"?)?\]$/) || [];
    if (!name) return false;
    if (name === 'rel') { if (el.rel !== val) return false; continue; }
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
  for (const id of ['changelog-list', 'proof-line', 'stat-countries', 'stat-changes', 'stat-upcoming', 'region-coverage', 'coverage-map', 'footer-verified', 'coverage-legend', 'coverage-list']) add('div', { id });
  add('input', { id: 'search-input' });
  add('a', { classes: ['nav-link'], dataset: { view: 'view-changelog' } });
  for (const r of ['europe', 'apac', 'menat', 'latam', 'africa']) add('button', { classes: ['region-tab'], dataset: { region: r } });
  for (const f of ['all', 'payroll', 'reporting', 'high-impact']) add('button', { classes: ['filter-btn'], dataset: { filter: f } });
  // P2-1 timing toggle (index.html): <button type="button" class="when-btn" data-when="all|upcoming|inforce" aria-pressed>.
  for (const w of ['all', 'upcoming', 'inforce']) { const b = add('button', { classes: ['when-btn'].concat(w === 'all' ? ['active'] : []), dataset: { when: w } }); b.setAttribute('aria-pressed', w === 'all' ? 'true' : 'false'); }
  const select = add('select', { classes: ['country-selector'], ctor: HTMLSelectElement });
  const form = add('form', { classes: ['search-form'], ctor: HTMLFormElement });
  const clear = add('a', { classes: ['filter-clear'], dataset: { action: 'clear-filter' } });
  // CP3 picker containers (static in index.html; app.js fills them via innerHTML).
  const picker = add('details', { id: 'country-picker', classes: ['country-picker'], ctor: HTMLDetailsElement });
  const summary = add('summary', { id: 'country-picker-summary', classes: ['country-picker-summary'], parent: picker });
  add('p', { id: 'country-cap-hint', classes: ['country-cap-hint'], parent: picker });
  const pickerList = add('div', { id: 'country-picker-list', classes: ['country-picker-list'], parent: picker });
  add('div', { id: 'country-chips', classes: ['country-chips'] });
  // CP4 static button (index.html): <button type="button" id="export-csv" data-action="export-csv">
  const exportBtn = add('button', { id: 'export-csv', classes: ['export-csv'], dataset: { action: 'export-csv' } });
  exportBtn.type = 'button';
  // CP5 static elements (index.html): print button and print-only header.
  const printBtn = add('button', { id: 'print-page', dataset: { action: 'print' } }); printBtn.type = 'button';
  add('div', { id: 'print-header', classes: ['print-only'] });
  const canon = add('link'); canon.rel = 'canonical'; canon.href = 'https://www.intelligentpayroll.eu/'; canon.setAttribute('href', canon.href);
  // CP4 download spies.
  const dl = { blobs: [], created: [], revoked: [], anchors: [], clicks: [] };
  class Blob { constructor(parts = [], opts = {}) { this.parts = parts; this.type = opts.type || ''; dl.blobs.push(this); } get _text() { return this.parts.map(String).join(''); } }
  let urlN = 0;
  class FakeURL extends URL {
    static createObjectURL(b) { const u = 'blob:https://example.test/fake-' + (++urlN); dl.created.push({ url: u, blob: b }); return u; }
    static revokeObjectURL(u) { dl.revoked.push(u); }
  }
  const timers = [];
  const fakeSetTimeout = (fn, ms, ...a) => { const t = { fn: () => fn(...a), done: false, ms }; timers.push(t); const real = setTimeout(() => { if (!t.done) { t.done = true; t.fn(); } }, ms); if (real.unref) real.unref(); return timers.length; };
  const fakeClearTimeout = id => { const t = timers[id - 1]; if (t) t.done = true; };
  const flushTimers = () => { for (const t of timers) if (!t.done) { t.done = true; t.fn(); } };
  const net = name => () => { throw new Error(name + ' must not be used (nothing is sent to any server)'); };

  const listeners = {};
  const calls = [];
  const document = {
    readyState: 'complete',
    getElementById: id => all.find(e => e.id === id) || null,
    querySelector: sel => all.find(e => e.matches(sel)) || null,
    querySelectorAll: sel => all.filter(e => e.matches(sel)),
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    createElement: t => { const e = new Element(t); if (e.tagName === 'A') { dl.anchors.push(e); e._onclickSpy = a => dl.clicks.push({ href: a.href, download: a.download }); } return e; },
    body: new Element('body'), documentElement: new Element('html')
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
  const winListeners = {}; const printCalls = { n: 0 };
  const forbidden = () => { throw new Error('browser storage must not be used'); };
  const storage = { getItem: forbidden, setItem: forbidden, removeItem: forbidden };
  const ctx = {
    document, location, history, URLSearchParams, URL: FakeURL, console, Element, HTMLSelectElement, HTMLFormElement, HTMLInputElement, HTMLDetailsElement,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, localStorage: storage, sessionStorage: storage, Blob,
    fetch: net('fetch'), XMLHttpRequest: net('XMLHttpRequest'), WebSocket: net('WebSocket'), EventSource: net('EventSource'),
    navigator: { userAgent: 'node', sendBeacon: net('navigator.sendBeacon') },
    innerWidth: 1280, innerHeight: 800, scrollTo() {}, addEventListener: (t, fn) => (winListeners[t] ||= []).push(fn), print: () => { printCalls.n++; }, matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  // Load scripts in index.html order (only our own files; vendor/reveal are not needed).
  const srcs = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^vendor\/|reveal\.js/.test(s));
  for (const s of srcs) vm.runInContext(read(s), ctx, { filename: s });
  const fireRaw = (type, ev) => (listeners[type] || []).forEach(fn => fn(ev));
  const fire = (type, target) => { const ev = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (listeners[type] || []).forEach(fn => fn(ev)); };
  const list = () => document.getElementById('changelog-list').innerHTML;
  const p_fire = (...a) => fire(...a);
  return {
    ctx, calls, list, fire, fireRaw, exportBtn, printCalls, all, printBtn,
    // CP6: element-level + document-level (capture/delegated) listeners for non-bubbling events like toggle.
    fireOn: (el, type) => { const ev = { type, target: el, currentTarget: el, newState: el.open ? 'open' : 'closed' }; ((el._ls || {})[type] || []).forEach(fn => fn(ev)); (listeners[type] || []).forEach(fn => fn(ev)); },
    fireWin: type => (winListeners[type] || []).forEach(fn => fn({ type })), dl, flushTimers, timers,
    exportClick: () => { p_fire('click', exportBtn); }, summary, select, form, clear, srcs, picker, pickerList,
    pickerHtml: () => pickerList.innerHTML,
    chipsHtml: () => document.getElementById('country-chips').innerHTML,
    summaryText: () => { const e = document.getElementById('country-picker-summary'); return (e.textContent || '') + ' ' + (e.innerHTML || '').replace(/<[^>]*>/g, ''); },
    // Checkboxes parsed from the rendered picker HTML.
    boxes: () => [...pickerList.innerHTML.matchAll(/<input\b[^>]*>/g)].map(m => m[0]).filter(t => /type="checkbox"/.test(t)).map(t => ({
      tag: t, value: (t.match(/\bvalue="([^"]*)"/) || [])[1], checked: /\schecked\b/.test(t), disabled: /\sdisabled\b/.test(t) })),
    // Simulates the user toggling a checkbox: change event whose target is an input inside the picker.
    tick: (code, on = true) => { const inp = new HTMLInputElement('input', { type: 'checkbox', name: 'countries', classes: ['country-check'], value: code, checked: on, parent: pickerList }); fire('change', inp); return inp; },
    removeChip: code => { assert.ok(document.getElementById('country-chips').innerHTML.includes(`data-country="${code}"`), `no chip for ${code}`); fire('click', new Element('button', { classes: ['chip-remove'], dataset: { action: 'remove-country', country: code } })); },
    clearCountries: () => { assert.ok(/data-action="clear-countries"/.test(document.getElementById('country-chips').innerHTML + pickerList.innerHTML), 'no data-action="clear-countries" rendered'); fire('click', new Element('button', { dataset: { action: 'clear-countries' } })); },
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
  (!st.filter || st.filter === 'all' || (st.filter === 'high-impact' ? c.impact === 'high' : c.category === st.filter)) &&
  (!st.when || st.when === 'all' || (st.when === 'upcoming' ? !!c.upcoming : !c.upcoming)) &&
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
  // P2-1: 'upcoming' moved from the category buttons to the timing toggle (see p2_1.* tests).
  p.fire('click', p.btn('when-btn', 'when', 'upcoming'));
  assert.equal(p.lastParams().get('when'), 'upcoming');
  assert.equal(p.lastParams().get('filter'), 'high-impact');
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'], filter: 'high-impact', when: 'upcoming' }));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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

// ---------- CP3: multi-country picker ----------
// Contract (implementer must match):
//  index.html: <details id="country-picker" class="country-picker"> with <summary id="country-picker-summary">,
//    <div id="country-picker-list" class="country-picker-list"> inside it, and <div id="country-chips" class="country-chips" aria-live="polite">.
//  app.js renders into #country-picker-list (innerHTML, re-rendered on every state change):
//    <fieldset class="country-group"><legend>Europe</legend> ... per region (5),
//    <label><input type="checkbox" class="country-check" name="countries" value="CODE" [checked] [disabled]> Flag Name</label>
//  #country-chips: <span class="chip">Name <button type="button" class="chip-remove" data-action="remove-country" data-country="CODE" aria-label="Remove Name">x</button></span>
//    plus a <button type="button" data-action="clear-countries">Clear countries</button> when any are selected.
//  #country-picker-summary text contains "Countries (N)" when N>0 (no "(N)" when none).
//  Change events delegated on document: target.classList.contains('country-check') -> read value/checked.
//  Cap 30: when 30 selected, unchecked boxes render disabled and a 31st change is ignored.
const NAME = Object.fromEntries(CHANGES.map(c => [c.country, c.name]));
const CODES = Object.keys(C2R);
const pickNotIn = (n, skip = []) => CODES.filter(c => !skip.includes(c)).slice(0, n);
const checkedCodes = p => p.boxes().filter(b => b.checked).map(b => b.value).sort();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('picker.static: index.html has picker containers, no inline style/handlers', () => {
  const html = read('index.html');
  assert.match(html, /<details\b[^>]*\bid="country-picker"/, 'no <details id="country-picker">');
  assert.match(html, /<summary\b[^>]*\bid="country-picker-summary"/, 'no <summary id="country-picker-summary">');
  assert.match(html, /\bid="country-picker-list"/, 'no #country-picker-list');
  assert.match(html, /<div\b(?=[^>]*\bid="country-chips")(?=[^>]*aria-live="polite")[^>]*>/, 'no <div id="country-chips" aria-live="polite">');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style= attribute in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'on*= handler in index.html');
  assert.ok(!/<style\b/i.test(html), 'inline <style> in index.html');
});

test('picker.css: styles.css has rules for the picker classes', () => {
  const css = read('styles.css');
  for (const c of ['country-picker', 'country-picker-list', 'country-group', 'country-chips', 'chip', 'chip-remove'])
    assert.match(css, new RegExp(`\\.${c}(?![\\w-])`), `styles.css has no .${c} rule`);
});

test('options.complete: one checkbox per country (75) grouped under 5 regions, values = codes', () => {
  const p = makePage('');
  const b = p.boxes();
  assert.equal(b.length, CODES.length, `expected ${CODES.length} checkboxes in #country-picker-list`);
  assert.deepEqual(b.map(x => x.value).sort(), [...CODES].sort());
  assert.ok(b.every(x => /class="[^"]*\bcountry-check\b/.test(x.tag)), 'checkboxes need class country-check');
  assert.equal((p.pickerHtml().match(/class="country-group"/g) || []).length, 5, '5 fieldset.country-group');
  assert.equal((p.pickerHtml().match(/<legend>/g) || []).length, 5, '5 <legend> region headings');
  assert.equal((p.pickerHtml().match(/<label\b/g) || []).length, CODES.length, 'each checkbox inside a <label>');
  assert.ok(p.pickerHtml().includes(NAME.poland), 'labels show country names');
  assert.equal(checkedCodes(p).length, 0);
});

test('picker.tick: ticking two boxes updates URL, cards, boxes, chips and summary', () => {
  const p = makePage('');
  p.tick('poland'); p.tick('germany');
  const q = p.lastParams();
  assert.deepEqual((q.get('countries') || '').split(',').sort(), ['germany', 'poland']);
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'] }));
  assert.deepEqual(checkedCodes(p), ['germany', 'poland']);
  for (const c of ['poland', 'germany'])
    assert.match(p.chipsHtml(), new RegExp(`<button type="button"(?=[^>]*data-action="remove-country")(?=[^>]*data-country="${c}")(?=[^>]*aria-label="Remove ${esc(NAME[c])}")`), `accessible chip for ${c}`);
  assert.match(p.summaryText(), /Countries \(2\)/);
  p.tick('germany', false);
  assert.equal(p.lastParams().get('countries'), 'poland');
  assert.deepEqual(checkedCodes(p), ['poland']);
  assert.match(p.summaryText(), /Countries \(1\)/);
});

test('picker.chip_remove: removing a chip updates URL and unticks box', () => {
  const p = makePage('?countries=poland,uk');
  p.removeChip('uk');
  assert.equal(p.lastParams().get('countries'), 'poland');
  assert.deepEqual(checkedCodes(p), ['poland']);
  assert.ok(!p.chipsHtml().includes('data-country="uk"'));
  assert.equal(p.cards(), count({ countries: ['poland'] }));
});

test('picker.load: ?countries=poland,uk ticks boxes and shows chips', () => {
  const p = makePage('?countries=poland,uk');
  assert.deepEqual(checkedCodes(p), ['poland', 'uk']);
  assert.ok(p.chipsHtml().includes('data-country="poland"') && p.chipsHtml().includes('data-country="uk"'));
  assert.match(p.summaryText(), /Countries \(2\)/);
});

test('picker.clear: Clear countries and Clear filters untick all and remove chips', () => {
  const p = makePage('?countries=poland,uk&filter=payroll');
  p.clearCountries();
  assert.equal(p.lastParams().get('countries'), null);
  assert.equal(p.lastParams().get('filter'), 'payroll', 'clear-countries keeps other filters');
  assert.equal(checkedCodes(p).length, 0);
  assert.ok(!/data-action="remove-country"/.test(p.chipsHtml()));
  assert.ok(!/Countries \(\d+\)/.test(p.summaryText()), 'summary count gone');
  const p2 = makePage('?countries=poland,uk');
  p2.fire('click', p2.clear);
  assert.equal(checkedCodes(p2).length, 0);
  assert.ok(!/data-action="remove-country"/.test(p2.chipsHtml()));
});

test('picker.sync: header select / show-region leave picker consistent', () => {
  const p = makePage('?countries=poland,germany');
  p.select.value = 'uk';
  p.fire('change', p.select);
  assert.deepEqual(checkedCodes(p), ['uk']);
  assert.ok(!p.chipsHtml().includes('data-country="poland"'));
  const p2 = makePage('?countries=germany&region=apac');
  p2.action('show-region');
  assert.equal(checkedCodes(p2).length, 0);
});

test('picker.cap: 31st selection prevented, unticked boxes disabled at 30', () => {
  const thirty = pickNotIn(30);
  const p = makePage('?countries=' + thirty.join(','));
  assert.equal(checkedCodes(p).length, 30);
  const extra = pickNotIn(1, thirty)[0];
  assert.ok(p.boxes().filter(b => !b.checked).every(b => b.disabled), 'unticked boxes must be disabled at the cap');
  p.tick(extra);
  const q = p.lastParams().get('countries') || '';
  assert.equal(q.split(',').length, 30);
  assert.ok(!q.split(',').includes(extra));
  assert.equal(checkedCodes(p).length, 30);
  assert.ok(p.boxes().filter(b => b.checked).every(b => !b.disabled), 'ticked boxes stay enabled (can untick)');
});

test('picker.xss: values/labels come from data only; URL junk never reaches picker or chips', () => {
  const p = makePage('?countries=poland,' + encodeURIComponent('"><img src=x onerror=1>') + ',zz');
  assert.ok(p.boxes().length === CODES.length, 'picker not rendered');
  const html = p.pickerHtml() + p.chipsHtml();
  assert.ok(!/<img|onerror|"zz"/.test(html), 'URL value echoed into picker');
  assert.ok(p.boxes().every(b => CODES.includes(b.value)));
  assert.deepEqual(checkedCodes(p), ['poland']);
  p.tick('"><b>x</b>');
  assert.ok(!/<b>x<\/b>/.test(p.pickerHtml() + p.chipsHtml()));
  assert.equal(p.lastParams().get('countries'), 'poland', 'unknown code from change event ignored');
});

test('picker.focus: removing a chip focuses next/previous chip, else the summary', () => {
  const p = makePage('?countries=poland,uk,germany');
  const chips = p.ctx.document.getElementById('country-chips');
  const focused = [];
  const mk = c => Object.assign(new Element('button', { classes: ['chip-remove'], dataset: { action: 'remove-country', country: c } }), { focus: () => focused.push(c) });
  chips.querySelectorAll = () => [...chips.innerHTML.matchAll(/data-country="([^"]+)"/g)].map(m => mk(m[1]));
  p.summary.focus = () => focused.push('summary');
  p.removeChip('uk'); assert.equal(focused.at(-1), 'germany', 'next chip focused');
  p.removeChip('germany'); assert.equal(focused.at(-1), 'poland', 'previous chip focused');
  p.removeChip('poland'); assert.equal(focused.at(-1), 'summary', 'summary focused when no chips left');
  const p2 = makePage('?countries=poland');
  let f2 = false; p2.summary.focus = () => { f2 = true; };
  p2.clearCountries(); assert.ok(f2, 'Clear countries focuses summary');
});

test('picker.live: chips innerHTML not rewritten on unrelated filter clicks', () => {
  const p = makePage('?countries=poland');
  const chips = p.ctx.document.getElementById('country-chips');
  let html = chips.innerHTML, writes = 0;
  Object.defineProperty(chips, 'innerHTML', { get: () => html, set: v => { html = v; writes++; } });
  p.fire('click', p.btn('filter-btn', 'filter', 'payroll'));
  assert.equal(writes, 0, 'unchanged chips must not be rewritten');
  p.tick('uk');
  assert.equal(writes, 1);
  assert.ok(html.includes('data-country="uk"'));
});

test('picker.cap_hint: hint shown only at the cap and linked via aria-describedby', () => {
  const html = read('index.html');
  assert.match(html, /<p\b(?=[^>]*id="country-cap-hint")(?=[^>]*\bhidden\b)[^>]*>Maximum 30 countries selected/);
  assert.match(html, /<div\b(?=[^>]*id="country-picker-list")(?=[^>]*aria-describedby="country-cap-hint")/);
  const hint = q => q.ctx.document.getElementById('country-cap-hint');
  assert.equal(hint(makePage('?countries=poland')).hidden, true);
  const thirty = pickNotIn(30);
  const p = makePage('?countries=' + thirty.join(','));
  assert.equal(hint(p).hidden, false);
  assert.equal(hint(p).textContent, 'Maximum 30 countries selected', 'hint text from MAX_COUNTRIES');
  assert.match(html, /<p\b(?=[^>]*id="country-cap-hint")(?=[^>]*role="status")/, 'hint is a status region');
  const off = p.boxes().filter(b => b.disabled);
  assert.ok(off.length && off.every(b => /aria-describedby="country-cap-hint"/.test(b.tag)), 'disabled boxes reference the hint');
  assert.ok(p.boxes().filter(b => !b.disabled).every(b => !/aria-describedby/.test(b.tag)));
  p.removeChip(thirty[0]);
  assert.equal(hint(p).hidden, true);
});

test('picker.escape: closes only when the open picker contains the target, with preventDefault', () => {
  const p = makePage();
  let focused = false; p.summary.focus = () => { focused = true; };
  const esc = target => ({ type: 'keydown', key: 'Escape', target, prevented: false, preventDefault() { this.prevented = true; } });
  p.picker.open = true;
  const out = esc(new Element('input', { id: 'search-input' }));
  p.fireRaw('keydown', out);
  assert.equal(p.picker.open, true, 'Escape outside picker ignored');
  assert.equal(out.prevented, false);
  const ev = esc(new HTMLInputElement('input', { id: 'country-filter', parent: p.picker }));
  p.fireRaw('keydown', ev);
  assert.equal(p.picker.open, false);
  assert.ok(focused, 'summary focused');
  assert.ok(ev.prevented, 'preventDefault called');
});

// ---------- CP4: Export CSV ----------
const PF = createRequire(import.meta.url)(path.join(ROOT, 'filters.js'));
const SITE = 'https://www.intelligentpayroll.eu/';
const pad = n => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const expectedCsv = st => PF.toCsv(PF.applyFilters(CHANGES, { countries: [], region: null, filter: 'all', search: '', ...st }, C2R), SITE);
const label = p => p.exportBtn.getAttribute('aria-label');
function doExport(p) {
  assert.equal(p.exportBtn.disabled, false, 'export button must be enabled');
  p.exportClick(); p.flushTimers();
  assert.equal(p.dl.blobs.length, 1, 'exactly one Blob created per click');
  return p.dl.blobs[0];
}

test('export.revoke: object URL revoked after >=40s, or at the start of the next export', () => {
  const p = makePage();
  p.exportClick();
  assert.deepEqual(p.dl.revoked, [], 'not revoked synchronously');
  const t = p.timers.find(x => !x.done);
  assert.ok(t && t.ms >= 40000, 'revoke delayed by at least 40000 ms');
  p.exportClick();
  assert.deepEqual(p.dl.revoked, [p.dl.created[0].url], 'previous pending URL revoked by the next export');
  assert.ok(t.done, 'previous revoke timer cleared');
  p.flushTimers();
  assert.deepEqual(p.dl.revoked, [p.dl.created[0].url, p.dl.created[1].url]);
  const html = read('index.html');
  assert.match(html, /<\/details>\s*<div\b[^>]*class="list-actions"[^>]*>\s*<button\b(?=[^>]*id="export-csv")(?=[^>]*aria-label="Export changes as CSV")[^>]*>[^<]*<\/button>\s*<button\b(?=[^>]*id="print-page")[^>]*>[^<]*<\/button>\s*<\/div>\s*<\/div>/, 'export + print live in .list-actions, the last child of the filter row (after </details>), export with a default aria-label');
});

test('export.static: index.html has the Export CSV button, no inline handler, canonical SITE', () => {
  const html = read('index.html');
  const m = html.match(/<button\b[^>]*\bid="export-csv"[^>]*>([^<]*)<\/button>/);
  assert.ok(m, 'no <button id="export-csv"> in index.html');
  assert.match(m[0], /\btype="button"/); assert.match(m[0], /\bdata-action="export-csv"/);
  assert.ok(!/\son\w+=|\sstyle=/i.test(m[0]), 'no inline handler/style');
  assert.equal(m[1].trim(), 'Export CSV');
  assert.ok(html.indexOf('id="export-csv"') > html.indexOf('data-filter="all"'), 'button lives in the changelog filter bar');
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.intelligentpayroll\.eu\/">/);
});

test('export.click: ?countries=poland,germany&filter=payroll downloads exactly the rendered list', () => {
  const p = makePage('?countries=poland,germany&filter=payroll');
  const want = expectedCsv({ countries: ['poland', 'germany'], filter: 'payroll' });
  assert.equal(want.split('\r\n').length - 2, p.cards(), 'sanity: expected rows == rendered cards');
  const b = doExport(p);
  assert.equal(b.type, 'text/csv;charset=utf-8');
  assert.equal(b._text, want);
  assert.equal(p.dl.created.length, 1); assert.equal(p.dl.created[0].blob, b);
  assert.equal(p.dl.clicks.length, 1, 'one temporary <a> clicked');
  const c = p.dl.clicks[0];
  assert.equal(c.href, p.dl.created[0].url);
  assert.match(c.download, /^intelligent-payroll-changes-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(c.download, PF.csvFilename(localToday()), 'filename uses today\'s LOCAL date');
  assert.deepEqual(p.dl.revoked, [p.dl.created[0].url], 'object URL revoked afterwards');
  assert.equal(p.dl.anchors[0].parentElement, null, 'temporary anchor removed');
});

test('export.bom_header: CSV starts with BOM + header; Page URL uses canonical SITE', () => {
  const b = doExport(makePage('?countries=poland'));
  assert.ok(b._text.startsWith('\uFEFFCountry,Title,Effective,Status,Impact,Category,Source URL,Page URL\r\n'));
  assert.ok(b._text.includes(SITE + 'countries/poland.html'), 'page URL on canonical host');
  assert.ok(!b._text.includes('example.test'), 'must not use location.origin');
});

test('export.search: export reflects search text', () => {
  const p = makePage('?q=tax');
  const b = doExport(p);
  assert.equal(b._text, expectedCsv({ search: 'tax' }));
  assert.equal(b._text.split('\r\n').length - 2, count({ search: 'tax' }));
});

test('export.disabled: empty list disables button with count label; re-enabled after state change', () => {
  const p = makePage('?countries=poland&region=apac');
  assert.equal(p.cards(), 0);
  assert.equal(p.exportBtn.disabled, true, 'disabled when empty');
  assert.equal(p.exportBtn.hasAttribute('disabled'), true);
  assert.equal(label(p), 'Export 0 changes as CSV');
  p.exportClick(); p.flushTimers();
  assert.equal(p.dl.blobs.length, 0, 'no export when empty');
  p.fire('click', p.btn('region-tab', 'region', 'europe'));
  const n = count({ countries: ['poland'], region: 'europe' });
  assert.ok(n > 0);
  assert.equal(p.exportBtn.disabled, false, 're-enabled');
  assert.equal(label(p), `Export ${n} change${n === 1 ? '' : 's'} as CSV`);
  const p2 = makePage('?countries=poland,germany&filter=payroll');
  const n2 = count({ countries: ['poland', 'germany'], filter: 'payroll' });
  assert.equal(label(p2), `Export ${n2} changes as CSV`);
});

test('export.no_network / static checks in app.js', () => {
  const p = makePage('?countries=poland,germany');
  doExport(p); // fetch / XMLHttpRequest / sendBeacon throw in the harness
  const js = read('app.js');
  assert.ok(!/\b(fetch|XMLHttpRequest|sendBeacon)\b/.test(js), 'no network APIs in app.js');
  assert.match(js, /PayrollFilters\.toCsv\s*\(/); assert.match(js, /PayrollFilters\.csvFilename\s*\(/);
  assert.match(js, /revokeObjectURL/);
});

// ---------- CP5: print ----------
test('print.button: clicking Print / PDF calls window.print once (delegated, data-action="print")', () => {
  const p = makePage('?countries=poland,germany');
  p.fire('click', p.printBtn);
  assert.equal(p.printCalls.n, 1, 'window.print must be called exactly once');
  const html = read('index.html');
  assert.match(html, /<button type="button" id="print-page"[^>]*data-action="print"[^>]*>Print \/ PDF<\/button>/, 'static button in index.html');
});

// Real cards are only innerHTML strings in this fake DOM, so materialise them as elements the way a
// browser would: .item-card[data-index] with a child .item-detail reachable via card.querySelector.
function materialiseCards(p) {
  const n = p.cards();
  const cards = [];
  for (let i = 0; i < n; i++) {
    const card = new p.ctx.Element('div', { classes: ['item-card'], dataset: { index: String(i) } });
    const panel = new p.ctx.Element('div', { classes: ['item-detail'], parent: card });
    card.querySelector = sel => (sel === '.item-detail' ? panel : null);
    card.querySelectorAll = sel => (sel === '.item-detail' ? [panel] : []);
    p.all.push(card, panel); cards.push({ card, panel });
  }
  return cards;
}

test('print.beforeprint: every filtered card detail is rendered, then restored afterprint', () => {
  const p = makePage('?countries=poland,germany');
  p.fire('click', p.btn('nav-link', 'view', 'view-changelog'));
  const n = count({ countries: ['poland', 'germany'] });
  assert.equal(p.cards(), n);
  const cards = materialiseCards(p);
  p.fireWin('beforeprint');
  for (const { panel } of cards) assert.match(panel.innerHTML, /class="detail-verified"/, 'detail panel must be filled before printing');
  p.fireWin('afterprint');
  for (const { card } of cards) assert.equal(card.classList.contains('open'), false, 'cards the user had not opened stay closed after printing');
});

test('print.header: beforeprint writes active selection and print date into #print-header', () => {
  const p = makePage('?countries=poland,germany&filter=payroll');
  p.fire('click', p.btn('nav-link', 'view', 'view-changelog'));
  p.fireWin('beforeprint');
  const h = p.ctx.document.getElementById('print-header');
  const text = (h.textContent || '') + ' ' + (h.innerHTML || '').replace(/<[^>]*>/g, '');
  assert.match(text, /Poland/); assert.match(text, /Germany/); assert.match(text, /Payroll/i);
  assert.match(text, /\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/, 'print date like "3 October 2026"');
});

test('print.header_escaped: hostile URL values never reach #print-header as markup', () => {
  const p = makePage('?countries=%3Cimg%20src%3Dx%3E,poland&q=%3Cb%3Ex');
  p.fire('click', p.btn('nav-link', 'view', 'view-changelog'));
  p.fireWin('beforeprint');
  const h = p.ctx.document.getElementById('print-header');
  assert.ok(!/<img|<b>/i.test(h.innerHTML || ''), 'unescaped user value in print header');
});


// ---------- CP6: picker panel anchored under the summary button ----------
// Minimal CSS walker: returns [{media, sel, decls}] (media = '' for top-level rules).
function cssRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  (function walk(src, media) {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i); if (open < 0) break;
      const head = src.slice(i, open).trim();
      let d = 0, j = open;
      for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
      const body = src.slice(open + 1, j);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) {
        const decls = {};
        for (const part of body.split(';')) { const k = part.indexOf(':'); if (k > 0) decls[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).trim().replace(/\s+/g, ' '); }
        for (const sel of head.split(',')) out.push({ media, sel: sel.trim().replace(/\s+/g, ' '), decls });
      }
      i = j + 1;
    }
  })(css, '');
  return out;
}
const CP6_RULES = cssRules(read('styles.css'));
// Effective value of prop for an exact selector in a media context (last wins; '' = screen >480px base rules).
const cssVal = (sel, prop, media = m => m === '') => {
  let v; for (const r of CP6_RULES) if (r.sel === sel && media(r.media) && prop in r.decls) v = r.decls[prop]; return v;
};
const isMobile = m => /max-width:\s*480px/.test(m);

test('cp6.css.anchor_context: .country-picker is position: relative on screens >480px', () => {
  assert.equal(cssVal('.country-picker', 'position'), 'relative', '.country-picker must be the positioning context');
});
test('cp6.css.panel_under_button: panel is absolute at top:100% left:0 of the picker', () => {
  assert.equal(cssVal('.country-picker-panel', 'position'), 'absolute');
  assert.equal(cssVal('.country-picker-panel', 'top'), '100%');
  assert.equal(cssVal('.country-picker-panel', 'left'), '0');
});
test('cp6.css.panel_width: panel width is min(320px, calc(100vw - 32px))', () => {
  assert.equal((cssVal('.country-picker-panel', 'width') || '').replace(/\s+/g, ''), 'min(320px,calc(100vw-32px))');
});
test('cp6.css.align_right: .country-picker.panel-align-right .country-picker-panel sets right:0; left:auto', () => {
  const sel = '.country-picker.panel-align-right .country-picker-panel';
  assert.equal(cssVal(sel, 'right'), '0', 'right:0 missing');
  assert.equal(cssVal(sel, 'left'), 'auto', 'left:auto missing');
});
test('cp6.css.mobile_in_flow: at <=480px the picker and panel stay static and full width', () => {
  assert.equal(cssVal('.country-picker-panel', 'position', isMobile), 'static');
  assert.equal(cssVal('.country-picker-panel', 'width', isMobile), '100%');
  assert.equal(cssVal('.country-picker', 'width', isMobile), '100%');
  const ar = cssVal('.country-picker.panel-align-right .country-picker-panel', 'position', isMobile);
  assert.ok(ar === undefined || ar === 'static', 'align-right must not take the panel out of flow on phones');
});

function cp6Page(innerWidth, left, width = 120) {
  const p = makePage('');
  p.ctx.innerWidth = innerWidth;
  const rect = () => ({ left, right: left + width, width, top: 100, bottom: 144, height: 44, x: left, y: 100 });
  p.summary.getBoundingClientRect = rect; p.picker.getBoundingClientRect = rect;
  const open = o => { p.picker.open = o; p.fireOn(p.picker, 'toggle'); };
  const has = () => p.picker.classList.contains('panel-align-right');
  return { p, open, has, move: l => { left = l; }, resize: w => { p.ctx.innerWidth = w; p.fireWin('resize'); } };
}
test('cp6.js.no_inline: app.js wires toggle/resize via addEventListener and uses panel-align-right', () => {
  const js = read('app.js');
  assert.ok(/addEventListener\(\s*['"]toggle['"]/.test(js), 'no toggle listener');
  assert.ok(/addEventListener\(\s*['"]resize['"]/.test(js), 'no resize listener');
  assert.ok(/panel-align-right/.test(js), 'class name panel-align-right not used');
  assert.ok(!/\bontoggle\b|\bonresize\b/.test(js + read('index.html')), 'inline handler property used');
});
test('cp6.js.right_edge: opening near the right edge adds panel-align-right', () => {
  const t = cp6Page(1000, 800); // 800 + 320 > 1000 - 16
  t.open(true);
  assert.equal(t.has(), true, 'panel would overflow but class not added');
});
test('cp6.js.left_edge: opening with room on the right leaves/removes panel-align-right', () => {
  const t = cp6Page(1000, 100);
  t.p.picker.classList.add('panel-align-right'); // stale class from an earlier open
  t.open(true);
  assert.equal(t.has(), false, 'panel fits but class still present');
});
test('cp6.js.boundary: exactly fitting (left + 320 == innerWidth - 16) does not align right', () => {
  const t = cp6Page(1000, 664);
  t.open(true);
  assert.equal(t.has(), false);
});
test('cp6.js.resize_open: resize while open re-evaluates both ways', () => {
  const t = cp6Page(1400, 800);
  t.open(true);
  assert.equal(t.has(), false, 'fits at 1400px');
  t.resize(1000);
  assert.equal(t.has(), true, 'shrinking window must align right');
  t.resize(1400);
  assert.equal(t.has(), false, 'growing window must remove the class');
});
test('cp6.js.closed_noop: toggle closed and resize while closed change nothing', () => {
  const t = cp6Page(1000, 800);
  t.open(false);
  assert.equal(t.has(), false, 'closed toggle must not add the class');
  t.resize(900);
  assert.equal(t.has(), false, 'resize while closed must not add the class');
  t.p.picker.classList.add('panel-align-right');
  t.move(100); t.resize(1000);
  assert.equal(t.has(), true, 'resize while closed must not touch the class');
});

const cp6State = t => {
  const r = t.p.picker.classList.contains('panel-align-right'), w = t.p.picker.classList.contains('panel-align-row');
  assert.ok(!(r && w), 'both alignment classes present at once');
  return r ? 'right' : w ? 'row' : 'default';
};
test('cp6.js.row_fallback: neither alignment fits (500px, summary 170..290) -> panel-align-row only', () => {
  const t = cp6Page(500, 170, 120); // left: 170+320 > 484; right: 290-320 = -30 < 16
  t.open(true);
  assert.equal(cp6State(t), 'row');
  assert.equal(t.p.picker.classList.contains('panel-align-right'), false, 'must not right-align off the left edge');
});
test('cp6.js.right_fits: right alignment used when it fits (1000px, summary 800..930)', () => {
  const t = cp6Page(1000, 800, 130);
  t.open(true);
  assert.equal(cp6State(t), 'right');
});
test('cp6.js.default_fits: left alignment fits -> no class', () => {
  const t = cp6Page(1000, 100, 130);
  t.p.picker.classList.add('panel-align-row'); // stale
  t.open(true);
  assert.equal(cp6State(t), 'default');
});
test('cp6.js.resize_three_states: resize moves through default/right/row and back', () => {
  const t = cp6Page(1400, 300, 120); // summary 300..420
  t.open(true);
  assert.equal(cp6State(t), 'default', '1400');
  t.resize(600); // 300+320 > 584; 420-320 = 100 >= 16
  assert.equal(cp6State(t), 'right', '600');
  t.move(170); t.resize(500); // 170..290 at 500
  assert.equal(cp6State(t), 'row', '500');
  t.move(300); t.resize(600);
  assert.equal(cp6State(t), 'right', 'row -> right');
  t.move(170); t.resize(500);
  assert.equal(cp6State(t), 'row', 'right -> row');
  t.resize(1400);
  assert.equal(cp6State(t), 'default', 'row -> default');
  t.open(false); t.resize(500);
  assert.equal(cp6State(t), 'default', 'closed: unchanged');
});
test('cp6.css.align_row: panel-align-row makes the picker static inside the (relative) filter row, panel left:0', () => {
  assert.equal(cssVal('.changelog-filters', 'position'), 'relative', 'filter row must be the positioning context');
  assert.equal(cssVal('.changelog-filters .country-picker.panel-align-row', 'position'), 'static');
  assert.equal(cssVal('.country-picker.panel-align-row .country-picker-panel', 'left'), '0');
  assert.equal(cssVal('.country-picker.panel-align-row .country-picker-panel', 'right'), 'auto');
  assert.equal(cssVal('.country-picker-panel', 'position', isMobile), 'static', 'phones stay in flow');
});

// ---------- P2-1: "Systems & e-filing" label + separate timing toggle ----------
// Contract: index.html .changelog-filters contains <div class="when-toggle" role="group" aria-label="..."> with
// three <button type="button" class="when-btn" data-when="all|upcoming|inforce" aria-pressed="true|false">
// labelled "All dates" / "Upcoming" / "In force" (initially all = true). No data-filter="upcoming" button.
// app.js state gains `when` (all|upcoming|inforce), URL ?when= (omitted when all); legacy ?filter=upcoming is
// rewritten to ?when=upcoming. Active timing button gets class "active" + aria-pressed="true", others "false".
// Banner and print header use PayrollFilters.CATEGORY_LABELS / WHEN_LABELS (no raw 'infrastructure').
const PF2 = createRequire(import.meta.url)(path.join(ROOT, 'filters.js'));
const visible = h => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ');
const pressed = p => ['all', 'upcoming', 'inforce'].filter(w => p.btn('when-btn', 'when', w).getAttribute('aria-pressed') === 'true');
const activeWhen = p => ['all', 'upcoming', 'inforce'].filter(w => p.btn('when-btn', 'when', w).classList.contains('active'));
const headerText = p => { const h = p.ctx.document.getElementById('print-header'); return (h.textContent || '') + ' ' + (h.innerHTML || '').replace(/<[^>]*>/g, ''); };

test('p2_1.static: index.html timing toggle markup, no "Upcoming Only" filter button, label text', () => {
  const html = read('index.html');
  const fs0 = html.indexOf('class="changelog-filters"'), picker = html.indexOf('id="country-picker"');
  const bar = html.slice(fs0, picker);
  assert.ok(!/data-filter="upcoming"/.test(html), 'data-filter="upcoming" button must be gone');
  assert.ok(!/Upcoming Only/i.test(html), '"Upcoming Only" text must be gone');
  assert.match(bar, /<button\b[^>]*data-filter="high-impact"[^>]*>/, 'high-impact stays among category buttons');
  const group = bar.match(/<div\b(?=[^>]*class="when-toggle")(?=[^>]*role="group")(?=[^>]*aria-label="[^"]+")[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(group, '.changelog-filters must contain <div class="when-toggle" role="group" aria-label="..."> before #country-picker');
  const btns = [...group[1].matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(m => ({ a: m[1], text: m[2].trim() }));
  assert.deepEqual(btns.map(b => (b.a.match(/data-when="([^"]*)"/) || [])[1]), ['all', 'upcoming', 'inforce']);
  assert.deepEqual(btns.map(b => b.text), ['All dates', 'Upcoming', 'In force']);
  for (const b of btns) {
    assert.match(b.a, /type="button"/); assert.match(b.a, /class="[^"]*\bwhen-btn\b/);
    assert.match(b.a, /aria-pressed="(true|false)"/); assert.ok(!/\son\w+=|style=/.test(b.a), 'no inline handler/style');
    assert.ok(!/\bfilter-btn\b/.test(b.a), 'timing buttons are not .filter-btn');
  }
  assert.deepEqual(btns.map(b => /aria-pressed="true"/.test(b.a)), [true, false, false]);
  assert.ok(!/\bInfrastructure\b/.test(visible(html)), 'no visible "Infrastructure" in index.html');
});

test('p2_1.css: .when-toggle and .when-btn styled, visible focus on .when-btn', () => {
  const css = read('styles.css');
  assert.match(css, /\.when-toggle\s*[,{]/, 'styles.css has .when-toggle');
  assert.match(css, /\.when-btn[^{]*\{/, 'styles.css has .when-btn');
  assert.match(css, /\.when-btn[^{,]*:focus-visible/, '.when-btn:focus-visible rule');
});

test('p2_1.click: timing toggle updates state, URL, cards and pressed state; combines with category', () => {
  const p = makePage('?countries=poland,germany&filter=payroll');
  p.fire('click', p.btn('when-btn', 'when', 'upcoming'));
  let q = p.lastParams();
  assert.equal(q.get('when'), 'upcoming'); assert.equal(q.get('filter'), 'payroll'); assert.equal(q.get('countries'), 'poland,germany');
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'], filter: 'payroll', when: 'upcoming' }));
  assert.deepEqual(pressed(p), ['upcoming']); assert.deepEqual(activeWhen(p), ['upcoming']);
  p.fire('click', p.btn('when-btn', 'when', 'inforce'));
  q = p.lastParams();
  assert.equal(q.get('when'), 'inforce');
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'], filter: 'payroll', when: 'inforce' }));
  assert.deepEqual(pressed(p), ['inforce']);
  p.fire('click', p.btn('filter-btn', 'filter', 'all'));
  assert.equal(p.lastParams().get('when'), 'inforce', 'category click keeps timing');
  p.fire('click', p.btn('when-btn', 'when', 'all'));
  assert.equal(p.lastParams().get('when'), null, 'when=all omitted from URL');
  assert.equal(p.cards(), count({ countries: ['poland', 'germany'] }));
  assert.deepEqual(pressed(p), ['all']);
});

test('p2_1.click_from_home: timing click with no query renders the upcoming list', () => {
  const p = makePage('');
  p.fire('click', p.btn('nav-link', 'view', 'view-changelog'));
  p.fire('click', p.btn('when-btn', 'when', 'upcoming'));
  assert.equal(p.cards(), count({ when: 'upcoming' }));
  assert.ok(p.cards() > 0 && p.cards() < CHANGES.length);
  assert.equal(p.lastParams().toString(), 'when=upcoming');
});

test('p2_1.url_load: ?when=inforce&filter=reporting shows the changelog with both applied', () => {
  const p = makePage('?when=inforce&filter=reporting');
  assert.equal(p.ctx.document.getElementById('view-changelog').classList.contains('hidden'), false, '?when= opens the changelog');
  assert.equal(p.cards(), count({ filter: 'reporting', when: 'inforce' }));
  assert.deepEqual(pressed(p), ['inforce']);
  assert.ok(p.btn('filter-btn', 'filter', 'reporting').classList.contains('active'));
  const w = makePage('?when=upcoming');
  assert.equal(w.ctx.document.getElementById('view-changelog').classList.contains('hidden'), false, '?when= alone opens the changelog');
  assert.equal(w.cards(), count({ when: 'upcoming' }));
});

test('p2_1.legacy: ?filter=upcoming loads as when=upcoming and the URL is rewritten', () => {
  const p = makePage('?countries=poland&filter=upcoming');
  assert.equal(p.cards(), count({ countries: ['poland'], when: 'upcoming' }));
  const q = p.lastParams();
  assert.equal(q.get('when'), 'upcoming'); assert.equal(q.get('filter'), null, 'legacy filter=upcoming removed');
  assert.equal(q.get('countries'), 'poland');
  assert.deepEqual(pressed(p), ['upcoming']);
  assert.ok(p.btn('filter-btn', 'filter', 'all').classList.contains('active'), 'category resets to All');
  const h = makePage('?filter=high-impact');
  assert.equal(h.cards(), count({ filter: 'high-impact' }), 'high-impact keeps working');
  assert.equal(h.lastParams().get('filter'), 'high-impact');
});

test('p2_1.invalid_when: ?when=junk falls back to all and is stripped', () => {
  const p = makePage('?countries=poland&when=junk');
  assert.equal(p.cards(), count({ countries: ['poland'] }));
  assert.equal(p.lastParams().get('when'), null);
  assert.deepEqual(pressed(p), ['all']);
});

test('p2_1.clear: Clear resets timing too', () => {
  const p = makePage('?countries=poland&when=upcoming');
  p.fire('click', p.clear);
  assert.equal(new URL(p.calls.at(-1), 'https://example.test/').search, '');
  assert.deepEqual(pressed(p), ['all']);
  assert.equal(p.cards(), CHANGES.length);
});

test('p2_1.banner: banner names category by label and the timing choice', () => {
  const p = makePage('?countries=poland&filter=reporting&when=upcoming'); // P2-4: was infrastructure
  const banner = (p.list().match(/<div class="filter-banner">([\s\S]*?)<\/div>/) || [])[1] || '';
  assert.ok(banner, 'banner rendered');
  const text = banner.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
  assert.match(text, /Reporting/, 'category label in banner: ' + text.trim());
  assert.ok(!/infrastructure/i.test(text), 'raw value / old label not shown: ' + text.trim());
  assert.match(text, /Upcoming/, 'timing shown in banner');
});

test('p2_1.print_header: uses the shared labels', () => {
  const p = makePage('?countries=poland&filter=reporting&when=inforce'); // P2-4: was infrastructure
  p.fireWin('beforeprint');
  const t = headerText(p).replace(/&amp;/g, '&');
  assert.match(t, /Reporting/, t); assert.ok(!/infrastructure/i.test(t), t);
  assert.match(t, /In force/);
  const p2 = makePage('?countries=poland&filter=upcoming');
  p2.fireWin('beforeprint');
  assert.match(headerText(p2), /Upcoming/);
});

test('p2_1.export: export honours when; CSV matches filters.js toCsv (label in Category)', () => {
  const p = makePage('?when=upcoming&filter=payroll');
  const want = PF2.toCsv(PF2.applyFilters(CHANGES, { countries: [], region: null, filter: 'payroll', when: 'upcoming', search: '' }, C2R), SITE);
  const got = doExport(p)._text;
  assert.equal(got, want);
  assert.equal(got.slice(1).split('\r\n').length - 2, count({ filter: 'payroll', when: 'upcoming' }));
});

test('p2_1.single_map: app.js uses the shared label map, no own "Infrastructure"/"Upcoming only"', () => {
  const js = read('app.js');
  assert.ok(!/['"]Infrastructure['"]/.test(js), 'app.js must not hard-code "Infrastructure"');
  assert.ok(!/Upcoming only/i.test(js), 'old "Upcoming only" label gone');
  assert.match(js, /PayrollFilters\.CATEGORY_LABELS/, 'app.js uses PayrollFilters.CATEGORY_LABELS');
});

// ---------- P2-4: infrastructure category removed ----------
test('p2_4.static: no infrastructure button or "Systems & e-filing" text in index.html', () => {
  const html = read('index.html');
  assert.ok(!/data-filter="infrastructure"/.test(html), 'infrastructure button must be gone');
  assert.ok(!/Systems (&amp;|&) e-filing/.test(html), '"Systems & e-filing" text must be gone');
  const fs0 = html.indexOf('class="changelog-filters"'), picker = html.indexOf('id="country-picker"');
  const filters = [...html.slice(fs0, picker).matchAll(/data-filter="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(filters, ['all', 'payroll', 'reporting', 'high-impact']);
});
test('p2_4.legacy: ?filter=infrastructure&countries=poland is rewritten to ?countries=poland', () => {
  const p = makePage('?filter=infrastructure&countries=poland');
  assert.equal(p.cards(), count({ countries: ['poland'] }));
  assert.equal(p.lastParams().toString(), 'countries=poland');
  assert.ok(p.btn('filter-btn', 'filter', 'all').classList.contains('active'), 'All category active');
});


// ---------- P2-2: status chip + formatted date on cards ----------
// Contract: each .item-card header contains exactly one
//   <span class="status-chip status-KEY">[optional <span class="...">Status: </span>]LABEL</span>
// with KEY = PayrollFilters.statusOf(item, LAST_VERIFIED iso) and LABEL = STATUS_LABELS[KEY]; when
// formatEffective(item.effective) is non-empty, it follows in <span class="status-date">DATE</span>.
// The optional free-text `badge` is shown only when present, escaped, as <span class="badge-note">TEXT</span>.
// The old status badges (class="badge draft|upcoming|active") are gone; New/Updated/High impact stay.
const escH = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const VER = read('app.js').match(/const LAST_VERIFIED = new Date\('(\d{4}-\d{2}-\d{2})T/)[1];
function cardHeaders(p) {
  return p.list().split('<div class="item-card"').slice(1).map(h => h.slice(0, h.indexOf('<div class="item-detail"')));
}
function entryFor(h) {
  const m = h.match(/<strong>([\s\S]*?)<\/strong><br\/>\s*<span class="item-title">([\s\S]*?)<\/span>/);
  assert.ok(m, 'card header layout changed: ' + h.slice(0, 200));
  const hits = CHANGES.filter(c => `${escH(c.flag)} ${escH(c.name)}` === m[1] && escH(c.title) === m[2]);
  assert.equal(hits.length, 1, 'card maps to one entry: ' + m[1] + ' / ' + m[2]);
  return hits[0];
}
const CHIP_RE = /<span class="status-chip status-([a-z]+)">(?:<span class="[^"]+">Status: <\/span>)?([^<]*)<\/span>/g;
test('p2_2.cards: every card has exactly one correct status chip and the formatted date', () => {
  const p = makePage('');
  p.fire('click', p.btn('nav-link', 'view', 'view-changelog'));
  const heads = cardHeaders(p);
  assert.equal(heads.length, CHANGES.length);
  const seen = new Set();
  for (const h of heads) {
    const e = entryFor(h), id = e.country + '/' + e.section;
    const chips = [...h.matchAll(CHIP_RE)];
    assert.equal((h.match(/status-chip/g) || []).length, 1, `${id}: exactly one status-chip`);
    assert.equal(chips.length, 1, `${id}: chip markup ${h.match(/<span class="status-chip[^]*?<\/span>/)}`);
    const k = PF2.statusOf(e, VER);
    assert.equal(chips[0][1], k, `${id}: class status-${k}`);
    assert.equal(chips[0][2], escH(PF2.STATUS_LABELS[k]), `${id}: label`);
    seen.add(k);
    const date = PF2.formatEffective(e.effective);
    const d = [...h.matchAll(/<span class="status-date">([^<]*)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(d, date ? [date] : [], `${id}: status-date`);
    if (date) assert.ok(h.indexOf('status-date') > h.indexOf('status-chip'), `${id}: date follows chip`);
    const notes = [...h.matchAll(/<span class="badge-note">([^<]*)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(notes, e.badge ? [escH(e.badge)] : [], `${id}: badge note only when badge present`);
    assert.ok(!/class="badge (draft|upcoming|active)"/.test(h), `${id}: old status badge still rendered`);
    assert.ok(!/Draft — not yet law[\s\S]*Draft — not yet law/.test(h), `${id}: draft label shown twice`);
  }
  for (const k of ['draft', 'upcoming', 'inforce', 'ongoing']) assert.ok(seen.has(k), `some card shows ${k}`);
});
test('p2_2.cards_draft: draft cards show the draft chip', () => {
  const p = makePage('?when=upcoming');
  const heads = cardHeaders(p).filter(h => entryFor(h).draft);
  assert.ok(heads.length > 0, 'real data has drafts');
  for (const h of heads) assert.match(h, /<span class="status-chip status-draft">(?:<span class="[^"]+">Status: <\/span>)?Draft — not yet law<\/span>/);
});
test('p2_2.static: app.js uses the shared helpers and escapes the badge note', () => {
  const js = read('app.js');
  assert.match(js, /PayrollFilters\.statusOf\(/); assert.match(js, /PayrollFilters\.formatEffective\(/);
  assert.match(js, /PayrollFilters\.STATUS_LABELS/);
  for (const m of js.matchAll(/[^\n]{0,20}item\.badge\b[^\n]{0,5}/g)) {
    if (/\bitem\.badge\s*\?/.test(m[0]) || /&&\s*$|^\s*\(?\s*item\.badge\s*(\)|&&)/.test(m[0])) continue;
    assert.match(m[0], /escapeHtml\(item\.badge\)/, 'unescaped item.badge: ' + m[0]);
  }
  assert.match(read('styles.css'), /\.status-chip\b/); assert.match(read('styles.css'), /\.status-(draft|upcoming|inforce|ongoing)\b/);
});

// ---------- P2-3: coverage depth on the map ----------
// Contract: index.html #coverage-legend (static text legend, swatches .depth-1..4), <details id="coverage-list-details">
// with <summary>Coverage by country</summary> and #coverage-list filled by app.js at load (independent of d3).
// app.js shades covered paths/dots with class depth-<PayrollFilters.depthBucket(count)>, counts from PayrollFilters.coverageDepth(CHANGES).
const entriesText = n => `${n} ${n === 1 ? 'entry' : 'entries'}`;
test('p2_3.legend_static', () => {
  const html = read('index.html');
  const m = html.match(/<([a-z]+)[^>]*\bid="coverage-legend"[^>]*>([\s\S]*?)<\/\1>/);
  assert.ok(m, 'index.html has no #coverage-legend');
  const txt = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const t of ['1 entry', '2 entries', '3 entries', '4+ entries']) assert.ok(txt.includes(t), `legend text lacks "${t}": ${txt}`);
  for (let b = 1; b <= 4; b++) assert.match(m[2], new RegExp(`class="[^"]*\\bdepth-${b}\\b`), `legend swatch depth-${b}`);
  assert.ok(!/\sstyle=/.test(m[0]), 'no inline style (CSP)');
  assert.ok(!/shaded by region/.test(html), 'map aria-label should describe shading by number of entries');
});
test('p2_3.list_alternative_static', () => {
  const html = read('index.html');
  const d = html.match(/<details[^>]*\bid="coverage-list-details"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(d, 'index.html has no <details id="coverage-list-details">');
  assert.match(d[1], /<summary[^>]*>[^<]*Coverage by country/i);
  assert.match(d[1], /\bid="coverage-list"/);
});
test('p2_3.styles_depth_classes', () => {
  const css = read('styles.css');
  const fills = [];
  for (let b = 1; b <= 4; b++) {
    const m = css.match(new RegExp(`\\.depth-${b}\\b[^{]*\\{([^}]*)\\}`));
    assert.ok(m, `styles.css has no .depth-${b} rule`);
    const f = (m[1].match(/(?:^|;)\s*(?:fill|background(?:-color)?)\s*:\s*([^;]+)/) || [])[1];
    assert.ok(f, `.depth-${b} sets no fill/background`);
    fills.push(f.trim());
  }
  assert.equal(new Set(fills).size, 4, 'depth fills must be distinct: ' + fills.join(' | '));
});
test('p2_3.app_uses_pure_functions', () => {
  const js = read('app.js');
  assert.match(js, /PayrollFilters\.coverageDepth\s*\(\s*CHANGES\s*\)/);
  assert.match(js, /PayrollFilters\.depthClass\s*\(/, 'map classes come from PayrollFilters.depthClass');
  assert.match(read('filters.js'), /depth-\$\{depthBucket\(/, 'depthClass builds depth-${bucket}');
  assert.ok(!/attr\('fill',\s*d\s*=>\s*`var\(--region-/.test(js), 'map fill must come from depth classes, not region colour');
});
test('p2_3.single_accessible_name', () => {
  // One accessible name per map shape: aria-label "<Country>, N entries"; no SVG <title> (avoids double tooltip/announcement).
  const js = read('app.js');
  assert.ok(!/createElementNS\([^)]*'title'\)/.test(js) && !/append\('title'\)/.test(js), 'map shapes must not get an SVG <title>');
  assert.ok(!/changes? tracked/.test(js), 'old "N changes tracked" wording removed');
  assert.match(js, /const label = entriesLabel;/, 'aria-label and tooltip share the list wording');
  assert.match(js, /\.attr\('aria-label', d => label\(d\.code\)\)/);
  assert.match(js, /const entriesLabel = code => `\$\{names\[code\] \|\| code\}, \$\{entriesText\(/);
});
test('p2_3.legend_group_role', () => {
  assert.match(read('index.html'), /<div(?=[^>]*\bid="coverage-legend")(?=[^>]*\brole="group")(?=[^>]*\baria-label="[^"]+")[^>]*>/);
});
test('p2_3.print_hides_legend_and_list', () => {
  const css = read('styles.css');
  const m = css.match(/@media print[\s\S]*?\{([^}]*display:\s*none !important;)/);
  assert.ok(m && /\.coverage-legend\b/.test(m[1]) && /\.coverage-list-details\b/.test(m[1]), 'print hides legend + list');
});
test('p2_3.list_rendered_without_d3', () => {
  const p = makePage('');
  const html = p.ctx.document.getElementById('coverage-list').innerHTML;
  const counts = {}, names = {};
  for (const c of CHANGES) { counts[c.country] = (counts[c.country] || 0) + 1; names[c.country] = c.name; }
  const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1].replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
  assert.equal(items.length, Object.keys(C2R).length, 'one <li> per covered country');
  const order = Object.keys(C2R).sort((a, b) => counts[b] - counts[a] || names[a].localeCompare(names[b]));
  order.forEach((code, i) => {
    assert.ok(items[i].includes(names[code]), `item ${i} should be ${names[code]}: ${items[i]}`);
    assert.ok(items[i].includes(entriesText(counts[code])), `${names[code]}: expected "${entriesText(counts[code])}" in "${items[i]}"`);
  });
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  assert.equal(hrefs.length, Object.keys(C2R).length, 'one link per country');
  for (const h of hrefs) {
    assert.match(h, /^countries\/[a-z0-9-]+\.html$/, h);
    assert.ok(fs.existsSync(path.join(ROOT, h)), `${h} does not exist`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
