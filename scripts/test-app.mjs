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
  // CP3 picker containers (static in index.html; app.js fills them via innerHTML).
  const picker = add('details', { id: 'country-picker', classes: ['country-picker'], ctor: HTMLDetailsElement });
  const summary = add('summary', { id: 'country-picker-summary', classes: ['country-picker-summary'], parent: picker });
  add('p', { id: 'country-cap-hint', classes: ['country-cap-hint'], parent: picker });
  const pickerList = add('div', { id: 'country-picker-list', classes: ['country-picker-list'], parent: picker });
  add('div', { id: 'country-chips', classes: ['country-chips'] });

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
    document, location, history, URLSearchParams, URL, console, Element, HTMLSelectElement, HTMLFormElement, HTMLInputElement, HTMLDetailsElement,
    setTimeout, clearTimeout, localStorage: storage, sessionStorage: storage,
    scrollTo() {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  // Load scripts in index.html order (only our own files; vendor/reveal are not needed).
  const srcs = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^vendor\/|reveal\.js/.test(s));
  for (const s of srcs) vm.runInContext(read(s), ctx, { filename: s });
  const fireRaw = (type, ev) => (listeners[type] || []).forEach(fn => fn(ev));
  const fire = (type, target) => { const ev = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (listeners[type] || []).forEach(fn => fn(ev)); };
  const list = () => document.getElementById('changelog-list').innerHTML;
  return {
    ctx, calls, list, fire, fireRaw, summary, select, form, clear, srcs, picker, pickerList,
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
