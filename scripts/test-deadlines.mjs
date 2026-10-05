// P2-12 behaviour tests for deadlines.js (the progressive-enhancement "next 12 months" list on deadlines.html).
// Run: node scripts/test-deadlines.mjs
// deadlines.js is a browser script, so it runs in node:vm against a tiny fake DOM, after filters.js (as on the page).
//
// CONTRACT (deadlines.js)
//  Page markup it relies on: <div id="deadlines-upcoming"> (container, holds a <noscript> fallback in the static page). filters.js is loaded first
//  (window.PayrollFilters); deadlines.js is a classic external script (no module, no inline).
//  Data: ONE request, fetch('deadlines.json') (first argument exactly that string; same origin; no other network use, no XHR/beacon/WebSocket,
//  no localStorage/sessionStorage/cookies). Body = {countries: {<code>: {name, flag, slug}}, deadlines: [<deadline objects as in data/deadlines.json>]}.
//  If the container is missing it does nothing (no request). Failures (network error, !response.ok, body without a deadlines array / countries object)
//  never throw out of the script: the container gets <p class="deadline-error">...</p> (the static tables stay the fallback; text mentions "tables below").
//  Selection: PayrollFilters.readSelection(new URLSearchParams(location.search), map) where map = {<code>: true} for the countries present in the data
//  (so a valid site code with no deadlines, unknown codes and markup are dropped). ?countries=a,b (plus legacy ?country=) -> selection, order kept.
//  TODAY = the browser's LOCAL calendar date (getFullYear/getMonth/getDate) as ISO. List = PayrollFilters.upcomingList(deadlines, today, 12, selection).
//  Rendering = ONE string assigned to container.innerHTML (the whole widget is re-rendered on every change); every data value is HTML-escaped
//  (& < > " '); a sourceUrl that is not https:// is not turned into a link. Markup:
//    <div class="deadline-filter" role="group" aria-label="Filter by country">
//      <button type="button" class="deadline-chip" data-country="uk" aria-pressed="false|true">FLAG Name</button> ...   (one per country in the data, in the order of data.countries)
//      <button type="button" class="deadline-chip-clear" data-action="clear-countries">Show all countries</button>      (ONLY while the selection is non-empty)
//    </div>
//    then, per month with items (ascending), <h3 class="deadline-month">October 2026</h3><ul class="deadline-items"> and per item
//    <li class="deadline-item" data-country="uk" data-id="uk-paye-payment"><time datetime="2026-10-22">22 October 2026</time> FLAG Name  title  ruleText  <a href="url" rel="noopener">sourceLabel</a></li>
//    No items -> <p class="deadline-empty">...</p> instead of the months.
//  Clicking (event delegation on the container or the document; target.closest(...) is what is looked at) a chip toggles the code in the selection
//  (appended at the end when added); the clear button empties it. Every change re-renders and calls history.replaceState(null|state, '', url) where
//  url = location.pathname + ('?countries=' + serializeCountries(selection) when non-empty) + location.hash. pushState is never used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

