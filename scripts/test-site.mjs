// Behaviour tests for shipped site features (regression baseline).
// Usage: node scripts/test-site.mjs   (no dependencies)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadSite } from './load.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const { html: indexHtml, js, CHANGES } = loadSite();

let passed = 0;
function test(name, fn) {
  try { fn(); } catch (e) {
    console.error(`FAIL ${name}\n  ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok ${name}`);
}
const runNode = (...args) => execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const isDay = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v);
const isMonth = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isYear = v => typeof v === 'string' && /^\d{4}$/.test(v);
const lastChanged = e => (e.updated && e.updated > e.added ? e.updated : e.added);
const key = e => `${e.country}/${e.section}`;
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Country page slugs and anchors, discovered from generated files.
const countryFiles = fs.readdirSync(path.join(ROOT, 'countries'));
const pageIds = new Map(countryFiles.filter(f => f.endsWith('.html')).map(f => {
  const h = read(`countries/${f}`);
  return [`countries/${f}`, new Set([...h.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))];
}));
const resolves = href => {
  const [file, anchor] = href.split('#');
  return pageIds.has(file) && (!anchor || pageIds.get(file).has(anchor));
};

test('dates.structured', () => {
  assert.ok(CHANGES.length > 0, 'CHANGES is empty');
  for (const e of CHANGES) {
    const id = key(e);
    assert.ok(e.effective === null || isDay(e.effective) || isMonth(e.effective) || isYear(e.effective), `${id}: bad effective ${e.effective}`);
    assert.ok(isDay(e.added), `${id}: added must be YYYY-MM-DD, got ${e.added}`);
    if ('updated' in e) {
      assert.ok(isDay(e.updated), `${id}: updated must be YYYY-MM-DD, got ${e.updated}`);
      assert.ok(e.updated >= e.added, `${id}: updated ${e.updated} before added ${e.added}`);
    }
  }
});

test('validate.passes', () => { runNode('scripts/validate.mjs'); });
test('build.check', () => { runNode('scripts/build-pages.mjs', '--check'); });

// Minimal strict XML tokenizer: checks tag balance, attribute quoting and entity escaping.
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const checkText = t => {
    assert.ok(!/</.test(t), 'stray < in text');
    for (const m of t.matchAll(/&/g)) assert.match(t.slice(m.index), /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/, `bad entity near "${t.slice(m.index, m.index + 20)}"`);
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const text = src.slice(i, lt < 0 ? src.length : lt);
    checkText(text);
    stack.at(-1).text += text;
    if (lt < 0) break;
    if (src.startsWith('<?', lt)) { i = src.indexOf('?>', lt) + 2; assert.ok(i > 1, 'unterminated PI'); continue; }
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; assert.ok(i > 2, 'unterminated comment'); continue; }
    const gt = src.indexOf('>', lt);
    assert.ok(gt > 0, 'unterminated tag');
    const raw = src.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const open = stack.pop();
      assert.equal(name, open.name, `mismatched </${name}>, expected </${open.name}>`);
    } else {
      const selfClose = raw.endsWith('/');
      const body = selfClose ? raw.slice(0, -1) : raw;
      const m = body.match(/^([A-Za-z_][\w:.-]*)([\s\S]*)$/);
      assert.ok(m, `bad tag <${raw}>`);
      const attrs = {};
      const rest = m[2].replace(/\s+([\w:.-]+)="([^"<]*)"/g, (_, k, v) => { assert.ok(!(k in attrs), `duplicate attr ${k}`); checkText(v); attrs[k] = decode(v); return ''; });
      assert.equal(rest.trim(), '', `bad attributes in <${raw}>`);
      const node = { name: m[1], attrs, children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!selfClose) stack.push(node);
    }
    i = gt + 1;
  }
  assert.equal(stack.length, 1, `unclosed <${stack.at(-1).name}>`);
  assert.equal(root.children.length, 1, 'XML must have exactly one root element');
  return root.children[0];
}
const kid = (n, name) => n.children.find(c => c.name === name);