// ---------- fake DOM ----------
class Element {
  constructor(tag = 'div', { id = '', classes = [], dataset = {}, parent = null, attrs = {} } = {}) {
    this.tagName = tag.toUpperCase(); this.id = id; this._cls = new Set(classes); this.dataset = { ...dataset }; this.parentElement = parent; this._attrs = { ...attrs };
    this.innerHTML = ''; this.textContent = ''; this.style = {}; this.hidden = false;
    this.classList = { add: (...c) => c.forEach(x => this._cls.add(x)), remove: (...c) => c.forEach(x => this._cls.delete(x)), contains: c => this._cls.has(c), toggle: (c, f) => { const on = f === undefined ? !this._cls.has(c) : f; on ? this._cls.add(c) : this._cls.delete(c); return on; } };
  }
  matches(sel) { return sel.split(',').some(one => matchOne(this, one.trim())); }
  closest(sel) { for (let e = this; e; e = e.parentElement) if (e.matches(sel)) return e; return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(t, fn) { ((this._ls ||= {})[t] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute(n, v) { this._attrs[n] = String(v); }
  getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; }
  hasAttribute(n) { return n in this._attrs; }
  focus() {}
  appendChild(c) { c.parentElement = this; return c; }
}
const camel = a => a.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function matchOne(el, sel) {
  if (/^#[\w-]+$/.test(sel)) return el.id === sel.slice(1);
  const m = sel.match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!el._cls.has(c.slice(1))) return false;
  for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
    const [, name, val] = a.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/) || [];
    if (!name) return false;
    const want = val ?? undefined;
    if (name.startsWith('data-')) { const v = el.dataset[camel(name)]; if (v === undefined || (want !== undefined && v !== want)) return false; }
    else { const v = el.getAttribute(name); if (v === null || (want !== undefined && v !== want)) return false; }
  }
  return true;
}

const REAL_DATE = Date;
// A browser clock frozen at a LOCAL date-time (so the "local date -> ISO" rule is observable).
const frozenDate = (y, mo, d, h = 12, mi = 0) => {
  const t = new REAL_DATE(y, mo - 1, d, h, mi, 0).getTime();
  return class FrozenDate extends REAL_DATE {
    constructor(...a) { if (a.length) super(...a); else super(t); }
    static now() { return t; }
  };
};

// opts: search, hash, body (object | string JSON), fail ('reject' | 'status' | 'throw'), today [y,m,d,h,mi], noContainer
function makePage(opts = {}) {
  const { search = '', hash = '', body, fail, today = [2026, 10, 5, 12, 0], noContainer = false } = opts;
  const container = new Element('div', { id: 'deadlines-upcoming' });
  const docListeners = {}, replaceCalls = [], fetchCalls = [];
  const location = { search, pathname: '/deadlines.html', hash, href: 'https://example.test/deadlines.html' + search + hash, origin: 'https://example.test' };
  const history = {
    replaceState: (st, title, url) => { replaceCalls.push(String(url)); const u = new URL(String(url), 'https://example.test/'); location.search = u.search; location.pathname = u.pathname; location.hash = u.hash; },
    pushState: () => { throw new Error('pushState must not be used (replaceState only)'); },
  };
  const document = {
    readyState: 'complete',
    getElementById: id => (!noContainer && id === 'deadlines-upcoming' ? container : null),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn),
    createElement: () => { throw new Error('deadlines.js must render with one container.innerHTML string (test harness contract)'); },
    body: new Element('body'), documentElement: new Element('html'),
    get cookie() { throw new Error('document.cookie must not be used'); }, set cookie(v) { throw new Error('document.cookie must not be used'); },
  };
  const forbidden = name => () => { throw new Error(name + ' must not be used'); };
  const storage = { getItem: forbidden('localStorage'), setItem: forbidden('localStorage'), removeItem: forbidden('localStorage') };
  const json = typeof body === 'string' ? JSON.parse(body) : body;
  const fetchStub = (...args) => {
    fetchCalls.push(args);
    if (fail === 'throw') throw new Error('fetch threw synchronously');
    if (fail === 'reject') return Promise.reject(new Error('network down'));
    if (fail === 'status') return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' });
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(json)), text: async () => JSON.stringify(json) });
  };
  const winListeners = {};
  const ctx = {
    document, location, history, URLSearchParams, URL, console, Element, Intl, JSON, Date: frozenDate(...today),
    setTimeout, clearTimeout, localStorage: storage, sessionStorage: storage,
    fetch: fetchStub, XMLHttpRequest: forbidden('XMLHttpRequest'), WebSocket: forbidden('WebSocket'), EventSource: forbidden('EventSource'),
    navigator: { userAgent: 'node', sendBeacon: forbidden('navigator.sendBeacon') },
    addEventListener: (t, fn) => (winListeners[t] ||= []).push(fn), innerWidth: 1280, matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  const errors = [];
  try { vm.runInContext(read('filters.js'), ctx, { filename: 'filters.js' }); vm.runInContext(read('deadlines.js'), ctx, { filename: 'deadlines.js' }); } catch (e) { errors.push(e); }
  const html = () => container.innerHTML;
  const dispatch = target => {
    const ev = { type: 'click', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    ((container._ls || {}).click || []).forEach(fn => fn(ev));
    (docListeners.click || []).forEach(fn => fn(ev));
    return ev;
  };
  const buttons = () => [...html().matchAll(/<button\b[^>]*>/g)].map(m => {
    const tag = m[0], attr = n => (tag.match(new RegExp('\\s' + n + '="([^"]*)"')) || [])[1];
    const dataset = {}; for (const a of tag.matchAll(/\sdata-([\w-]+)="([^"]*)"/g)) dataset[camel(a[1])] = decodeEnt(a[2]);
    return { tag, dataset, classes: (attr('class') || '').split(/\s+/).filter(Boolean), pressed: attr('aria-pressed'), type: attr('type') };
  });
  const click = b => dispatch(new Element('button', { classes: b.classes, dataset: b.dataset, parent: container, attrs: { type: 'button' } }));
  const chips = () => buttons().filter(b => b.dataset.country !== undefined);
  const clickChip = code => { const b = chips().find(x => x.dataset.country === code); assert.ok(b, `no chip for ${code} in: ${html().slice(0, 400)}`); return click(b); };
  const clear = () => buttons().find(b => b.dataset.action === 'clear-countries');
  const items = () => [...html().matchAll(/<li class="deadline-item"([^>]*)>([\s\S]*?)<\/li>/g)].map(m => ({
    attrs: m[1], body: m[2], country: decodeEnt((m[1].match(/data-country="([^"]*)"/) || [])[1] || ''), id: decodeEnt((m[1].match(/data-id="([^"]*)"/) || [])[1] || ''),
    date: (m[2].match(/<time datetime="([^"]*)">([^<]*)<\/time>/) || [])[1], dateText: (m[2].match(/<time datetime="([^"]*)">([^<]*)<\/time>/) || [])[2] }));
  return { ctx, container, html, click, chips, clickChip, clear, buttons, items, replaceCalls, fetchCalls, errors, dispatch, location };
}

// ---------- helpers ----------
const decodeEnt = s => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const text = h => decodeEnt(h.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
// 'Sat 31 Oct 2026' (R2: weekday + short month, built without Intl so it cannot vary with the ICU version).
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = iso => `${WD[new REAL_DATE(iso + 'T00:00:00Z').getUTCDay()]} ${+iso.slice(8, 10)} ${MON3[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const monthName = iso => new REAL_DATE(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dim = (y, m) => new REAL_DATE(Date.UTC(y, m, 0)).getUTCDate();
const addMonths = (iso, n) => { let y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = (m % 12) + 1; return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(+iso.slice(8, 10), dim(y, m))).padStart(2, '0')}`; };
const dueOn = (d, s) => {
  const y = +s.slice(0, 4), m = +s.slice(5, 7), dd = +s.slice(8, 10), day = d.rule.day === 'last' ? dim(y, m) : d.rule.day;
  if (dd !== day) return false;
  return d.frequency === 'monthly' || (d.frequency === 'quarterly' ? d.rule.months.includes(m) : m === d.rule.month);
};
// Independent oracle: every (date, deadline) due in [from, from + 12 months), optionally for some countries.
const expected = (deadlines, from, countries = []) => {
  const end = addMonths(from, 12), out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); new REAL_DATE(t).toISOString().slice(0, 10) < end; t += 864e5) {
    const s = new REAL_DATE(t).toISOString().slice(0, 10);
    for (const d of deadlines) if ((!countries.length || countries.includes(d.country)) && dueOn(d, s)) out.push(`${s} ${d.country}/${d.id}`);
  }
  return out.sort();
};
const shown = p => p.items().map(i => `${i.date} ${i.country}/${i.id}`);