const expectedFeed = [...CHANGES].sort((a, b) => lastChanged(b).localeCompare(lastChanged(a)) || a.name.localeCompare(b.name) || a.section.localeCompare(b.section)).slice(0, 50);
test('feed.atom', () => {
  const feed = parseXml(read('feed.xml'));
  assert.equal(feed.name, 'feed');
  assert.equal(feed.attrs.xmlns, 'http://www.w3.org/2005/Atom');
  const entries = feed.children.filter(c => c.name === 'entry');
  assert.equal(entries.length, 50, `expected 50 entries, got ${entries.length}`);
  const ids = new Set();
  let prev = null;
  entries.forEach((en, n) => {
    for (const f of ['id', 'title', 'updated', 'link']) assert.ok(kid(en, f), `entry ${n} missing <${f}>`);
    const id = decode(kid(en, 'id').text.trim());
    assert.match(id, /^tag:intelligentpayroll\.eu,2026:[^/\s]+\/[^/\s]+$/, `bad id ${id}`);
    assert.ok(!ids.has(id), `duplicate id ${id}`);
    ids.add(id);
    const upd = kid(en, 'updated').text.trim();
    assert.match(upd, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/, `bad updated ${upd}`);
    if (prev) assert.ok(upd <= prev, `entries not sorted by updated desc at ${id}`);
    prev = upd;
    const href = kid(en, 'link').attrs.href;
    assert.ok(resolves(href.replace('https://www.intelligentpayroll.eu/', '')), `feed link does not resolve: ${href}`);
  });
  // Stable ids: derived purely from country/section, so regeneration yields the same set.
  const want = expectedFeed.map(e => `tag:intelligentpayroll.eu,2026:${e.country}/${e.section}`);
  assert.deepEqual([...ids], want, 'feed ids differ from those derived from CHANGES');
});

test('countries.latest', () => {
  const h = read('countries.html');
  assert.match(h, /<h2 id="latest">Latest changes<\/h2>/);
  const ul = h.match(/<ul class="latest">([\s\S]*?)<\/ul>/);
  assert.ok(ul, 'latest list missing');
  const items = [...ul[1].matchAll(/<li><a href="([^"]+)">/g)].map(m => m[1]);
  assert.equal(items.length, 10, `expected 10 latest items, got ${items.length}`);
  for (const href of items) assert.ok(resolves(href), `latest link does not resolve: ${href}`);
  const want = expectedFeed.slice(0, 10).map(e => `#${e.section}`);
  assert.deepEqual(items.map(h => '#' + h.split('#')[1]), want, 'latest items not newest first');
});