const realJson = () => { assert.ok(fs.existsSync(path.join(ROOT, 'deadlines.json')), 'deadlines.json not generated by build-pages.mjs'); return JSON.parse(read('deadlines.json')); };

const hostile = '<img src=x onerror=alert(1)>';
const fixture = () => ({
  countries: { uk: { name: 'United Kingdom', flag: '🇬🇧', slug: 'united-kingdom' }, spain: { name: 'Spain', flag: '🇪🇸', slug: 'spain' } },
  deadlines: [
    { id: 'uk-a', country: 'uk', title: 'UK monthly payment', kind: 'payment', frequency: 'monthly', rule: { day: 22, monthOffset: 1 }, ruleText: 'Pay by the 22nd.', sourceUrl: 'https://www.gov.uk/x?a=1&b=2', sourceLabel: 'Source: GOV.UK - Paying', checked: '2026-10-01' },
    { id: 'es-a', country: 'spain', title: 'Spain annual return', kind: 'filing', frequency: 'annual', rule: { day: 31, monthOffset: 0, month: 1 }, ruleText: 'File by 31 January.', sourceUrl: 'https://www.boe.es/y', sourceLabel: 'Source: BOE - Modelo 190', checked: '2026-10-01' },
  ],
});

// ---------- tests ----------
let pass = 0, fail = 0;
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(e));
async function test(name, fn) {
  try { await fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 4).join('\n     ')}`); }
}

await test('deadlines.js_exists_and_is_a_plain_classic_script', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'deadlines.js')), 'deadlines.js missing');
  const src = read('deadlines.js').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/^\s*(import|export)\s/m.test(src), 'classic script: no import/export');
  assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB|XMLHttpRequest|sendBeacon|WebSocket|eval\s*\(|new Function|document\.write/.test(src), 'no storage, no other network APIs, no eval');
  assert.ok(!/\son[a-z]+\s*=\s*["']|\sstyle\s*=\s*["']|javascript:/i.test(src), 'no inline handlers/styles/javascript: URLs in rendered markup');
  assert.ok(/PayrollFilters/.test(src) && /readSelection/.test(src) && /serializeCountries/.test(src) && /upcomingList/.test(src), 'reuses PayrollFilters.readSelection, serializeCountries and upcomingList');
  assert.ok(/history\.replaceState/.test(src) && !/pushState/.test(src), 'URL via history.replaceState only');
});

await test('loads_deadlines_json_exactly_once_and_nothing_else', async () => {
  const p = makePage({ body: realJson() }); await settle();
  assert.deepEqual(p.errors.map(String), [], 'script load threw');
  assert.equal(p.fetchCalls.length, 1, 'exactly one request');
  assert.equal(p.fetchCalls[0][0], 'deadlines.json', 'first fetch argument is exactly "deadlines.json"');
  p.clickChip('uk'); await settle(); p.clickChip('spain'); await settle();
  assert.equal(p.fetchCalls.length, 1, 'toggling chips does not fetch again');
});

await test('default_shows_every_country_for_the_next_12_months_from_today', async () => {
  const j = realJson(), p = makePage({ body: j }); await settle();
  assert.ok(p.items().length > 0, 'no items rendered: ' + p.html().slice(0, 300));
  assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, '2026-10-05'), 'items = every deadline due in [2026-10-05, 2027-10-05)');
  const codes = Object.keys(j.countries);
  assert.deepEqual(p.chips().map(c => c.dataset.country), codes, 'one chip per country in data.countries, in that order');
  assert.ok(p.chips().every(c => c.pressed === 'false' && c.type === 'button' && c.classes.includes('deadline-chip')), 'chips are type=button, aria-pressed="false" with nothing selected');
  assert.equal(p.clear(), undefined, 'no clear button while the selection is empty');
  assert.match(p.html(), /<div class="deadline-filter" role="group" aria-label="Filter by country">/);
  assert.equal(p.replaceCalls.length, 0, 'loading alone does not rewrite the URL');
});

await test('months_are_headed_and_items_sorted_by_date_country_id', async () => {
  const j = realJson(), p = makePage({ body: j }); await settle();
  const parts = p.html().split('<h3 class="deadline-month">').slice(1);
  assert.ok(parts.length >= 12 && parts.length <= 13, `months with items: ${parts.length}`);
  let last = '', heads = [];
  for (const part of parts) {
    const head = text(part.slice(0, part.indexOf('</h3>'))); heads.push(head);
    assert.match(part, /^[^<]*<\/h3>\s*<ul class="deadline-items">/, 'heading is followed by <ul class="deadline-items">');
    for (const m of part.matchAll(/<time datetime="(\d{4}-\d{2}-\d{2})">([^<]*)<\/time>/g)) {
      assert.equal(monthName(m[1]), head, `${m[1]} sits under "${head}"`);
      assert.equal(m[2], shortDay(m[1]), 'short weekday date text, e.g. Sat 31 Oct 2026');
      assert.ok(m[1] >= last, 'dates ascend'); last = m[1];
    }
  }
  assert.equal(new Set(heads).size, heads.length, 'each month once');
  const order = p.items().map(i => `${i.date} ${i.country} ${i.id}`);
  assert.deepEqual(order, [...order].sort(), 'tie-break by country code then id');
});

await test('item_shows_date_flag_country_title_rule_and_source_link_escaped', async () => {
  const j = realJson(), p = makePage({ body: j }); await settle();
  for (const it of p.items()) {
    const d = j.deadlines.find(x => x.id === it.id && x.country === it.country), c = j.countries[it.country];
    assert.ok(d, `item ${it.id} is a deadline of ${it.country}`);
    const t = text(it.body);
    for (const want of [c.flag, c.name, d.title, d.ruleText, d.sourceLabel]) assert.ok(t.includes(want), `${it.id}: missing "${want}" in "${t.slice(0, 200)}"`);
    assert.equal(it.dateText, shortDay(it.date));
    assert.ok(it.body.includes(`href="${esc(d.sourceUrl)}"`), `${it.id}: source link href`);
    assert.match(it.body, /<a [^>]*rel="noopener"/);
  }
  const it = p.items()[0];
  assert.ok(p.items().some(i => i.id === 'fr-dsn-50plus-same-month' && i.date === '2026-10-05'), 'a deadline due today is listed (today inclusive)');
  assert.ok(it);
});

await test('selection_from_url_filters_the_list', async () => {
  const j = realJson(), p = makePage({ search: '?countries=uk,spain', body: j }); await settle();
  assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, '2026-10-05', ['uk', 'spain']));
  assert.ok(shown(p).every(s => /^\S+ (uk|spain)\//.test(s)), 'only uk and spain');
  assert.ok(shown(p).some(s => / uk\//.test(s)) && shown(p).some(s => / spain\//.test(s)));
  const pressed = Object.fromEntries(p.chips().map(c => [c.dataset.country, c.pressed]));
  assert.equal(pressed.uk, 'true'); assert.equal(pressed.spain, 'true');
  for (const [k, v] of Object.entries(pressed)) if (k !== 'uk' && k !== 'spain') assert.equal(v, 'false', k);
  assert.ok(p.clear(), 'clear button shown while a selection exists');
});

await test('legacy_country_param_is_merged_unknown_and_absent_codes_are_ignored', async () => {
  const j = realJson();
  let p = makePage({ search: '?country=italy', body: j }); await settle();
  assert.ok(shown(p).length > 0 && shown(p).every(s => / italy\//.test(s)), '?country=italy');
  p = makePage({ search: '?countries=uk&country=italy', body: j }); await settle();
  assert.deepEqual([...new Set(shown(p).map(s => s.split(' ')[1].split('/')[0]))].sort(), ['italy', 'uk']);
  for (const q of ['?countries=atlantis', '?countries=poland', `?countries=${encodeURIComponent(hostile)},uk,UK`, '?countries=', '?countries=__proto__,constructor']) {
    p = makePage({ search: q, body: j }); await settle();
    const codes = new Set(shown(p).map(s => s.split(' ')[1].split('/')[0]));
    if (q.includes(',uk,')) assert.deepEqual([...codes], ['uk'], q + ': hostile dropped, uk kept once');
    else assert.deepEqual([...codes].sort(), Object.keys(j.countries).sort(), `${q}: nothing valid selected = all countries`);
    assert.ok(!p.html().includes('<img'), q + ': nothing from the URL is reflected as markup');
  }
});

await test('toggling_chips_updates_list_url_and_pressed_state', async () => {
  const j = realJson(), p = makePage({ body: j, hash: '#upcoming' }); await settle();
  const all = shown(p);
  p.clickChip('uk'); await settle();
  assert.equal(new URL(p.replaceCalls.at(-1), 'https://example.test/').searchParams.get('countries'), 'uk');
  assert.ok(p.replaceCalls.at(-1).startsWith('/deadlines.html?countries=uk') && p.replaceCalls.at(-1).endsWith('#upcoming'), 'path, query and hash: ' + p.replaceCalls.at(-1));
  assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, '2026-10-05', ['uk']));
  assert.equal(p.chips().find(c => c.dataset.country === 'uk').pressed, 'true');
  p.clickChip('spain'); await settle();
  assert.equal(new URL(p.replaceCalls.at(-1), 'https://example.test/').searchParams.get('countries'), 'uk,spain', 'added at the end');
  assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, '2026-10-05', ['uk', 'spain']));
  p.clickChip('uk'); await settle();
  assert.equal(new URL(p.replaceCalls.at(-1), 'https://example.test/').searchParams.get('countries'), 'spain');
  assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, '2026-10-05', ['spain']));
  p.clickChip('spain'); await settle();
  const last = new URL(p.replaceCalls.at(-1), 'https://example.test/');
  assert.equal(last.searchParams.get('countries'), null, 'empty selection removes the parameter');
  assert.equal(last.search, '', 'and the whole query string');
  assert.equal(last.hash, '#upcoming');
  assert.deepEqual(shown(p), all, 'empty selection = all countries again');
  assert.equal(p.clear(), undefined);
  assert.equal(p.fetchCalls.length, 1);
});

await test('clear_button_empties_the_selection', async () => {
  const j = realJson(), p = makePage({ search: '?countries=uk,spain', body: j }); await settle();
  p.click(p.clear()); await settle();
  assert.equal(new URL(p.replaceCalls.at(-1), 'https://example.test/').search, '');
  assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, '2026-10-05'));
  assert.ok(p.chips().every(c => c.pressed === 'false'));
});

await test('today_is_the_local_date_and_the_window_is_12_months_end_exclusive', async () => {
  const j = realJson();
  for (const today of [[2026, 10, 5, 0, 30], [2026, 10, 5, 23, 30], [2027, 2, 28, 12, 0], [2028, 2, 29, 12, 0], [2026, 12, 31, 23, 59]]) {
    const iso = `${today[0]}-${String(today[1]).padStart(2, '0')}-${String(today[2]).padStart(2, '0')}`;
    const p = makePage({ body: j, today }); await settle();
    assert.deepEqual(shown(p).slice().sort(), expected(j.deadlines, iso), `today ${iso} ${today[3]}:${today[4]}`);
    const end = addMonths(iso, 12);
    assert.ok(p.items().every(i => i.date >= iso && i.date < end), `all dates within [${iso}, ${end})`);
  }
});

await test('hostile_strings_in_the_json_are_escaped', async () => {
  const f = fixture(), H = hostile;
  f.countries = { uk: { name: H, flag: '<b>F</b>', slug: 'x"><script>alert(1)</script>' }, [`"><img src=x onerror=alert(2)>`]: { name: 'Evil', flag: '<i>', slug: 'evil' } };
  f.deadlines[0] = { ...f.deadlines[0], title: `T ${H} "q" 's' & more`, ruleText: `R ${H}`, appliesTo: `A ${H}`, sourceLabel: `Source: ${H} - "L"`, sourceUrl: 'https://example.org/a"onmouseover="x&y=1' };
  f.deadlines[1] = { ...f.deadlines[1], id: 'js-url', title: 'No link please', sourceUrl: 'javascript:alert(1)' };
  f.deadlines.push({ ...f.deadlines[0], id: 'evil-a', country: `"><img src=x onerror=alert(2)>`, title: `E ${H}` });
  const p = makePage({ body: f }); await settle();
  assert.deepEqual(p.errors.map(String), []);
  const h = p.html();
  assert.ok(p.items().length >= 1, 'something rendered: ' + h.slice(0, 200));
  assert.ok(!/<(img|b|i|script)\b/i.test(h.replace(/<\/?(button|div|ul|li|h3|time|a|span|strong|p)\b[^>]*>/g, '')), 'no raw tag from data: ' + h.slice(0, 600));
  assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(h.replace(/="[^"]*"/g, '=""')), 'no event-handler attribute inside any tag (attribute VALUES may contain the escaped words)');
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'hostile text shown as escaped text');
  assert.ok(!/href="javascript:/i.test(h), 'non-https source is never a link');
  assert.ok(!/"onmouseover="/.test(h), 'attribute breakout via quotes is escaped'); assert.ok(h.includes('href="https://example.org/a&quot;onmouseover=&quot;x&amp;y=1"'), 'href attribute-escaped');
  assert.ok(!/\sstyle=/.test(h), 'no style attributes');
  // The hostile country code never lands raw in a data-country attribute.
  for (const m of h.matchAll(/data-country="([^"]*)"/g)) assert.ok(!/[<>]/.test(m[1]), 'data-country value has no markup: ' + m[1]);
  // Clicking a chip whose code looks like markup must not throw or reflect it.
  const evilChip = p.chips().find(c => c.dataset.country.includes('img'));
  if (evilChip) { p.click(evilChip); await settle(); assert.ok(!p.html().includes('<img'), 'still no raw tag after a click'); }
});

await test('fetch_failures_show_an_error_message_and_never_throw', async () => {
  for (const [name, o] of Object.entries({ reject: { fail: 'reject' }, status404: { fail: 'status' }, throws: { fail: 'throw' }, empty_object: { body: {} }, deadlines_not_array: { body: { countries: {}, deadlines: 'x' } }, countries_missing: { body: { deadlines: [] } }, null_body: { body: null }, array_body: { body: [] } })) {
    const p = makePage({ body: {}, ...o }); await settle();
    assert.deepEqual(p.errors.map(String), [], `${name}: script load must not throw`);
    assert.match(p.html(), /<p class="deadline-error">[^<]*tables below[^<]*<\/p>/, `${name}: error paragraph mentioning the tables below: ${p.html().slice(0, 200)}`);
    assert.equal(p.items().length, 0); assert.equal(p.fetchCalls.length, 1, `${name}: no retry loop`);
  }
  assert.deepEqual(unhandled.map(String), [], 'no unhandled promise rejection');
});

await test('no_deadlines_shows_an_empty_message', async () => {
  const p = makePage({ body: { countries: {}, deadlines: [] } }); await settle();
  assert.match(p.html(), /<p class="deadline-empty">/); assert.equal(p.items().length, 0); assert.equal(p.chips().length, 0);
});