test('fresh.labels', () => {
  const after = js.match(/const FRESH_LABELS_AFTER = '(\d{4}-\d{2}-\d{2})'/)[1];
  const days = Number(js.match(/const FRESH_DAYS = (\d+);/)[1]);
  const verified = js.match(/const LAST_VERIFIED = new Date\('(\d{4}-\d{2}-\d{2})T/)[1];
  const from = new Date(Date.parse(verified + 'T00:00:00Z') - (days - 1) * 864e5).toISOString().slice(0, 10);
  const recent = d => typeof d === 'string' && d > after && d >= from && d <= verified;
  const expected = e => recent(e.added) ? 'New' : recent(e.updated) ? 'Updated' : null;
  // Every entry is rendered once on its country page as <article class="entry" id="section">.
  const articles = new Map();
  for (const f of pageIds.keys()) for (const m of read(f).matchAll(/<article class="entry" id="([^"]+)">([\s\S]*?)<\/article>/g)) articles.set(decode(m[1]), m[2]);
  for (const e of CHANGES) {
    const a = articles.get(e.section);
    assert.ok(a !== undefined, `${key(e)}: no article on any country page`);
    const m = a.match(/<span class="badge fresh">([^<]+)<\/span>/);
    assert.equal(m ? m[1] : null, expected(e), `${key(e)}: wrong fresh badge`);
  }
  for (const f of ['countries.html', 'upcoming.html']) {
    const want = CHANGES.filter(e => expected(e)).length;
    const got = (read(f).match(/badge fresh/g) || []).length;
    assert.ok(got === 0 || got === want, `${f}: ${got} fresh badges, expected 0 or ${want}`);
  }
});

// Runs the real freshnessOf() from app.js and the real rule from build-pages.mjs on boundary days,
// with the constants overridden so the window is open.
test('fresh.boundaries', () => {
  const VERIFIED = '2026-10-01', AFTER = '2026-09-10', DAYS = 14;
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const start = shift(VERIFIED, -(DAYS - 1));
  const days = [start, shift(start, -1), VERIFIED, shift(VERIFIED, 1), AFTER, shift(AFTER, 1), shift(start, 1)];
  const want = d => d > AFTER && d >= start && d <= VERIFIED;

  const fi = js.indexOf('function freshnessOf(');
  const appFn = vm.runInNewContext(`const LAST_VERIFIED = new Date('${VERIFIED}T00:00:00Z'); const FRESH_LABELS_AFTER = '${AFTER}'; const FRESH_DAYS = ${DAYS};
${js.slice(fi, js.indexOf('\n    }', fi) + 6)}; freshnessOf`);

  const bp = read('scripts/build-pages.mjs');
  const line = re => { const m = bp.match(re); assert.ok(m, `build-pages.mjs: cannot find ${re}`); return m[0]; };
  const bpFns = vm.runInNewContext(`const VERIFIED_ISO = '${VERIFIED}'; const FRESH_AFTER = '${AFTER}'; const FRESH_DAYS = ${DAYS};
${line(/^const FRESH_FROM = .*$/m)}
${line(/^const recent = .*$/m)}
${line(/^const freshness = .*$/m)}
freshness`);

  for (const d of days) {
    const exp = want(d) ? 'new' : null;
    assert.equal(appFn({ added: d }), exp, `app.js freshnessOf added ${d}`);
    assert.equal(bpFns({ added: d }), exp, `build-pages freshness added ${d}`);
    const expU = want(d) ? 'updated' : null;
    assert.equal(appFn({ added: '2020-01-01', updated: d }), expU, `app.js freshnessOf updated ${d}`);
    assert.equal(bpFns({ added: '2020-01-01', updated: d }), expU, `build-pages freshness updated ${d}`);
  }
});

const upcoming = CHANGES.filter(e => e.upcoming);
test('upcoming.timeline', () => {
  const h = read('upcoming.html');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const heads = [...h.matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1]);
  assert.ok(heads.length > 0, 'no group headings');
  const keyOf = t => {
    let m;
    if (t === 'Date not set yet') return '~';
    if ((m = t.match(/^Sometime in (\d{4})$/))) return `${m[1]}-~`;
    if ((m = t.match(/^(\w+) (\d{4})$/)) && MONTHS.includes(m[1])) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
    throw new Error(`unexpected heading "${t}"`);
  };
  const keys = heads.map(keyOf);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i], `headings out of order: "${heads[i - 1]}" before "${heads[i]}"`);
  if (upcoming.some(e => e.effective === null)) assert.equal(heads.at(-1), 'Date not set yet');
  const links = [...h.matchAll(/<ul class="timeline">([\s\S]*?)<\/ul>/g)].flatMap(m => [...m[1].matchAll(/<a href="([^"]+)"/g)].map(a => a[1]));
  assert.equal(links.length, upcoming.length, `timeline has ${links.length} items, CHANGES has ${upcoming.length} upcoming`);
  for (const e of upcoming) {
    const n = links.filter(l => l.endsWith(`#${e.section}`)).length;
    assert.equal(n, 1, `${key(e)} appears ${n} times`);
  }
  for (const l of links) assert.ok(resolves(l), `timeline link does not resolve: ${l}`);
});

function checkIcs(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  const s = buf.toString('utf8');
  assert.ok(s.endsWith('\r\n'), `${file}: must end with CRLF`);
  assert.ok(!/[^\r]\n/.test(s) && !/\r(?!\n)/.test(s), `${file}: bare LF or CR found`);
  const lines = s.slice(0, -2).split('\r\n');
  lines.forEach((l, n) => assert.ok(Buffer.byteLength(l) <= 75, `${file}: line ${n + 1} is ${Buffer.byteLength(l)} octets`));
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-1), 'END:VCALENDAR');
  const logical = [];
  for (const l of lines) { if (l.startsWith(' ')) logical[logical.length - 1] += l.slice(1); else logical.push(l); }
  const begins = logical.filter(l => l === 'BEGIN:VEVENT').length;
  assert.equal(begins, logical.filter(l => l === 'END:VEVENT').length, `${file}: VEVENT unbalanced`);
  const events = [];
  let cur = null;
  for (const l of logical) {
    if (l === 'BEGIN:VEVENT') { assert.equal(cur, null, `${file}: nested VEVENT`); cur = {}; }
    else if (l === 'END:VEVENT') { events.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i)] = l.slice(i + 1); }
  }
  const uids = events.map(e => e.UID);
  assert.equal(new Set(uids).size, uids.length, `${file}: duplicate UIDs`);
  return events;
}
const calendarable = upcoming.filter(e => e.effective !== null && e.effective.length >= 7);
const uidOf = e => `${e.country}-${e.section}@intelligentpayroll.eu`;
const checkEvents = (file, events, want) => {
  assert.deepEqual(JSON.stringify(events.map(e => e.UID).sort()), JSON.stringify(want.map(uidOf).sort()), `${file}: events differ from upcoming month/day entries`);
  for (const e of want) {
    const ev = events.find(x => x.UID === uidOf(e));
    const start = (e.effective.length === 7 ? `${e.effective}-01` : e.effective).replace(/-/g, '');
    assert.equal(ev['DTSTART;VALUE=DATE'], start, `${file}: ${key(e)} DTSTART mismatch`);
  }
};