await test('fixture_data_drives_chips_items_and_text', async () => {
  const p = makePage({ body: fixture() }); await settle();
  assert.deepEqual(p.chips().map(c => c.dataset.country), ['uk', 'spain'], 'chips follow data.countries');
  assert.ok(text(p.html()).includes('🇬🇧 United Kingdom'));
  const got = shown(p).slice().sort();
  assert.deepEqual(got, expected(fixture().deadlines, '2026-10-05'));
  assert.ok(got.includes('2026-10-22 uk/uk-a') && got.includes('2027-01-31 spain/es-a'));
  assert.ok(p.items().find(i => i.id === 'uk-a').body.includes('href="https://www.gov.uk/x?a=1&amp;b=2"'), 'ampersand in href escaped');
});

await test('weekday_is_shown_in_the_date_and_cannot_shift_with_the_time_zone', async () => {
  const f = fixture(); f.deadlines[0].rule = { day: 'last', monthOffset: 0 }; // 31 Oct 2026 is a Saturday
  for (const today of [[2026, 10, 5, 0, 30], [2026, 10, 5, 23, 59]]) {
    const p = makePage({ body: f, today }); await settle();
    const it = p.items().find(i => i.id === 'uk-a' && i.date === '2026-10-31');
    assert.ok(it, 'uk-a due 2026-10-31'); assert.equal(it.dateText, 'Sat 31 Oct 2026');
    assert.equal(p.items().find(i => i.id === 'uk-a' && i.date === '2026-11-30').dateText, 'Mon 30 Nov 2026');
  }
});