test('ics.format', () => {
  checkEvents('calendar.ics', checkIcs('calendar.ics'), calendarable);
  const icsFiles = countryFiles.filter(f => f.endsWith('.ics'));
  assert.ok(icsFiles.length > 0, 'no country .ics files');
  const seen = [];
  for (const f of icsFiles) {
    const events = checkIcs(`countries/${f}`);
    assert.ok(events.length > 0, `countries/${f}: no events`);
    const codes = new Set(events.map(e => e.UID.split('-')[0]));
    assert.equal(codes.size, 1, `countries/${f}: mixes countries`);
    const code = [...codes][0];
    checkEvents(`countries/${f}`, events, calendarable.filter(e => e.country === code));
    seen.push(code);
  }
  assert.deepEqual(seen.sort(), [...new Set(calendarable.map(e => e.country))].sort(), 'country .ics files do not cover exactly the countries with calendar events');
});

test('ics.webcal', () => {
  assert.ok(read('upcoming.html').includes('href="webcal://www.intelligentpayroll.eu/calendar.ics"'), 'upcoming.html missing webcal link to calendar.ics');
  for (const f of countryFiles.filter(f => f.endsWith('.ics'))) {
    const page = `countries/${f.replace(/\.ics$/, '.html')}`;
    assert.ok(pageIds.has(page), `${page} missing for ${f}`);
    assert.ok(read(page).includes(`webcal://www.intelligentpayroll.eu/countries/${f}`), `${page} missing webcal link to its own .ics`);
  }
});

test('impact.filter', () => {
  for (const e of CHANGES) assert.ok(['high', 'medium', 'low'].includes(e.impact), `${key(e)}: bad impact ${e.impact}`);
  assert.match(indexHtml, /data-filter="high-impact"/, 'index.html missing high-impact filter button');
  // The filter lives in filters.js (applyFilters); run the real implementation.
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'filters.js'), 'utf8'), sandbox);
  const got = sandbox.module.exports.applyFilters(CHANGES, { filter: 'high-impact', countries: [] }).map(key);
  assert.equal(JSON.stringify(got), JSON.stringify(CHANGES.filter(e => e.impact === 'high').map(key)));
  assert.ok(got.length > 0, 'no high-impact entries');
  assert.match(js, /PayrollFilters\.applyFilters\(/, 'app.js does not render through PayrollFilters.applyFilters');
});

test('worker.tests', () => {
  const out = runNode('scripts/test-worker.mjs');
  const m = out.match(/(\d+) worker tests passed/);
  assert.ok(m && Number(m[1]) >= 18, `expected at least 18 worker tests to pass: ${out.slice(-200)}`);
});

// P2-1: user-facing category label is "Systems & e-filing"; data value 'infrastructure' (ids, URLs) unchanged.
test('p2_1.no_infrastructure_label', () => {
  const visibleText = h => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ');
  const files = ['index.html', 'countries.html', 'upcoming.html', '404.html', ...countryFiles.filter(f => f.endsWith('.html')).map(f => `countries/${f}`)];
  const bad = files.filter(f => /\bInfrastructure\b/.test(visibleText(read(f))));
  for (const f of ['feed.xml', 'calendar.ics', ...countryFiles.filter(f => f.endsWith('.ics')).map(f => `countries/${f}`)])
    if (/\bInfrastructure\b/.test(read(f))) bad.push(f);
  assert.deepEqual(bad, [], 'visible "Infrastructure" label in: ' + bad.join(', '));
  assert.match(indexHtml, /data-filter="infrastructure"[^>]*>\s*Systems &amp; e-filing\s*</, 'index.html category button reads "Systems & e-filing"');
  assert.ok(!/data-filter="upcoming"/.test(indexHtml), 'Upcoming moved out of the category buttons');
  assert.match(indexHtml, /data-filter="high-impact"/, 'high impact stays a category button');
});

console.log(`${passed} site tests passed.`);