await test('each_item_shows_its_non_working_day_note_or_check_the_source', async () => {
  const f = fixture(); f.deadlines[0].weekendNote = `Moves to the next working day. ${hostile}`;
  const p = makePage({ body: f }); await settle();
  const a = p.items().find(i => i.id === 'uk-a'), e = p.items().find(i => i.id === 'es-a');
  assert.ok(a.body.includes('<span class="deadline-weekend">Non-working day: Moves to the next working day. &lt;img src=x onerror=alert(1)&gt;</span>'), a.body);
  assert.ok(e.body.includes('<span class="deadline-weekend">Non-working day: check the source</span>'), e.body);
  const j = realJson(), q = makePage({ body: j }); await settle();
  const fr = q.items().find(i => i.id === 'fr-dsn-under50'), uk = q.items().find(i => i.id === 'uk-paye-payment');
  assert.ok(fr && uk && text(fr.body).includes('Non-working day: ' + j.deadlines.find(d => d.id === 'fr-dsn-under50').weekendNote), 'real note shown');
  assert.ok(text(uk.body).endsWith('Non-working day: check the source'));
});

await test('status_line_counts_the_listed_deadlines_and_names_the_countries', async () => {
  const f = fixture(), p = makePage({ body: f }); await settle();
  const st = () => { const m = p.html().match(/<p class="deadline-status" role="status">([^<]*)<[/]p>/); return m && m[1]; };
  assert.equal(st(), `${p.items().length} deadlines in the next 12 months for all countries`);
  assert.ok(p.html().indexOf('deadline-status') < p.html().indexOf('<h3 class="deadline-month">'), 'above the list');
  p.clickChip('spain'); await settle();
  assert.equal(st(), '1 deadline in the next 12 months for Spain');
  p.clickChip('uk'); await settle();
  assert.equal(st(), `${p.items().length} deadlines in the next 12 months for Spain, United Kingdom`);
  const g = fixture(); g.countries.uk.name = hostile; const q = makePage({ body: g, search: '?countries=uk' }); await settle();
  assert.ok(q.html().includes('for &lt;img src=x onerror=alert(1)&gt;</p>'), 'escaped in the status line');
});

await test('missing_container_does_nothing', async () => {
  const p = makePage({ body: realJson(), noContainer: true }); await settle();
  assert.deepEqual(p.errors.map(String), []); assert.equal(p.fetchCalls.length, 0, 'no request without the placeholder');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
