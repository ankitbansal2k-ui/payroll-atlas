// Behaviour tests for shipped site features (regression baseline).
// Usage: node scripts/test-site.mjs   (no dependencies)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import os from 'node:os';
import { loadSite } from './load.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const { html: indexHtml, js, CHANGES } = loadSite();
// P2-12: temp copies of the site that run validate.mjs/build-pages.mjs must also carry the deadlines data and script (validate.mjs reads both).
const DL_FILES = ['data/deadlines.json', 'deadlines.js'].filter(f => fs.existsSync(path.join(ROOT, f)));

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
// P4-1: the only inline <script> allowed on any page is JSON-LD data (type="application/ld+json"); every other inline script stays forbidden.
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)(?!\stype="application\/ld\+json">)/i;
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
  // P2-4: infrastructure button removed entirely (see p2_4.* tests).
  assert.ok(!/data-filter="upcoming"/.test(indexHtml), 'Upcoming moved out of the category buttons');
  assert.match(indexHtml, /data-filter="high-impact"/, 'high impact stays a category button');
});

// P2-4: five non-payroll entries dropped; infrastructure category removed.
const DROPPED = ['cn-vat', 'do-reporting', 'qa-reporting-upcoming', 'bh-tax-upcoming', 'kw-infrastructure'];
test('p2_4.entries_removed', () => {
  // CHANGES comes from another vm realm: spread into a local array before strict comparison.
  assert.deepEqual([...CHANGES.filter(e => DROPPED.includes(e.section)).map(key)], [], 'dropped sections still in CHANGES');
  assert.equal(CHANGES.length, 182);
  assert.ok(CHANGES.every(e => ['payroll', 'reporting'].includes(e.category)), 'category must be payroll|reporting');
});
test('p2_4.countries_keep_entries', () => {
  const { countryToRegion } = loadSite();
  const missing = Object.keys(countryToRegion).filter(c => !CHANGES.some(e => e.country === c));
  assert.deepEqual(missing, [], 'countries without entries');
  assert.equal(Object.keys(countryToRegion).length, 75);
});
test('p2_4.generated_clean', () => {
  const files = ['feed.xml', 'calendar.ics', 'upcoming.html', 'countries.html', 'sitemap.xml',
    ...countryFiles.filter(f => f.endsWith('.html') || f.endsWith('.ics')).map(f => `countries/${f}`)];
  const hits = [];
  for (const f of files) { const t = read(f); for (const s of DROPPED) if (new RegExp('[#"-]' + s + '\\b').test(t)) hits.push(`${f}: ${s}`); }
  assert.deepEqual(hits, [], 'dropped sections in generated files');
  for (const f of ['index.html', 'README.md']) assert.ok(!/Systems (&amp;|&) e-filing/.test(read(f)), f);
  assert.ok(!/\binfrastructure\b/.test(read('README.md')), 'README must not list infrastructure');
});
test('p2_4.validate_rejects_infrastructure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p24-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', ...DL_FILES]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(tmp, '.well-known'), { recursive: true });
    const run = () => { try { execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' }); return ''; } catch (e) { return String(e.stdout) + String(e.stderr); } };
    const base = read('app.js');
    fs.writeFileSync(path.join(tmp, 'app.js'), base);
    assert.ok(!/bad category/.test(run()), 'real app.js flagged');
    const m = base.match(/category:'(payroll|reporting)'/);
    fs.writeFileSync(path.join(tmp, 'app.js'), base.replace(m[0], "category:'infrastructure'"));
    assert.match(run(), /bad category infrastructure/, 'validate.mjs must reject category infrastructure');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- P2-2: status chip + formatted date on generated pages, CSV, feed, validator ----------
// Contract: build-pages.mjs uses filters.js statusOf/formatEffective/STATUS_LABELS (one source of truth).
// Country pages: each <article class="entry"> has exactly one <span class="status-chip status-KEY">LABEL</span>
// (optional "Status: " inner span allowed), the date as <span class="status-date">DATE</span> when non-empty,
// and the optional free-text badge only as <span class="badge-note">TEXT</span>. No bare <span class="badge">.
// upcoming.html: each timeline <li> has exactly one chip (status upcoming or draft) and no duplicate
// "draft, not yet law" text. feed.xml / *.ics never print "undefined" (badge is optional now); feed entries
// carry the status label.
// validate.mjs: `badge` optional (non-empty string if present); a badge that merely restates the date is
// reported on a line containing "<country>/<section>" and "restates the date": after stripping an optional
// leading Effective|In force|Confirmed for|Applies to|From (case-insensitive) the rest equals
// formatEffective(effective) or its long-month form ('1 January 2026', 'January 2026'), case-insensitive;
// or the whole badge equals a status label. Real data must have none.
const P2 = (() => { const sb = { module: { exports: {} } }; vm.runInNewContext(read('filters.js'), sb); return sb.module.exports; })();
const VER22 = js.match(/const LAST_VERIFIED = new Date\('(\d{4}-\d{2}-\d{2})T/)[1];
const escH = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const CHIP = /<span class="status-chip status-([a-z]+)">(?:<span class="[^"]+">Status: <\/span>)?([^<]*)<\/span>/g;
test('p2_2.build_uses_helpers', () => {
  assert.equal(typeof P2.statusOf, 'function', 'filters.js statusOf'); assert.equal(typeof P2.formatEffective, 'function', 'filters.js formatEffective');
  const b = read('scripts/build-pages.mjs');
  for (const n of ['statusOf', 'formatEffective', 'STATUS_LABELS']) assert.match(b, new RegExp(`\\b${n}\\b`), `build-pages.mjs uses ${n}`);
});
test('p2_2.country_pages_chip', () => {
  let total = 0;
  for (const e of CHANGES) {
    const h = read(`countries/${P2.slugify(e.name)}.html`);
    const i = h.indexOf(`<article class="entry" id="${escH(e.section)}">`);
    assert.ok(i >= 0, `${key(e)}: article missing`);
    const art = h.slice(i, h.indexOf('</article>', i));
    const chips = [...art.matchAll(CHIP)];
    assert.equal((art.match(/status-chip/g) || []).length, 1, `${key(e)}: exactly one chip`);
    assert.equal(chips.length, 1, `${key(e)}: chip markup`);
    const k = P2.statusOf(e, VER22);
    assert.equal(chips[0][1], k, `${key(e)}: status-${k}`);
    assert.equal(decode(chips[0][2]), P2.STATUS_LABELS[k], `${key(e)}: label`);
    const date = P2.formatEffective(e.effective);
    assert.deepEqual([...art.matchAll(/<span class="status-date">([^<]*)<\/span>/g)].map(m => m[1]), date ? [date] : [], `${key(e)}: date`);
    assert.deepEqual([...art.matchAll(/<span class="badge-note">([^<]*)<\/span>/g)].map(m => decode(m[1])), e.badge ? [e.badge] : [], `${key(e)}: badge note`);
    assert.ok(!/<span class="badge">|class="badge (draft|upcoming)"/.test(art), `${key(e)}: old badge markup`);
    total++;
  }
  assert.equal(total, CHANGES.length);
});
test('p2_2.upcoming_chip', () => {
  const h = read('upcoming.html');
  const lis = [...h.matchAll(/<ul class="timeline">([\s\S]*?)<\/ul>/g)].flatMap(m => [...m[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(x => x[1]));
  const up = CHANGES.filter(e => e.upcoming);
  assert.equal(lis.length, up.length);
  for (const li of lis) {
    const href = (li.match(/<a href="countries\/([^"#]+)\.html#([^"]+)"/) || []);
    const e = up.find(x => P2.slugify(x.name) === href[1] && escH(x.section) === href[2]);
    assert.ok(e, 'li maps to an upcoming entry: ' + li.slice(0, 120));
    const chips = [...li.matchAll(CHIP)];
    assert.equal(chips.length, 1, `${key(e)}: one chip in upcoming.html`);
    assert.equal(chips[0][1], P2.statusOf(e, VER22));
    assert.ok(['upcoming', 'draft'].includes(chips[0][1]), `${key(e)}: ${chips[0][1]}`);
    assert.ok(!/draft, not yet law/.test(li), `${key(e)}: duplicate draft wording next to the chip`);
  }
});
test('p2_2.generated_no_undefined', () => {
  const files = ['feed.xml', 'calendar.ics', 'upcoming.html', 'countries.html', ...countryFiles.map(f => `countries/${f}`)];
  for (const f of files) assert.ok(!/\bundefined\b/.test(read(f)), `${f} contains "undefined"`);
  const feed = read('feed.xml');
  const ents = feed.split('<entry>').slice(1);
  assert.ok(ents.length > 0);
  for (const en of ents) {
    const id = (en.match(/<id>tag:[^,]+,2026:([^<]+)<\/id>/) || [])[1];
    const e = CHANGES.find(x => `${x.country}/${x.section}` === id);
    assert.ok(e, 'feed id maps to an entry: ' + id);
    const want = P2.STATUS_LABELS[P2.statusOf(e, VER22)];
    assert.ok(decode(decode(en)).includes(want), `${id}: feed entry lacks "${want}"`);
  }
});
test('p2_2.validate_restating_badge', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p22-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', ...DL_FILES]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(tmp, '.well-known'), { recursive: true });
    const run = () => { try { return execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return String(e.stdout) + String(e.stderr); } };
    const base = read('app.js');
    fs.writeFileSync(path.join(tmp, 'app.js'), base);
    const real = run();
    assert.ok(!/restates the date/.test(real), 'real data has restating badges:\n' + real.split('\n').filter(l => /restates/.test(l)).slice(0, 10).join('\n'));
    const lines = base.split('\n');
    const entryLines = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*\{country:'/.test(l) && /upcoming:false/.test(l) && !/draft:true/.test(l));
    const of = re => entryLines.filter(([l]) => re.test(l));
    const day = of(/effective:'\d{4}-\d{2}-\d{2}'/), month = of(/effective:'\d{4}-\d{2}'/), year = of(/effective:'\d{4}'/), none = of(/effective:null/);
    const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const longOf = v => v.length === 4 ? v : v.length === 7 ? `${LONG[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}` : `${+v.slice(8)} ${LONG[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}`;
    const S = v => P2.formatEffective(v);
    const cases = [ // [pool, badge from effective, should be flagged]
      [day, v => `Effective ${S(v)}`, true], [day, v => S(v), true], [day, v => `Effective ${longOf(v)}`, true],
      [day, v => `In force ${S(v)}`, true], [day, v => `Confirmed for ${longOf(v)}`, true], [day, v => `Applies to ${S(v)}`, true],
      [day, v => `effective ${S(v).toLowerCase()}`, true], [day, v => `From ${S(v)}`, true],
      [day, v => `Effective ${S(v)} (retroactive)`, false], [day, v => `Phased from ${S(v)}`, false], [day, v => `Effective ${v.slice(0, 4)} tax year`, false],
      [month, v => `Effective ${S(v)}`, true], [month, v => `Effective ${longOf(v)}`, true], [month, v => longOf(v), true],
      [month, v => `Deadlines ${S(v)} and later`, false],
      [year, v => `Effective ${v}`, true], [year, v => v, true], [year, v => `In force ${v}`, true], [year, v => `Confirmed for ${v}`, false],
      [year, v => `Tax year ${v}`, false], [year, v => `Applies to ${v} wages`, false],
      [day, () => 'In force', true], [none, () => 'Ongoing', true], [none, () => 'Current rates (2026)', false],
      [none, () => 'In force', false], [none, () => 'Current rates', false]];
    const used = new Map(), expect = [];
    const idOf = l => `${l.match(/country:'([^']+)'/)[1]}/${l.match(/section:'([^']+)'/)[1]}`;
    for (const [pool, mk, flagged] of cases) {
      const pick = pool.find(([, i]) => !used.has(i));
      assert.ok(pick, 'not enough entries of this precision to test');
      const [l, i] = pick;
      const eff = (l.match(/effective:(?:'([^']*)'|null)/) || [])[1] || null;
      const b = mk(eff);
      used.set(i, l.replace(/badge:'(?:[^'\\]|\\.)*',/, '').replace(/(section:'[^']+',)/, `$1badge:'${b}',`));
      expect.push([idOf(l), b, flagged]);
    }
    const drop = entryLines.find(([, i]) => !used.has(i));
    used.set(drop[1], drop[0].replace(/badge:'(?:[^'\\]|\\.)*',/, ''));
    fs.writeFileSync(path.join(tmp, 'app.js'), lines.map((l, i) => used.has(i) ? used.get(i) : l).join('\n'));
    const out = run();
    const flaggedLines = out.split('\n').filter(l => /restates the date/.test(l));
    for (const [id, b, flagged] of expect) assert.equal(flaggedLines.some(l => l.includes(id + ':') || l.includes(id + ' ')), flagged, `badge "${b}" (${id}) should ${flagged ? '' : 'NOT '}be flagged:\n${out.slice(0, 1500)}`);
    assert.ok(!out.includes(`${idOf(drop[0])}: missing badge`), 'badge must be optional');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('p2_2.validate_effective_year_in_text', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p22y-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', ...DL_FILES]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(tmp, '.well-known'), { recursive: true });
    const run = () => { try { return execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return String(e.stdout) + String(e.stderr); } };
    // A synthetic entry whose year 2031 appears only in sourceUrl/sourceLabel must be rejected.
    const base = read('app.js');
    const lines = base.split('\n');
    const i = lines.findIndex(l => /^\s*\{country:'/.test(l) && /effective:'2026-01-01'/.test(l) && /upcoming:false/.test(l));
    assert.ok(i >= 0, 'no entry to mutate');
    const id = `${lines[i].match(/country:'([^']+)'/)[1]}/${lines[i].match(/section:'([^']+)'/)[1]}`;
    lines[i] = lines[i].replace(/2026/g, '2019').replace(/effective:'2019-01-01'/, "effective:'2031'").replace(/upcoming:false/, 'upcoming:true')
      .replace(/sourceLabel:'/, "sourceLabel:'2031 ").replace(/badge:'(?:[^'\\]|\\.)*',/, '');
    fs.writeFileSync(path.join(tmp, 'app.js'), lines.join('\n'));
    assert.match(run(), new RegExp(`${id.replace('/', '\\/')}: effective year 2031 appears in none of badge, title, lead or detail text`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- P2-3: thin-coverage backlog on countries.html ----------
// Contract: build-pages emits <section id="thin-coverage"> (h2 present) listing exactly the countries with 1 entry,
// sorted by name, each <li> linking to countries/<slug>.html and showing "1 entry", plus a link to suggest.html.
// When no country has 1 entry the section is omitted entirely.
test('p2_3.thin_coverage_section', () => {
  const h = read('countries.html');
  const counts = {}, names = {};
  for (const c of CHANGES) { counts[c.country] = (counts[c.country] || 0) + 1; names[c.country] = c.name; }
  const thin = Object.keys(counts).filter(k => counts[k] === 1).map(k => names[k]).sort((a, b) => a.localeCompare(b));
  const m = h.match(/<section[^>]*\bid="thin-coverage"[^>]*>([\s\S]*?)<\/section>/);
  if (!thin.length) { assert.ok(!m && !/id="thin-coverage"/.test(h), 'no thin-coverage section when no 1-entry countries'); return; }
  assert.ok(m, 'countries.html has no <section id="thin-coverage">');
  assert.match(m[1], /<h2[^>]*>/);
  assert.match(m[1], /href="suggest\.html/, 'links to suggest.html');
  const items = [...m[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(x => x[1]);
  const got = items.map(x => decode(x.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
  assert.equal(items.length, thin.length, `expected ${thin.join(', ')}; got ${got.join(' | ')}`);
  thin.forEach((name, i) => {
    assert.ok(got[i].includes(name), `item ${i}: expected ${name}, got ${got[i]}`);
    assert.ok(got[i].includes('1 entry'), `${name}: count text "1 entry"`);
    const href = (items[i].match(/href="(countries\/[^"#]+\.html)"/) || [])[1];
    assert.ok(href && resolves(href), `${name}: link to its country page`);
  });
});
test('p2_3.thin_coverage_generated', () => {
  // Generated from CHANGES, not hard-coded: the generator mentions the section id, and no country name literal list.
  const g = read('scripts/build-pages.mjs');
  assert.match(g, /thin-coverage/);
  assert.match(g, /\.filter\(\s*c\s*=>\s*c\.entries\.length\s*===\s*1\s*\)/, 'thin list derived from entry counts');
  // No hard-coded country names anywhere in the generator (names must come from data).
  const allNames = [...new Set(CHANGES.map(c => c.name))].filter(n => n.length > 3);
  const literal = allNames.filter(n => g.includes("'" + n + "'") || g.includes('"' + n + '"'));
  assert.deepEqual(literal, [], 'country-name string literals in build-pages.mjs: ' + literal.join(', '));
  const h = read('countries.html');
  assert.ok((h.match(/id="thin-coverage"/g) || []).length <= 1);
  const counts = {}, names = {};
  for (const c of CHANGES) { counts[c.country] = (counts[c.country] || 0) + 1; names[c.country] = c.name; }
  const want = Object.keys(counts).filter(k => counts[k] === 1).map(k => names[k]).sort((a, b) => a.localeCompare(b));
  const m = h.match(/<section[^>]*\bid="thin-coverage"[^>]*>([\s\S]*?)<\/section>/);
  const got = m ? [...m[1].matchAll(/<li\b[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(x => decode(x[1]).replace(/^\S+\s+/, '').trim()) : [];
  assert.deepEqual(got, want, 'rendered thin-coverage names must exactly equal computed 1-entry countries');
});

// ---------- P2-7: glossary (data, validator, generated pages) ----------
// Contract: data/glossary.json = array of {term, expansion, definition, countries, aliases?, sourceUrl, sourceLabel, checked}.
// - term: non-empty trimmed string; term+aliases unique (case-sensitive) among entries whose country scopes overlap
//   ([] = general = overlaps everything). countries: codes from countryToRegion ([] = general).
// - expansion/definition/sourceLabel: plain text, no '<' or '>'; definition <=300 chars and <=40 words.
// - sourceUrl https://; sourceLabel /^Source: .+ - .+/; checked real YYYY-MM-DD, not after today.
// - No orphans: term or an alias occurs whole-word (case-sensitive, no adjacent Unicode letter/digit) in at least
//   one CHANGES entry text (title, lead, employer, employee, example, note) whose country is in countries (any if []).
// validate.mjs: fails (non-zero) with a message containing "glossary" (and "duplicate" for clashes).
// build-pages: glossary.html (A-Z by term, id="term-<slugify(term)>" per entry, shows term, expansion, definition,
//   <a href="countries/<slug>.html"> per scoped country, <a href="sourceUrl">); listed in sitemap.xml; footer link
//   <a href="[../]glossary.html">Glossary</a> on every generated page. Country pages: each entry lead paragraph is
//   exactly `<p>${linkTerms(lead, glossary, country)}</p>` (default href '../glossary.html').
// SPA decision: app.js does NOT link terms; it keeps PayrollFilters.highlight only, so <a class="term"> and <mark>
//   never nest. Glossary links live on generated country pages.
const GLOSS_FILE = path.join(ROOT, 'data/glossary.json');
const loadGloss = () => { assert.ok(fs.existsSync(GLOSS_FILE), 'data/glossary.json missing'); return JSON.parse(fs.readFileSync(GLOSS_FILE, 'utf8')); };
const CODES = new Set(Object.keys(loadSite().countryToRegion || {}));
const entryText = e => [e.detail.lead, ...(e.detail.employer || []), ...(e.detail.employee || []), e.detail.note].filter(Boolean).join(' \n '); // round 2: only the fields that are linked (not title, not example)
const wordRe = t => new RegExp('(?<![\\p{L}\\p{N}])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u');
test('p2_7.glossary.schema', () => {
  const g = loadGloss();
  assert.ok(Array.isArray(g) && g.length >= 10, 'glossary must have >=10 verified terms');
  const today = new Date(Date.now() + 864e5).toISOString().slice(0, 10); // UTC today + 1 day (tolerates authors up to UTC+14)
  for (const t of g) {
    const at = `glossary ${t && t.term}`;
    assert.ok(typeof t.term === 'string' && t.term && t.term.trim() === t.term, at + ': term');
    for (const k of ['expansion', 'definition', 'sourceLabel']) assert.ok(typeof t[k] === 'string' && t[k].trim() && !/[<>]/.test(t[k]), `${at}: ${k} plain non-empty`);
    assert.ok(t.definition.length <= 300 && t.definition.trim().split(/\s+/).length <= 40, at + ': definition too long');
    assert.ok(Array.isArray(t.countries) && t.countries.every(c => CODES.has(c)), at + ': countries');
    assert.ok(t.aliases === undefined || (Array.isArray(t.aliases) && t.aliases.every(a => typeof a === 'string' && a.trim())), at + ': aliases');
    assert.match(t.sourceUrl, /^https:\/\/[^\s<>"]+$/, at);
    assert.match(t.sourceLabel, /^Source: .+ - .+/, at);
    assert.ok(isDay(t.checked) && t.checked <= today, at + ': checked');
  }
});
test('p2_7.glossary.unique_and_no_orphans', () => {
  const g = loadGloss(), seen = [];
  for (const t of g) for (const name of [t.term, ...(t.aliases || [])]) {
    const clash = seen.find(s => s.name === name && (!s.c.length || !t.countries.length || s.c.some(c => t.countries.includes(c))));
    assert.ok(!clash, `duplicate term/alias ${name}`);
    seen.push({ name, c: t.countries });
  }
  for (const t of g) {
    const res = [t.term, ...(t.aliases || [])].map(wordRe);
    assert.ok(CHANGES.some(e => (!t.countries.length || t.countries.includes(e.country)) && res.some(r => r.test(entryText(e)))), `orphan glossary term ${t.term}`);
  }
});
test('p2_7.validate_rejects_bad_glossary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p27-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'app.js', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', ...DL_FILES]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(tmp, '.well-known'), { recursive: true });
    const run = () => { try { execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' }); return { ok: true, out: '' }; } catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; } };
    const e0 = CHANGES[0];
    const word = e0.detail.lead.match(/(?<![\p{L}\p{N}])[A-Za-z]{4,}(?![\p{L}\p{N}])/u)[0];
    const good = { term: word, expansion: 'Fixture', definition: 'A fixture term.', countries: [e0.country], sourceUrl: 'https://example.org/x', sourceLabel: 'Source: Example - Fixture', checked: '2026-01-01' };
    const write = arr => fs.writeFileSync(path.join(tmp, 'data/glossary.json'), typeof arr === 'string' ? arr : JSON.stringify(arr));
    write([good]);
    const r0 = run(); assert.ok(r0.ok, 'valid fixture glossary must pass: ' + r0.out.slice(0, 300));
    const { expansion: _x, ...missing } = good;
    const bad = {
      http: { ...good, sourceUrl: 'http://example.org/x' },
      html: { ...good, definition: 'A <b>bold</b> term.' },
      long: { ...good, definition: 'x '.repeat(160).trim() },
      code: { ...good, countries: ['atlantis'] },
      future: { ...good, checked: '2099-01-01' },
      baddate: { ...good, checked: '2026-02-30' },
      label: { ...good, sourceLabel: 'Example' },
      orphan: { ...good, term: 'Zzqxglossaryorphan' },
      missing,
    };
    for (const [k, v] of Object.entries(bad)) {
      write([v]); const r = run();
      assert.ok(!r.ok && /glossary/i.test(r.out), `validate.mjs must reject glossary case "${k}"`);
    }
    write([good, { ...good, expansion: 'Dup' }]);
    let r = run(); assert.ok(!r.ok && /glossary/i.test(r.out) && /duplicate/i.test(r.out), 'duplicate term in same scope rejected');
    write([good, { ...good, term: e0.title.match(/[A-Za-z]{3,}/)[0], aliases: [word], countries: [] }]);
    r = run(); assert.ok(!r.ok && /duplicate/i.test(r.out), 'alias clashing with a term in overlapping (general) scope rejected');
    write('"not an array"'); r = run(); assert.ok(!r.ok && /glossary/i.test(r.out), 'non-array rejected');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('p2_7.glossary_page', () => {
  const g = loadGloss();
  assert.ok(fs.existsSync(path.join(ROOT, 'glossary.html')), 'glossary.html not generated');
  const h = read('glossary.html');
  const ids = [...h.matchAll(/\sid="term-([^"]+)"/g)].map(m => m[1]);
  const want = [...g].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' })).map(t => P2.slugify(t.term));
  assert.deepEqual(ids, want, 'one id="term-<slug>" per term, A-Z order');
  const names = new Map(CHANGES.map(e => [e.country, e.name]));
  for (const t of g) {
    const i = h.indexOf(`id="term-${P2.slugify(t.term)}"`), j = h.indexOf('id="term-', i + 5), block = h.slice(i, j < 0 ? undefined : j);
    for (const k of ['term', 'expansion', 'definition']) assert.ok(block.includes(escH(t[k])), `${t.term}: ${k} shown`);
    assert.ok(block.includes(`href="${escH(t.sourceUrl)}"`), `${t.term}: source link`);
    for (const c of t.countries) assert.ok(block.includes(`href="countries/${P2.slugify(names.get(c) || c)}.html"`), `${t.term}: link to ${c} page`);
  }
  assert.ok(!/\son[a-z]+=|\sstyle=/i.test(h) && !INLINE_SCRIPT.test(h), 'CSP: no inline handlers/scripts/styles (JSON-LD data blocks excepted)');
  assert.match(read('sitemap.xml'), /<loc>[^<]*\/glossary\.html<\/loc>/, 'glossary.html in sitemap');
  for (const f of ['countries.html', 'upcoming.html', 'glossary.html', `countries/${countryFiles.find(f => f.endsWith('.html'))}`])
    assert.match((read(f).match(/<footer[\s\S]*?<\/footer>/) || [''])[0], /<a href="(\.\.\/)?glossary\.html">Glossary<\/a>/, `${f}: footer Glossary link`);
});
test('p2_7.country_pages_link_terms', () => {
  const g = loadGloss();
  assert.match(read('scripts/build-pages.mjs'), /linkTerms\(/, 'build-pages uses filters.js linkTerms');
  let linked = 0;
  for (const e of CHANGES) {
    const file = `countries/${P2.slugify(e.name)}.html`, h = read(file);
    const art = (h.match(new RegExp(`<article class="entry" id="${e.section}">([\\s\\S]*?)</article>`)) || [])[1];
    assert.ok(art, `${file}#${e.section}`);
    const want = `<p>${P2.linkTerms(e.detail.lead, g, e.country)}</p>`;
    assert.ok(art.includes(want), `${e.country}/${e.section}: lead must be ${want.slice(0, 160)}`);
    // Bullets and note are linked too, but a term already linked earlier in the same card (lead first) is not linked again.
    let rest = g.filter(t => !want.includes(`#term-${P2.slugify(t.term)}"`));
    const next = text => { const h = P2.linkTerms(text, rest, e.country); rest = rest.filter(t => !h.includes(`#term-${P2.slugify(t.term)}"`)); return h; };
    for (const [label, items] of [['For the employer', e.detail.employer || []], ['For the employee', e.detail.employee || []]]) {
      if (!items.length) continue;
      const hs = items.map(next);
      assert.ok(art.includes(`<h3>${label}</h3><ul>${hs.map(h => `<li>${h}</li>`).join('')}</ul>`), `${e.country}/${e.section}: ${label} bullets`);
      linked += hs.join('').split('<a class="term"').length - 1;
    }
    if (e.detail.note) { const nh = next(e.detail.note); assert.ok(art.includes(`<p class="note">${nh}</p>`), `${e.country}/${e.section}: note`); linked += nh.split('<a class="term"').length - 1; }
    linked += (want.match(/<a class="term"/g) || []).length;
    assert.ok(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(art), `${e.section}: nested links`);
  }
  assert.ok(linked >= 10, 'expected at least 10 term links across country pages, got ' + linked);
  const gh = read('glossary.html');
  for (const m of new Set([...CHANGES.map(e => P2.linkTerms(e.detail.lead, g, e.country)).join('').matchAll(/glossary\.html#(term-[^"]+)"/g)].map(m => m[1])))
    assert.ok(gh.includes(`id="${m}"`), `dangling glossary anchor ${m}`);
});

// ---------- P2-7 follow-up: validator hygiene, dates, slugs, markup, coverage ----------
// Runs scripts/validate.mjs in a temp copy of the site with the given glossary (array or raw string) and optional app.js edit.
const validateWith = (gloss, appEdit) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p27b-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'data'));
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', ...DL_FILES]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, 'app.js'), appEdit ? appEdit(read('app.js')) : read('app.js'));
    if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(tmp, '.well-known'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data/glossary.json'), typeof gloss === 'string' ? gloss : JSON.stringify(gloss));
    try { execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' }); return { ok: true, out: '' }; } catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
};
const fixtureTerm = () => {
  const e0 = CHANGES[0];
  const word = e0.detail.lead.match(/(?<![\p{L}\p{N}])[A-Za-z]{4,}(?![\p{L}\p{N}])/u)[0];
  return { e0, word, good: { term: word, expansion: 'Fixture', definition: 'A fixture term here.', countries: [e0.country], sourceUrl: 'https://example.org/x', sourceLabel: 'Source: Example - Fixture', checked: '2026-01-01' } };
};
const ymd = offsetDays => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);
test('p2_7.validate_slugs', () => {
  const { e0, word, good } = fixtureTerm();
  assert.ok(validateWith([good]).ok, 'fixture must pass');
  const other = CHANGES.find(e => e.country !== e0.country).country;
  let r = validateWith([good, { ...good, term: word + '.', countries: [other] }]);
  assert.ok(!r.ok && /glossary/i.test(r.out) && /duplicate slug/i.test(r.out), 'same slug in non-overlapping scopes rejected: ' + r.out.slice(0, 300));
  r = validateWith([{ ...good, term: 'ВДУ' }]);
  assert.ok(!r.ok && /glossary/i.test(r.out) && /empty slug/i.test(r.out), 'term with an empty slug rejected: ' + r.out.slice(0, 300));
});
test('p2_7.validate_hygiene', () => {
  const { word, good } = fixtureTerm();
  const bad = {
    alias_untrimmed: [{ ...good, aliases: [' x '] }, /aliases/],
    alias_empty: [{ ...good, aliases: [''] }, /aliases/],
    alias_markup: [{ ...good, aliases: ['<b>'] }, /alias.*plain text/],
    alias_not_array: [{ ...good, aliases: 'x' }, /aliases/],
    newline_definition: [{ ...good, definition: 'A fixture\nterm here.' }, /definition.*control/],
    control_expansion: [{ ...good, expansion: 'Fix\u0007ture' }, /expansion.*control/],
    control_label: [{ ...good, sourceLabel: 'Source: Example - Fix\ture' }, /sourceLabel.*control/],
    term_markup: [{ ...good, term: word + '<i>' }, /term.*plain text/],
    duplicate_countries: [{ ...good, countries: [good.countries[0], good.countries[0]] }, /countries.*twice/],
    unknown_key: [{ ...good, extra: 1 }, /unknown field "extra"/],
    userinfo: [{ ...good, sourceUrl: 'https://user:pw@example.org/x' }, /sourceUrl/],
    short_definition: [{ ...good, definition: 'Two words' }, /definition.*min 3/],
  };
  for (const [k, [entry, re]] of Object.entries(bad)) {
    const r = validateWith([entry]);
    assert.ok(!r.ok && /glossary/i.test(r.out) && re.test(r.out), `validate.mjs must reject glossary case "${k}" with a matching message: ` + r.out.slice(0, 400));
  }
});
test('p2_7.validate_date_tolerance', () => {
  const { good } = fixtureTerm();
  assert.ok(validateWith([{ ...good, checked: ymd(1) }]).ok, 'checked = UTC today + 1 day must pass');
  let r = validateWith([{ ...good, checked: ymd(2) }]);
  assert.ok(!r.ok && /glossary/i.test(r.out) && /in the future/.test(r.out), 'checked = UTC today + 2 days must fail');
  // The same tolerance applies to the existing added/updated rules.
  const e0 = CHANGES[0], swap = d => src => src.replace(`added:'${e0.added}'`, `added:'${d}'`);
  r = validateWith([good], swap(ymd(1)));
  assert.ok(!/added \S+ is in the future/.test(r.out), 'added = UTC today + 1 day must not be reported as future: ' + r.out.slice(0, 300));
  r = validateWith([good], swap(ymd(2)));
  assert.ok(!r.ok && /added \S+ is in the future/.test(r.out), 'added = UTC today + 2 days must fail');
});
test('p2_7.glossary_page_extras', () => {
  const g = loadGloss(), h = read('glossary.html');
  const newest = g.map(t => t.checked).sort().pop();
  const longDay = new Date(newest + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  assert.match(read('sitemap.xml'), new RegExp(`glossary\\.html</loc><lastmod>${newest}</lastmod>`), 'sitemap lastmod = newest checked date');
  assert.ok(h.includes(`definitions last checked ${longDay}`), 'meta line uses the newest checked date');
  const nav = (h.match(/<nav class="az"[^>]*>([\s\S]*?)<\/nav>/) || [])[1];
  assert.ok(nav, 'A-Z jump list present');
  const idSet = new Set([...h.matchAll(/\sid="(term-[^"]+)"/g)].map(m => m[1]));
  const navLinks = [...nav.matchAll(/<a href="#(term-[^"]+)">([^<]*)<\/a>/g)];
  assert.equal(navLinks.length, g.length, 'one jump link per term');
  for (const t of g) {
    const m = navLinks.find(x => x[1] === 'term-' + P2.slugify(t.term));
    assert.ok(m, `jump link for ${t.term}`);
    assert.equal(m[2], escH(t.term), `${t.term}: jump link text is escaped`);
    assert.ok(idSet.has(m[1]), `${t.term}: jump target exists`);
  }
  for (const f of ['privacy.html', 'terms.html'])
    assert.match((read(f).match(/<footer[\s\S]*?<\/footer>/) || [''])[0], /<a href="glossary\.html">Glossary<\/a>/, `${f}: footer Glossary link`);
});
test('p2_7.country_pages_known_links_and_markup', () => {
  const g = loadGloss(), page = n => read(`countries/${n}.html`);
  const prsi = g.find(t => t.term === 'PRSI');
  assert.ok(page('ireland').includes(`<a class="term" href="../glossary.html#term-prsi"><abbr title="${escH(prsi.expansion)}">PRSI</abbr><span class="visually-hidden"> (${escH(prsi.expansion)})</span></a>`), 'ireland: PRSI links to the glossary with its expansion');
  assert.ok(page('united-kingdom').includes('href="../glossary.html#term-paye"'), 'united-kingdom: PAYE links');
  assert.ok(page('qatar').includes('href="../glossary.html#term-wps-qatar"') && !page('qatar').includes('#term-wps-bahrain'), 'qatar: WPS links to the Qatar entry only');
  assert.ok(page('bahrain').includes('href="../glossary.html#term-wps-bahrain"') && !page('bahrain').includes('#term-wps-qatar'), 'bahrain: WPS links to the Bahrain entry only');
  assert.ok(!/href="[^"]*#term-ni"/.test(page('ireland')), 'scoped acronyms do not link in other countries');
  // Every link has the exact accessible markup: abbr title plus the same expansion as visually hidden text.
  let all = '';
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) all += read(`countries/${f}`);
  const total = all.split('<a class="term"').length - 1, good = (all.match(/<a class="term" href="\.\.\/glossary\.html#term-[a-z0-9-]+"><abbr title="([^"]*)">[^<]*<\/abbr><span class="visually-hidden"> \(\1\)<\/span><\/a>/g) || []).length;
  assert.ok(total > 0 && good === total, `all ${total} term links must carry the expansion as visible-to-assistive-tech text (${good} do)`);
  assert.match(read('legal.css'), /\.visually-hidden\s*\{[^}]*clip/, 'legal.css defines .visually-hidden');
  // Headings and titles are never linked.
  for (const m of all.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)) assert.ok(!/class="term"/.test(m[2]), 'term link inside a heading: ' + m[2].slice(0, 120));
  assert.ok(!/<a class="term"[^>]*\sstyle=/.test(all), 'no inline styles on term links');
});
test('p2_7.validate_orphan_fields', () => {
  // A word that occurs only in an entry's title (or only in its example) is an orphan: those fields are never linked.
  const words = t => t.match(/(?<![\p{L}\p{N}])[A-Za-z]{5,}(?![\p{L}\p{N}])/gu) || [];
  const linkedText = e => entryText(e);
  const find = field => {
    for (const e of CHANGES) {
      const src = field === 'title' ? e.title : e.detail.example;
      for (const w of words(src || '')) {
        if (CHANGES.some(x => x.country === e.country && new RegExp('(?<![\\p{L}\\p{N}])' + w + '(?![\\p{L}\\p{N}])', 'u').test(linkedText(x)))) continue;
        return { country: e.country, word: w };
      }
    }
    return null;
  };
  const { good } = fixtureTerm();
  for (const field of ['title', 'example']) {
    const hit = find(field);
    assert.ok(hit, `fixture: data has a word that occurs only in an entry ${field}`);
    const r = validateWith([{ ...good, term: hit.word, countries: [hit.country] }]);
    assert.ok(!r.ok && /glossary/i.test(r.out) && /orphan/i.test(r.out), `a term found only in the ${field} must be rejected as an orphan: ` + r.out.slice(0, 300));
  }
});
test('p2_7.readme_example_validates', () => {
  const sec = read('README.md').split('### The glossary')[1].split('\n## ')[0];
  const example = JSON.parse(sec.match(/```json\n([\s\S]*?)\n```/)[1]);
  const r = validateWith([example]);
  assert.ok(r.ok, 'the README glossary example must pass validate.mjs: ' + r.out.slice(0, 300));
  assert.match(sec, /Unknown fields are rejected/); assert.match(sec, /unique across the whole glossary/); assert.match(sec, /UTC today plus one day/);
});
test('p2_7.every_term_links_somewhere', () => {
  const g = loadGloss();
  let all = '';
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) all += read(`countries/${f}`);
  for (const t of g) assert.ok(all.includes(`href="../glossary.html#term-${P2.slugify(t.term)}"`), `glossary term ${t.term} never links from a generated country page`);
});

// ---------- P2-8: country fact sheets (data/facts.json, validator, "Key facts" box on generated country pages) ----------
// CONTRACT
// data/facts.json = array of
//   {code, asOf, currency, facts:[{key, label, value, validFrom?, note?, bands?, sourceUrl, sourceLabel, checked}]}
// - code: own key of countryToRegion, unique in the file. asOf: real YYYY-MM-DD, not after UTC today + 1 day.
//   currency: 3 uppercase ASCII letters (ISO 4217 shape). facts: non-empty array.
// - key: one of minimumWage|ssEmployer|ssEmployee|ssCeiling|taxBands|payFrequency|other; unique per country except 'other'.
// - label, value: non-empty trimmed plain text (no '<' '>' and no control chars/line breaks); value <= 300 chars.
// - validFrom?: real YYYY-MM-DD (may be in the future: a rate announced for later). note?: non-empty plain text <= 300 chars.
// - bands? (only on key 'taxBands'): non-empty array (max 20) of {from:string, to:string|null, rate:string}; strings are
//   non-empty trimmed plain text <= 60 chars; no other fields.
// - sourceUrl: https, no userinfo. sourceLabel: /^Source: .+ - .+/ plain text. checked: real day, not after UTC today + 1 day.
// - Unknown fields are rejected at both levels. A fact whose `checked` is more than 365 days before UTC today produces a
//   WARNING (stdout/stderr, exit code still 0) that names "facts"; the validator never fails for age.
// - validate.mjs fails (non-zero) with a message containing "facts" when data/facts.json is missing, not JSON, or invalid.
// build-pages.mjs, country page: a section only for countries present in facts.json; none otherwise (no empty box).
//   Placed after the <h1> and before the first <article class="entry">. Exact markup (whitespace between tags is free;
//   all text and attribute values escaped with & < > " '): see renderFacts() below. Dates are long en-GB ("1 January 2026").
// legal.css: .table-scroll {overflow-x:auto} (tables scroll inside it, not the page), .key-facts {overflow-wrap:anywhere}.
const FACTS_FILE = path.join(ROOT, 'data/facts.json');
const FACT_COUNTRIES = { uk: 'GBP', germany: 'EUR', france: 'EUR', netherlands: 'EUR', spain: 'EUR', italy: 'EUR', poland: 'PLN', belgium: 'EUR', sweden: 'SEK', ireland: 'EUR', austria: 'EUR', czechia: 'CZK', romania: 'RON', portugal: 'EUR', denmark: 'DKK', norway: 'NOK', finland: 'EUR', hungary: 'HUF', greece: 'EUR', switzerland: 'CHF' }; // batches 1 to 4; update when the next batch lands
const longDay = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const squash = h => h.replace(/>\s+</g, '><');
const renderFacts = c => {
  const fact = f => `<div class="fact" data-key="${f.key}"><dt class="fact-label">${escH(f.label)}</dt><dd class="fact-body">`
    + `<p class="fact-value">${escH(f.value)}</p>`
    + (f.validFrom ? `<p class="fact-from">Valid from ${longDay(f.validFrom)}</p>` : '')
    + (f.note ? `<p class="fact-note">${escH(f.note)}</p>` : '')
    + (f.bands ? `<div class="table-scroll" tabindex="0" role="region" aria-label="${escH(f.label)} table"><table class="tax-bands"><caption>${escH(f.label)} (${escH(c.currency)})</caption>`
      + `<thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Rate</th></tr></thead><tbody>`
      + f.bands.map(b => `<tr><td>${escH(b.from)}</td><td>${b.to === null ? 'No limit' : escH(b.to)}</td><td>${escH(b.rate)}</td></tr>`).join('')
      + `</tbody></table></div>` : '')
    + `<p class="fact-source"><a href="${escH(f.sourceUrl)}" rel="noopener">${escH(f.sourceLabel)}</a> &middot; As of ${longDay(c.asOf)} &middot; Checked ${longDay(f.checked)}</p>`
    + `</dd></div>`;
  return `<section class="key-facts" aria-labelledby="key-facts"><h2 id="key-facts">Key facts</h2>`
    + `<p class="meta">Currency: ${escH(c.currency)}</p>`
    + `<p class="fact-disclaimer">Check the source before use. For information only, not legal or tax advice.</p>`
    + `<dl class="facts">${c.facts.map(fact).join('')}</dl></section>`;
};

// A throw-away copy of the site (validator + page generator inputs). facts: array | raw string | undefined (= no file).
const factsSite = (facts, { appEdit } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-p28-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'data')); fs.mkdirSync(path.join(dir, 'worker'));
  for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'scripts/build-pages.mjs', 'scripts/operator.json', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', 'data/glossary.json', ...DL_FILES]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'scripts/templates'), path.join(dir, 'scripts/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.js'), appEdit ? appEdit(read('app.js')) : read('app.js'));
  if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(dir, '.well-known'), { recursive: true });
  const site = {
    dir,
    setFacts: v => { const p = path.join(dir, 'data/facts.json'); if (v === undefined) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); },
    run: (script, ...args) => { const r = spawnSync(process.execPath, ['scripts/' + script, ...args], { cwd: dir, encoding: 'utf8' }); return { ok: r.status === 0, out: String(r.stdout) + String(r.stderr) }; },
    // P2-12: data/deadlines.json of the temp copy (array | raw string | undefined = no file); the helpers leave the facts untouched.
    setDeadlines: v => { const p = path.join(dir, 'data/deadlines.json'); if (v === undefined) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); },
    validateDl: v => { site.setDeadlines(v); return site.run('validate.mjs'); },
    buildDl: (v, ...args) => { site.setDeadlines(v); return site.run('build-pages.mjs', ...args); },
    read: f => fs.readFileSync(path.join(dir, f), 'utf8'),
    exists: f => fs.existsSync(path.join(dir, f)),
    validate: v => { site.setFacts(v); return site.run('validate.mjs'); },
    build: (v, ...args) => { site.setFacts(v); return site.run('build-pages.mjs', ...args); },
    page: slug => fs.readFileSync(path.join(dir, 'countries', slug + '.html'), 'utf8'),
    pages: () => fs.readdirSync(path.join(dir, 'countries')).filter(f => f.endsWith('.html')),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return site;
};
const fixFact = (o = {}) => ({ key: 'minimumWage', label: 'Minimum wage', value: 'EUR 1,000 gross per month, full-time', sourceUrl: 'https://example.org/min', sourceLabel: 'Source: Example Ministry - Minimum wage', checked: '2026-10-01', ...o });
const fixCountry = (o = {}) => ({ code: 'france', asOf: '2026-01-01', currency: 'EUR', facts: [fixFact()], ...o });
const fixBands = () => [{ from: '0', to: '10,000', rate: '0%' }, { from: '10,001', to: '30,000', rate: '11%' }, { from: '30,001', to: null, rate: '30%' }];
// Rich fixture: bands, validFrom, note, repeated 'other', apostrophe/ampersand text, a second country.
const richFixture = () => [
  fixCountry({
    facts: [
      fixFact({ validFrom: '2026-01-01', note: 'Revalued every 1 January & during the year.' }),
      fixFact({ key: 'ssEmployer', label: "Employer's social security", value: "About 40% of gross pay (employer's share)", sourceUrl: 'https://example.org/ss?a=1&b=2' }),
      fixFact({ key: 'taxBands', label: 'Income tax bands', value: 'Progressive: 0% to 30% of taxable income per year', bands: fixBands(), validFrom: '2026-01-01' }),
      fixFact({ key: 'other', label: 'Other one', value: 'First other fact' }),
      fixFact({ key: 'other', label: 'Other two', value: 'Second other fact' }),
    ],
  }),
  fixCountry({ code: 'spain', asOf: '2026-03-01', currency: 'EUR', facts: [fixFact({ key: 'payFrequency', label: 'Usual pay frequency', value: 'Monthly (14 payments a year are common)' })] }),
];

test('p2_8.validate_accepts_valid_facts', () => {
  const s = factsSite();
  try {
    let r = s.validate(richFixture()); assert.ok(r.ok, 'rich valid fixture must pass: ' + r.out.slice(0, 500));
    r = s.validate([]); assert.ok(r.ok, 'an empty array is valid: ' + r.out.slice(0, 300));
    r = s.validate([fixCountry({ facts: [fixFact({ value: 'x'.repeat(300), note: 'n'.repeat(300), validFrom: '2099-01-01' })] })]);
    assert.ok(r.ok, 'value/note of exactly 300 chars and a future validFrom must pass: ' + r.out.slice(0, 300));
    r = s.validate([fixCountry({ facts: [fixFact({ key: 'taxBands', label: 'Income tax bands', value: 'Progressive, see source' })] })]); assert.ok(r.ok, 'a taxBands fact without bands (text value only) must pass: ' + r.out.slice(0, 300));
    r = s.validate([fixCountry({ asOf: ymd(1), facts: [fixFact({ checked: ymd(1) })] })]); assert.ok(r.ok, 'asOf/checked = UTC today + 1 day must pass: ' + r.out.slice(0, 300));
  } finally { s.done(); }
});
test('p2_8.validate_rejects_missing_or_unparseable_facts_file', () => {
  const s = factsSite();
  try {
    let r = s.validate(undefined);
    assert.ok(!r.ok && /facts/i.test(r.out), 'a missing data/facts.json must fail and name "facts": ' + r.out.slice(0, 300));
    r = s.validate('{not json'); assert.ok(!r.ok && /facts/i.test(r.out), 'invalid JSON must fail and name "facts"');
    r = s.validate('"text"'); assert.ok(!r.ok && /facts/i.test(r.out) && /array/i.test(r.out), 'non-array must fail');
    r = s.validate('{"code":"france"}'); assert.ok(!r.ok && /facts/i.test(r.out) && /array/i.test(r.out), 'object instead of array must fail');
  } finally { s.done(); }
});
test('p2_8.validate_rejects_bad_facts', () => {
  const s = factsSite();
  const f = fixFact, c = fixCountry;
  const F = o => [c({ facts: [f(o)] })];
  const noKey = (obj, k) => { const { [k]: _, ...rest } = obj; return rest; };
  const cases = {
    entry_not_object: [[1], /facts.*must be an object/i],
    entry_array: [[[]], /facts.*must be an object/i],
    country_unknown_field: [[c({ extra: 1 })], /unknown field "extra"/],
    code_unknown: [[c({ code: 'atlantis' })], /code must be a known country code/],
    code_proto: [[c({ code: 'constructor' })], /code must be a known country code/],
    code_case: [[c({ code: 'France' })], /code must be a known country code/],
    code_missing: [[noKey(c(), 'code')], /code must be a known country code/],
    duplicate_code: [[c(), c()], /duplicate code "france"/],
    asOf_missing: [[noKey(c(), 'asOf')], /asOf/],
    asOf_not_real: [[c({ asOf: '2026-02-30' })], /asOf/],
    asOf_format: [[c({ asOf: '2026-1-1' })], /asOf/],
    asOf_future: [[c({ asOf: ymd(2) })], /asOf.*in the future/],
    currency_lower: [[c({ currency: 'eur' })], /currency/],
    currency_long: [[c({ currency: 'EURO' })], /currency/],
    currency_digit: [[c({ currency: 'E1R' })], /currency/],
    currency_number: [[c({ currency: 978 })], /currency/],
    currency_missing: [[noKey(c(), 'currency')], /currency/],
    facts_not_array: [[c({ facts: 'x' })], /facts must be a non-empty array/],
    facts_empty: [[c({ facts: [] })], /facts must be a non-empty array/],
    fact_not_object: [[c({ facts: [1] })], /fact.*must be an object/i],
    fact_unknown_field: [F({ extra: 1 }), /unknown field "extra"/],
    fact_stray_asOf: [F({ asOf: '2026-01-01' }), /unknown field "asOf"/],
    key_unknown: [F({ key: 'salary' }), /key must be one of/],
    key_missing: [[c({ facts: [noKey(f(), 'key')] })], /key must be one of/],
    key_proto: [F({ key: 'constructor' }), /key must be one of/],
    duplicate_key: [[c({ facts: [f(), f({ label: 'Second' })] })], /duplicate key "minimumWage"/],
    label_empty: [F({ label: '' }), /label/],
    label_untrimmed: [F({ label: ' Minimum wage' }), /label/],
    label_markup: [F({ label: 'Minimum <b>wage</b>' }), /label.*plain text/],
    label_control: [F({ label: 'Minimum\nwage' }), /label.*control/],
    value_missing: [[c({ facts: [noKey(f(), 'value')] })], /value/],
    value_empty: [F({ value: '  ' }), /value/],
    value_markup: [F({ value: 'EUR 1 <script>alert(1)</script>' }), /value.*plain text/],
    value_gt: [F({ value: 'more > less' }), /value.*plain text/],
    value_newline: [F({ value: 'EUR 1\nEUR 2' }), /value.*control/],
    value_tab: [F({ value: 'EUR\t1' }), /value.*control/],
    value_ls: [F({ value: 'EUR 1' }), /value.*control/],
    value_long: [F({ value: 'x'.repeat(301) }), /value.*300/],
    value_not_string: [F({ value: 1000 }), /value/],
    validFrom_not_real: [F({ validFrom: '2026-13-01' }), /validFrom/],
    validFrom_month: [F({ validFrom: '2026-01' }), /validFrom/],
    validFrom_empty: [F({ validFrom: '' }), /validFrom/],
    note_empty: [F({ note: '' }), /note/],
    note_markup: [F({ note: 'See <a href="x">this</a>' }), /note.*plain text/],
    note_control: [F({ note: 'a\u0007b' }), /note.*control/],
    note_long: [F({ note: 'n'.repeat(301) }), /note.*300/],
    url_http: [F({ sourceUrl: 'http://example.org/x' }), /sourceUrl/],
    url_userinfo: [F({ sourceUrl: 'https://user:pw@example.org/x' }), /sourceUrl/],
    url_js: [F({ sourceUrl: 'javascript:alert(1)' }), /sourceUrl/],
    url_space: [F({ sourceUrl: 'https://example.org/a b' }), /sourceUrl/],
    url_quote: [F({ sourceUrl: 'https://example.org/a"b' }), /sourceUrl/],
    url_missing: [[c({ facts: [noKey(f(), 'sourceUrl')] })], /sourceUrl/],
    label_source_pattern: [F({ sourceLabel: 'Example Ministry' }), /sourceLabel/],
    label_source_markup: [F({ sourceLabel: 'Source: Example - <b>x</b>' }), /sourceLabel.*plain text/],
    label_source_control: [F({ sourceLabel: 'Source: Example - Min\twage' }), /sourceLabel.*control/],
    label_source_missing: [[c({ facts: [noKey(f(), 'sourceLabel')] })], /sourceLabel/],
    checked_missing: [[c({ facts: [noKey(f(), 'checked')] })], /checked/],
    checked_not_real: [F({ checked: '2026-02-30' }), /checked/],
    checked_future: [F({ checked: ymd(2) }), /checked.*in the future/],
    bands_on_wrong_key: [F({ bands: fixBands() }), /bands.*taxBands/],
    bands_not_array: [F({ key: 'taxBands', bands: 'x' }), /bands/],
    bands_empty: [F({ key: 'taxBands', bands: [] }), /bands/],
    bands_too_many: [F({ key: 'taxBands', bands: Array.from({ length: 21 }, (_, i) => ({ from: String(i), to: String(i + 1), rate: '1%' })) }), /bands.*20/],
    band_not_object: [F({ key: 'taxBands', bands: [1] }), /band.*must be an object/i],
    band_missing_rate: [F({ key: 'taxBands', bands: [{ from: '0', to: null }] }), /band.*rate/],
    band_missing_from: [F({ key: 'taxBands', bands: [{ to: null, rate: '1%' }] }), /band.*from/],
    band_missing_to: [F({ key: 'taxBands', bands: [{ from: '0', rate: '1%' }] }), /band.*to/],
    band_number: [F({ key: 'taxBands', bands: [{ from: 0, to: null, rate: '1%' }] }), /band.*from/],
    band_empty_string: [F({ key: 'taxBands', bands: [{ from: '0', to: '', rate: '1%' }] }), /band.*to/],
    band_markup: [F({ key: 'taxBands', bands: [{ from: '0', to: null, rate: '<b>1%</b>' }] }), /band.*rate.*plain text/],
    band_control: [F({ key: 'taxBands', bands: [{ from: '0\n', to: null, rate: '1%' }] }), /band.*from/],
    band_long: [F({ key: 'taxBands', bands: [{ from: '0', to: null, rate: 'x'.repeat(61) }] }), /band.*rate.*60/],
    band_unknown_field: [F({ key: 'taxBands', bands: [{ from: '0', to: null, rate: '1%', extra: 1 }] }), /unknown field "extra"/],
  };
  try {
    assert.ok(s.validate([c()]).ok, 'baseline fixture must pass');
    for (const [name, [data, re]] of Object.entries(cases)) {
      const r = s.validate(data);
      assert.ok(!r.ok && /facts/i.test(r.out) && re.test(r.out), `validate.mjs must reject facts case "${name}" with a message naming "facts" and matching ${re}: ` + r.out.slice(0, 400));
    }
  } finally { s.done(); }
});
test('p2_8.validate_allows_repeated_other_only', () => {
  const s = factsSite();
  try {
    const two = key => [fixCountry({ facts: [fixFact({ key, label: 'One' }), fixFact({ key, label: 'Two' })] })];
    assert.ok(s.validate(two('other')).ok, "two 'other' facts in one country are allowed");
    for (const key of ['minimumWage', 'ssEmployer', 'ssEmployee', 'ssCeiling', 'taxBands', 'payFrequency']) {
      const r = s.validate(two(key));
      assert.ok(!r.ok && /facts/i.test(r.out) && new RegExp(`duplicate key "${key}"`).test(r.out), `duplicate ${key} must be rejected: ` + r.out.slice(0, 300));
    }
    // The same key in two different countries is fine.
    assert.ok(s.validate([fixCountry(), fixCountry({ code: 'spain' })]).ok, 'same key in different countries is fine');
  } finally { s.done(); }
});
test('p2_8.validate_warns_when_stale_but_passes', () => {
  const s = factsSite();
  try {
    let r = s.validate([fixCountry({ facts: [fixFact({ checked: ymd(-370) })] })]);
    assert.ok(r.ok, 'stale facts must not fail validation: ' + r.out.slice(0, 300));
    assert.ok(/WARNING/.test(r.out) && /facts/i.test(r.out.split('\n').filter(l => /WARNING/.test(l)).join('\n')) && /365/.test(r.out), 'a fact checked >365 days ago must produce a WARNING line naming "facts" and 365: ' + r.out.slice(0, 400));
    r = s.validate([fixCountry({ facts: [fixFact({ checked: ymd(-360) })] })]);
    assert.ok(r.ok && !/WARNING.*facts/i.test(r.out), 'a fact checked 360 days ago must not warn: ' + r.out.slice(0, 300));
    r = s.validate([fixCountry({ facts: [fixFact({ checked: ymd(0) })] })]);
    assert.ok(r.ok && !/WARNING.*facts/i.test(r.out), 'a fresh fact must not warn');
  } finally { s.done(); }
});
test('p2_8.render_fixture_markup', () => {
  const s = factsSite();
  try {
    const data = richFixture();
    const r = s.build(data); assert.ok(r.ok, 'build must succeed: ' + r.out.slice(0, 400));
    const h = s.page('france'), q = squash(h);
    assert.equal((h.match(/id="key-facts"/g) || []).length, 1, 'exactly one id="key-facts"');
    assert.ok(q.includes(renderFacts(data[0])), 'france: key facts section must match the contract exactly. Expected:\n' + renderFacts(data[0]).slice(0, 900));
    assert.ok(squash(s.page('spain')).includes(renderFacts(data[1])), 'spain: key facts section must match the contract');
    // Placement: after the h1, before the first entry article.
    const sec = q.indexOf('<section class="key-facts"'), h1 = q.indexOf('</h1>'), art = q.indexOf('<article class="entry"');
    assert.ok(h1 > 0 && sec > h1 && sec < art, 'section sits between the <h1> and the first entry');
    // Facts keep file order; both "other" facts render; bands table has caption + scroll container.
    assert.deepEqual([...q.matchAll(/<div class="fact" data-key="(\w+)">/g)].map(m => m[1]), ['minimumWage', 'ssEmployer', 'taxBands', 'other', 'other']);
    assert.ok(/<div class="table-scroll" tabindex="0" role="region" aria-label="Income tax bands table"><table class="tax-bands"><caption>Income tax bands \(EUR\)<\/caption>/.test(q), 'table inside a focusable, labelled .table-scroll region with a caption');
    assert.equal((q.match(/<table\b/g) || []).length, 1, 'one table (only the taxBands fact has bands)');
    assert.ok(q.includes('<td>30,001</td><td>No limit</td><td>30%</td>'), "to:null renders 'No limit'");
    assert.ok(q.includes('Check the source before use. For information only, not legal or tax advice.'), 'disclaimer');
    // A fact without bands is value text only: no table in spain.
    assert.ok(!/<table\b/.test(s.page('spain')), 'no table when bands are absent');
    assert.ok(!/\sstyle=|<[a-z][^>]*\son[a-z]+=/i.test(h) && !INLINE_SCRIPT.test(h), 'CSP: no inline styles, scripts or handlers (JSON-LD data blocks excepted)');
    assert.ok(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(h), 'no nested links');
  } finally { s.done(); }
});
test('p2_8.render_only_for_listed_countries', () => {
  const s = factsSite();
  try {
    let r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 300));
    const withBox = s.pages().filter(f => /id="key-facts"/.test(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')));
    assert.deepEqual(withBox.sort(), ['france.html', 'spain.html'], 'only listed countries get a box');
    for (const f of ['countries.html', 'glossary.html', 'upcoming.html', 'index.html']) {
      const p = path.join(s.dir, f); if (fs.existsSync(p)) assert.ok(!/id="key-facts"/.test(fs.readFileSync(p, 'utf8')), `${f}: no fact box`);
    }
    r = s.build([]); assert.ok(r.ok, r.out.slice(0, 300));
    for (const f of s.pages()) assert.ok(!/id="key-facts"|fact-disclaimer/.test(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')), `${f}: empty facts.json renders no box at all`);
  } finally { s.done(); }
});
test('p2_8.render_escapes_everything', () => {
  const s = factsSite();
  try {
    const evil = '<img src=x onerror=alert(1)>';
    const data = [fixCountry({
      currency: 'EUR',
      facts: [
        fixFact({ label: 'A <script>alert(1)</script> "label"', value: evil + ' & "q" \'s\'', note: '<b>note</b> & \'n\'', sourceLabel: 'Source: <i>X</i> - "Y"', sourceUrl: 'https://example.org/a"onmouseover="x&y=1' }),
        fixFact({ key: 'taxBands', label: 'Bands', value: 'v', bands: [{ from: '<u>0</u>', to: '"1"', rate: '<b>1%</b>' }, { from: '2', to: null, rate: '&' }] }),
      ],
    })];
    const r = s.build(data); assert.ok(r.ok, 'build (without validate) must succeed on hostile text: ' + r.out.slice(0, 400));
    const h = s.page('france');
    const q = squash(h), box = q.slice(q.indexOf('<section class="key-facts"'), q.indexOf('</section>', q.indexOf('<section class="key-facts"')));
    assert.ok(q.includes('<section class="key-facts"'), 'the Key facts section is rendered for the listed country');
    assert.ok(box.length > 100 && !/<(img|script|b|i|u)\b/i.test(box), 'no raw tags from data inside the box');
    assert.ok(!/<[a-z][^>]*\sonerror=/i.test(h) && !/<[a-z][^>]*\sonmouseover=/i.test(h), 'no injected event-handler attributes');
    assert.ok(squash(h).includes(renderFacts(data[0])), 'every text and attribute value is escaped (& < > " \')');
    assert.ok(h.includes('href="https://example.org/a&quot;onmouseover=&quot;x&amp;y=1"'), 'href is attribute-escaped');
    // A non-https source URL is never rendered as a link (build either refuses or omits it).
    const bad = [fixCountry({ facts: [fixFact({ sourceUrl: 'javascript:alert(1)' })] })];
    const rb = s.build(bad);
    if (rb.ok) assert.ok(!/href="javascript:/i.test(s.page('france')), 'javascript: URL must not become a link');
  } finally { s.done(); }
});
test('p2_8.build_deterministic_and_check_tracks_facts', () => {
  const s = factsSite();
  try {
    let r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 300));
    const snap = () => Object.fromEntries(s.pages().map(f => [f, fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')]));
    const a = snap();
    r = s.run('build-pages.mjs'); assert.ok(r.ok); assert.deepEqual(snap(), a, 'second build is byte-identical');
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, '--check passes right after a build: ' + r.out.slice(0, 300));
    const changed = richFixture(); changed[0].facts[0].value = 'EUR 1,001 gross per month, full-time';
    s.setFacts(changed);
    r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /countries\/france\.html is out of date/.test(r.out) && !/spain\.html is out of date/.test(r.out), '--check must flag only the changed country page: ' + r.out.slice(0, 300));
    // Removing a country from facts.json makes its box stale.
    s.setFacts([richFixture()[1]]);
    r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /countries\/france\.html is out of date/.test(r.out), '--check flags a page whose box was removed');
  } finally { s.done(); }
});
test('p2_8.css_scrolls_tables_inside_container', () => {
  const css = read('legal.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x\s*:\s*auto/, 'legal.css: .table-scroll { overflow-x: auto } so a wide table scrolls inside its own box');
  assert.match(css, /\.table-scroll\s*\{[^}]*max-width\s*:\s*100%/, 'legal.css: .table-scroll { max-width: 100% }');
  assert.match(css, /\.key-facts[^{]*\{[^}]*overflow-wrap\s*:\s*(anywhere|break-word)/, 'legal.css: .key-facts { overflow-wrap: anywhere } so long values and URLs do not widen the page');
  assert.match(css, /\.tax-bands[^{]*\{[^}]*border-collapse/, 'legal.css styles .tax-bands (readable on the dark UI)');
});
test('p2_8.check_links_and_readme', () => {
  const cl = read('scripts/check-links.mjs');
  assert.ok(/data\/facts\.json/.test(cl) && /facts\//.test(cl), 'check-links.mjs probes every facts sourceUrl (labelled facts/<code>/<key>)');
  const readme = read('README.md');
  assert.ok(readme.includes('### Country key facts'), 'README documents the schema under "### Country key facts"');
  const sec = readme.split('### Country key facts')[1].split(/\n##+ /)[0];
  const example = JSON.parse(sec.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.ok(example.facts.some(f => f.bands), 'README example shows a taxBands fact with bands');
  const s = factsSite();
  try { const r = s.validate([example]); assert.ok(r.ok, 'the README example must pass validate.mjs: ' + r.out.slice(0, 400)); } finally { s.done(); }
  for (const re of [/Unknown fields are rejected/, /UTC today plus one day/, /365 days/, /No limit/, /id="key-facts"|#key-facts/, /Check the source before use/]) assert.match(sec, re);
});

// ----- P2-8 real data: data/facts.json (batches 1 to 4: 20 European countries) -----
const loadFacts = () => { assert.ok(fs.existsSync(FACTS_FILE), 'data/facts.json missing'); return JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8')); };
const pageSlug = new Map(CHANGES.map(e => [e.country, P2.slugify(e.name)]));
test('p2_8.data.covers_exactly_the_fact_countries_with_sources', () => {
  const facts = loadFacts(), today = ymd(1);
  assert.ok(Array.isArray(facts));
  assert.deepEqual(facts.map(c => c.code).sort(), Object.keys(FACT_COUNTRIES).sort(), 'facts.json covers exactly the fact-sheet countries (update FACT_COUNTRIES in this test when the next batch lands)');
  for (const c of facts) {
    assert.ok(CODES.has(c.code), `${c.code}: known country code`);
    assert.equal(c.currency, FACT_COUNTRIES[c.code], `${c.code}: currency`);
    assert.ok(isDay(c.asOf) && c.asOf <= today, `${c.code}: asOf`);
    assert.ok(Array.isArray(c.facts) && c.facts.length >= 1, `${c.code}: at least one verified fact`);
    const keys = c.facts.map(f => f.key).filter(k => k !== 'other');
    assert.equal(new Set(keys).size, keys.length, `${c.code}: no duplicate key except 'other'`);
    for (const f of c.facts) {
      const at = `${c.code}/${f.key}`;
      assert.ok(['minimumWage', 'ssEmployer', 'ssEmployee', 'ssCeiling', 'taxBands', 'payFrequency', 'other'].includes(f.key), at + ': key');
      assert.ok(typeof f.label === 'string' && f.label.trim() && typeof f.value === 'string' && f.value.trim(), at + ': label and value');
      assert.match(f.sourceUrl, /^https:\/\/[^\s<>"]+$/, at + ': every fact has an https source');
      assert.match(f.sourceLabel, /^Source: .+ - .+/, at + ': sourceLabel');
      assert.ok(isDay(f.checked) && f.checked <= today, at + ': checked');
      if (f.bands) assert.equal(f.key, 'taxBands', at + ': bands only on taxBands');
    }
  }
});
test('p2_8.pages.key_facts_only_for_fact_countries', () => {
  loadFacts();
  const want = new Set(Object.keys(FACT_COUNTRIES).map(code => `${pageSlug.get(code)}.html`));
  assert.equal(want.size, 20);
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const h = read(`countries/${f}`);
    if (want.has(f)) {
      assert.equal((h.match(/id="key-facts"/g) || []).length, 1, `${f}: one #key-facts heading`);
      assert.ok(h.includes('<h2 id="key-facts">Key facts</h2>'), `${f}: heading`);
    } else assert.ok(!/id="key-facts"|fact-disclaimer|class="fact"/.test(h), `${f}: must not render a fact box`);
  }
  for (const f of ['countries.html', 'glossary.html', 'upcoming.html']) assert.ok(!/id="key-facts"/.test(read(f)), `${f}: no fact box`);
});
test('p2_8.pages.match_data_exactly', () => {
  const facts = loadFacts();
  for (const c of facts) {
    const file = `countries/${pageSlug.get(c.code)}.html`, q = squash(read(file));
    assert.ok(q.includes(renderFacts(c)), `${file}: Key facts section must match data/facts.json per the contract`);
    const sec = q.indexOf('<section class="key-facts"');
    assert.ok(q.indexOf('</h1>') < sec && sec < q.indexOf('<article class="entry"'), `${file}: box between <h1> and first entry`);
    const src = (q.slice(sec, q.indexOf('</section>', sec)).match(/<div class="fact" /g) || []).length;
    assert.equal(src, c.facts.length, `${file}: one .fact per fact`);
    assert.ok(!/\sstyle=/.test(q.slice(sec, q.indexOf('</section>', sec))), `${file}: no inline style in the box`);
  }
});
test('p2_8.pages.build_deterministic_with_real_data', () => {
  const real = loadFacts(), s = factsSite();
  try {
    let r = s.build(real); assert.ok(r.ok, r.out.slice(0, 400));
    const first = Object.fromEntries(s.pages().map(f => [f, fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')]));
    s.build(real);
    for (const f of s.pages()) { assert.equal(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8'), first[f], `${f}: second build identical`); assert.equal(first[f], read('countries/' + f), `${f}: matches the committed page`); }
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, r.out.slice(0, 300));
    r = s.run('validate.mjs');
    // A stale warning is expected exactly when some real fact is older than the validator's limits (checked > 365 days, validFrom > 400 days), so this test never fails merely because time passed.
    const expectWarn = real.some(c => c.facts.some(f => f.checked < ymd(-365) || (f.validFrom && f.validFrom < ymd(-400))));
    assert.ok(r.ok, 'real facts validate: ' + r.out.slice(0, 400));
    assert.equal(/WARNING.*facts/i.test(r.out), expectWarn, 'a facts WARNING appears iff a real fact is stale: ' + r.out.slice(0, 400));
  } finally { s.done(); }
});

// ----- P2-8 review round: hidden/bidi characters, length caps, band order, URL hosts, staleness of validFrom, placement -----
const bidiAndInvisible = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF];
test('p2_8.validate_rejects_invisible_and_bidi_characters', () => {
  const s = factsSite();
  try {
    for (const cp of bidiAndInvisible) {
      const ch = String.fromCharCode(cp), hex = cp.toString(16).toUpperCase();
      const cases = {
        label: [fixFact({ label: 'Min' + ch + 'imum wage' }), /label.*control/],
        value: [fixFact({ value: 'EUR 1' + ch + '000' }), /value.*control/],
        note: [fixFact({ note: 'a' + ch + 'b' }), /note.*control/],
        sourceLabel: [fixFact({ sourceLabel: 'Source: Example - Min' + ch + 'wage' }), /sourceLabel.*control/],
        band: [fixFact({ key: 'taxBands', bands: [{ from: '0', to: null, rate: '1' + ch + '%' }] }), /band.*rate.*control/],
      };
      for (const [name, [fact, re]] of Object.entries(cases)) {
        const r = s.validate([fixCountry({ facts: [fact] })]);
        assert.ok(!r.ok && /facts/i.test(r.out) && re.test(r.out), `U+${hex} in facts ${name} must be rejected: ` + r.out.slice(0, 300));
      }
    }
    // The same characters are rejected in glossary text fields.
    const gl = JSON.parse(read('data/glossary.json'));
    for (const cp of bidiAndInvisible) {
      const ch = String.fromCharCode(cp);
      for (const field of ['expansion', 'definition', 'sourceLabel', 'term']) {
        const bad = gl.map((t, i) => (i === 0 ? { ...t, [field]: t[field].slice(0, 1) + ch + t[field].slice(1) } : t));
        s.setFacts([fixCountry()]);
        fs.writeFileSync(path.join(s.dir, 'data/glossary.json'), JSON.stringify(bad));
        const r = s.run('validate.mjs');
        assert.ok(!r.ok && /glossary/i.test(r.out) && /control/.test(r.out), `U+${cp.toString(16).toUpperCase()} in glossary ${field} must be rejected: ` + r.out.slice(0, 300));
      }
    }
  } finally { s.done(); }
});
test('p2_8.validate_label_caps_and_band_order', () => {
  const s = factsSite();
  const c = fixCountry, f = fixFact;
  try {
    let r = s.validate([c({ facts: [f({ label: 'L'.repeat(200), sourceLabel: 'Source: A - ' + 'x'.repeat(188) })] })]);
    assert.ok(r.ok, 'label and sourceLabel of exactly 200 characters pass: ' + r.out.slice(0, 300));
    r = s.validate([c({ facts: [f({ label: 'L'.repeat(201) })] })]); assert.ok(!r.ok && /facts/i.test(r.out) && /label.*200/.test(r.out), 'label over 200 rejected: ' + r.out.slice(0, 300));
    r = s.validate([c({ facts: [f({ sourceLabel: 'Source: A - ' + 'x'.repeat(189) })] })]); assert.ok(!r.ok && /facts/i.test(r.out) && /sourceLabel.*200/.test(r.out), 'sourceLabel over 200 rejected: ' + r.out.slice(0, 300));
    const tb = bands => [c({ facts: [f({ key: 'taxBands', label: 'Income tax bands', bands })] })];
    r = s.validate(tb([{ from: '0', to: null, rate: '1%' }, { from: '5', to: '9', rate: '2%' }]));
    assert.ok(!r.ok && /facts/i.test(r.out) && /band.*to.*last/.test(r.out), 'a to:null band that is not last is rejected: ' + r.out.slice(0, 300));
    r = s.validate(tb([{ from: '0', to: '5', rate: '1%' }, { from: '6', to: null, rate: '2%' }])); assert.ok(r.ok, 'to:null on the last band passes: ' + r.out.slice(0, 300));
    r = s.validate(tb([{ from: '0', to: '5', rate: '1%' }, { from: '6', to: '9', rate: '2%' }])); assert.ok(r.ok, 'a last band with a limit passes: ' + r.out.slice(0, 300));
  } finally { s.done(); }
});
test('p2_8.validate_rejects_unsafe_source_hosts_and_characters', () => {
  const s = factsSite();
  const BAD = {
    ipv4: 'https://127.0.0.1/x', ipv4_other: 'https://192.168.1.10/x', ipv4_decimal: 'https://2130706433/x', ipv6: 'https://[::1]/x', localhost: 'https://localhost/x',
    sub_localhost: 'https://app.localhost/x', single_label: 'https://intranet/x', non_ascii_path: 'https://example.org/caf' + String.fromCharCode(0xE9),
    non_ascii_host: 'https://exa' + String.fromCharCode(0x3BC) + 'ple.org/x', backtick: 'https://example.org/a' + String.fromCharCode(96) + 'b', apostrophe: "https://example.org/a'b",
  };
  try {
    assert.ok(s.validate([fixCountry({ facts: [fixFact({ sourceUrl: 'https://www.example.org/a/b?c=1&d=2#e' })] })]).ok, 'an ordinary https URL passes');
    const gl = JSON.parse(read('data/glossary.json'));
    for (const [name, url] of Object.entries(BAD)) {
      const r = s.validate([fixCountry({ facts: [fixFact({ sourceUrl: url })] })]);
      assert.ok(!r.ok && /facts/i.test(r.out) && /sourceUrl/.test(r.out), `facts sourceUrl ${name} must be rejected: ` + r.out.slice(0, 300));
      s.setFacts([fixCountry()]);
      fs.writeFileSync(path.join(s.dir, 'data/glossary.json'), JSON.stringify(gl.map((t, i) => (i === 0 ? { ...t, sourceUrl: url } : t))));
      const g = s.run('validate.mjs');
      assert.ok(!g.ok && /glossary/i.test(g.out) && /sourceUrl/.test(g.out), `glossary sourceUrl ${name} must be rejected: ` + g.out.slice(0, 300));
      fs.writeFileSync(path.join(s.dir, 'data/glossary.json'), JSON.stringify(gl));
    }
  } finally { s.done(); }
});
test('p2_8.validate_warns_when_validFrom_is_old', () => {
  const s = factsSite();
  try {
    const warns = o => { const r = s.validate([fixCountry({ facts: [fixFact({ key: 'ssEmployee', ...o })] })]); assert.ok(r.ok, 'an old validFrom never fails validation: ' + r.out.slice(0, 300)); return r.out.split('\n').filter(l => /WARNING/.test(l) && /facts/i.test(l)); };
    const w = warns({ validFrom: ymd(-401), checked: ymd(0) });
    assert.ok(w.length === 1 && /validFrom/.test(w[0]) && /ssEmployee/.test(w[0]) && /400/.test(w[0]), 'validFrom 401 days ago warns, naming facts and the key: ' + w.join(' | '));
    assert.equal(warns({ validFrom: ymd(-399), checked: ymd(0) }).length, 0, 'validFrom 399 days ago does not warn');
    assert.equal(warns({ validFrom: ymd(30), checked: ymd(0) }).length, 0, 'a future validFrom does not warn');
    assert.equal(warns({ checked: ymd(0) }).length, 0, 'no validFrom, no warning');
  } finally { s.done(); }
});
test('p2_8.key_facts_precede_partial_coverage_notice', () => {
  // Keep only the first france entry so the page gets the "Partial coverage" notice.
  const only1 = js => { let seen = false; return js.split('\n').filter(l => { if (!/^\s*\{country:'france'/.test(l)) return true; if (!seen) { seen = true; return true; } return false; }).join('\n'); };
  const s = factsSite(undefined, { appEdit: only1 });
  try {
    const r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 300));
    const q = squash(s.page('france')), h1 = q.indexOf('</h1>'), sec = q.indexOf('<section class="key-facts"'), part = q.indexOf('<p class="partial">'), art = q.indexOf('<article class="entry"');
    assert.ok(part > 0, 'france fixture page shows the partial-coverage notice');
    assert.ok(h1 > 0 && h1 < sec && sec < part && part < art, 'order: h1, Key facts, partial-coverage notice, first entry');
  } finally { s.done(); }
});

// ---------- P3-1: Key facts index page, top navigation, no GitHub repo link, footers ----------
// Contract:
//  keyfacts.html (build-pages.mjs): <title>Key facts by country | Intelligent Payroll</title>, <h1>Key facts by country</h1>, canonical SITE+keyfacts.html,
//    standard head()/header('')/footer('') helpers, legal.css. Intro <p> mentions "sources" and "as of" (dates are per country on its page).
//    Derived from data/facts.json (countries absent from it are absent here; nothing hard-coded). Grouped by region in the same order/labels as
//    countries.html: <h2>Europe <span class="count">(N)</span></h2> (only regions that have facts) then <ul class="countries"> with, per country:
//    <li><a href="countries/<slug>.html#key-facts">FLAG Name</a> <span class="count">CUR</span></li>   (CUR = facts.json currency; flag+name from the changelog data).
//    Listed in sitemap.xml. Escaped, no inline script/style/handlers.
//  Generated header (every generated page, incl. countries/*.html with '../'):
//    <header><a ...>Intelligent Payroll</a> <a class="nav" href="[../]countries.html">All countries</a> <a class="nav" href="[../]keyfacts.html">Key facts</a> <a class="nav" href="[../]glossary.html">Glossary</a></header>
//  Generated footer: adds <a href="[../]keyfacts.html">Key facts</a> (next to Glossary). Footers have no link to the GitHub repo root nor "View source";
//    the "Tell us" issues link (github.com/.../issues) stays.
//  legal.css: header must wrap (flex-wrap: wrap) so 4 items fit at 375px.
//  index.html: header nav gets <a href="keyfacts.html" class="nav-link">Key facts</a> and <a href="glossary.html" class="nav-link">Glossary</a> after Changelog
//    (no data-view); footer drops "View source on GitHub"; keeps "Report an error or contact us" (issues URL).
const REPO_ROOT_LINK = /href="https:\/\/github\.com\/ankitbansal2k-ui\/payroll-atlas\/?"/;
const footerOf = h => (h.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
const headerOf = h => (h.match(/<header[\s\S]*?<\/header>/) || [''])[0];
const allGenerated = () => ['countries.html', 'upcoming.html', 'glossary.html', 'privacy.html', 'terms.html', 'suggest.html', 'keyfacts.html', 'minimum-wage-europe.html', 'deadlines.html', ...countryFiles.filter(f => f.endsWith('.html')).map(f => `countries/${f}`)].filter(f => fs.existsSync(path.join(ROOT, f)));
const REGION_LABELS = ['Europe', 'APAC', 'MENAT', 'LATAM', 'Africa'];
const REGION_OF = { europe: 'Europe', apac: 'APAC', menat: 'MENAT', latam: 'LATAM', africa: 'Africa' };
const keyfactsExpect = () => {
  const facts = JSON.parse(read('data/facts.json')), site = loadSite();
  const info = new Map(CHANGES.map(e => [e.country, e]));
  return facts.map(f => { const e = info.get(f.code); return { code: f.code, currency: f.currency, name: e.name, flag: e.flag, slug: P2.slugify(e.name), region: REGION_OF[site.countryToRegion[f.code]] }; });
};

test('p3_1.keyfacts_page_exists_with_head', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'keyfacts.html')), 'keyfacts.html not generated by build-pages.mjs');
  const h = read('keyfacts.html');
  assert.match(h, /<title>Key facts by country \| Intelligent Payroll<\/title>/);
  assert.match(h, /<h1>Key facts by country<\/h1>/);
  assert.match(h, /<link rel="canonical" href="https:\/\/www\.intelligentpayroll\.eu\/keyfacts\.html">/);
  assert.match(h, /<link rel="stylesheet" href="legal\.css">/);
  assert.match(h, /Content-Security-Policy/, 'standard head() CSP');
  assert.ok(!/\son[a-z]+=|\sstyle=/i.test(h) && !INLINE_SCRIPT.test(h), 'CSP: no inline handlers/scripts/styles (JSON-LD data blocks excepted)');
  const intro = (h.match(/<main>[\s\S]*?<\/main>/) || [''])[0].replace(/<[^>]*>/g, ' ');
  assert.match(intro, /sources?/i, 'intro mentions sources');
  assert.match(intro, /as of/i, 'intro explains as-of dates');
});
test('p3_1.keyfacts_page_lists_countries_from_data_grouped_by_region', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'keyfacts.html')), 'keyfacts.html missing');
  const h = read('keyfacts.html'), want = keyfactsExpect();
  const heads = [...h.matchAll(/<h2>(Europe|APAC|MENAT|LATAM|Africa) <span class="count">\((\d+)\)<\/span><\/h2>/g)];
  const present = REGION_LABELS.filter(l => want.some(w => w.region === l));
  assert.deepEqual(heads.map(m => m[1]), present, 'region headings in site order, only regions that have facts');
  for (const m of heads) assert.equal(Number(m[2]), want.filter(w => w.region === m[1]).length, `${m[1]} count`);
  const links = [...h.matchAll(/<li><a href="(countries\/[^"#]+\.html)#key-facts">([^<]*)<\/a> <span class="count">([A-Z]{3})<\/span><\/li>/g)];
  assert.equal(links.length, want.length, 'one <li> per country in facts.json');
  for (const w of want) {
    const l = links.find(x => x[1] === `countries/${w.slug}.html`);
    assert.ok(l, `${w.name}: link`);
    assert.equal(l[2], `${w.flag} ${escH(w.name)}`, `${w.name}: flag and escaped name`);
    assert.equal(l[3], w.currency, `${w.name}: currency`);
    assert.ok(resolves(`countries/${w.slug}.html#key-facts`), `${w.name}: #key-facts anchor exists on the country page`);
    const at = h.indexOf(l[0]), hd = [...heads].filter(m => m.index < at).pop();
    assert.equal(hd && hd[1], w.region, `${w.name}: under ${w.region}`);
  }
});
test('p3_1.keyfacts_page_is_data_driven_fixture', () => {
  const s = factsSite();
  try {
    const r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 300));
    assert.ok(fs.existsSync(path.join(s.dir, 'keyfacts.html')), 'keyfacts.html not generated');
    const h = fs.readFileSync(path.join(s.dir, 'keyfacts.html'), 'utf8');
    const hrefs = [...h.matchAll(/href="(countries\/[^"]+)"/g)].map(m => m[1]).sort();
    assert.deepEqual(hrefs, ['countries/france.html#key-facts', 'countries/spain.html#key-facts'], 'only countries present in facts.json (france, spain) are listed');
    assert.ok(!/Poland|Germany/.test(h), 'no hard-coded countries');
    assert.equal((h.match(/<h2>/g) || []).length, 1, 'only the Europe group (both fixture countries are European)');
    assert.match(fs.readFileSync(path.join(s.dir, 'sitemap.xml'), 'utf8'), /<loc>[^<]*\/keyfacts\.html<\/loc>/);
  } finally { s.done(); }
});
test('p3_1.keyfacts_in_sitemap_and_footers_and_headers', () => {
  assert.match(read('sitemap.xml'), /<loc>https:\/\/www\.intelligentpayroll\.eu\/keyfacts\.html<\/loc>/, 'keyfacts.html in sitemap.xml');
  const gen = allGenerated();
  assert.ok(gen.length > 70);
  for (const f of gen) {
    const d = f.startsWith('countries/') ? '../' : '';
    const hd = headerOf(read(f)), ft = footerOf(read(f));
    assert.ok(hd.includes(`<a class="nav" href="${d}keyfacts.html">Key facts</a>`), `${f}: header Key facts link`);
    assert.ok(hd.includes(`<a class="nav" href="${d}glossary.html">Glossary</a>`), `${f}: header Glossary link`);
    assert.ok(hd.includes(`<a class="nav" href="${d}countries.html">All countries</a>`), `${f}: header All countries kept`);
    assert.ok(ft.includes(`<a href="${d}keyfacts.html">Key facts</a>`), `${f}: footer Key facts link`);
    assert.ok(ft.includes(`<a href="${d}glossary.html">Glossary</a>`), `${f}: footer Glossary link kept`);
  }
});
test('p3_1.generated_header_wraps_at_phone_width', () => {
  const css = read('legal.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...css.matchAll(/(^|\})\s*header\s*\{([^}]*)\}/g)].map(m => m[2]).join(';');
  assert.match(rule, /flex-wrap:\s*wrap/, 'legal.css header needs flex-wrap: wrap for 4 items at 375px');
});
test('p3_1.no_github_repo_link_or_view_source_in_user_facing_footers', () => {
  const idx = read('index.html');
  assert.ok(!REPO_ROOT_LINK.test(idx), 'index.html must not link to the GitHub repository root');
  assert.ok(!/View source/i.test(idx), 'index.html: "View source on GitHub" removed');
  assert.match(footerOf(idx), /<a href="https:\/\/github\.com\/ankitbansal2k-ui\/payroll-atlas\/issues"[^>]*>Report an error or contact us<\/a>/, 'index.html keeps the issues link');
  for (const f of allGenerated()) {
    const ft = footerOf(read(f));
    assert.ok(ft, `${f}: has footer`);
    assert.ok(!REPO_ROOT_LINK.test(ft) && !/View source/i.test(ft), `${f}: footer must not link to the repo root / View source`);
    assert.ok(/href="https:\/\/github\.com\/ankitbansal2k-ui\/payroll-atlas\/issues"[^>]*>Tell us<\/a>/.test(ft), `${f}: footer keeps the "Tell us" issues link`);
  }
});
test('p3_1.index_header_nav_links', () => {
  const idx = read('index.html'), nav = (idx.match(/<header>[\s\S]*?<nav>([\s\S]*?)<\/nav>/) || [])[1] || '';
  const a = [...nav.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(m => ({ attrs: m[1], text: m[2] }));
  assert.deepEqual(a.map(x => x.text), ['Home', 'Changelog', 'Key facts', 'Glossary'], 'nav order');
  for (const [t, href] of [['Key facts', 'keyfacts.html'], ['Glossary', 'glossary.html']]) {
    const x = a.find(y => y.text === t);
    assert.match(x.attrs, new RegExp(`\\bhref="${href}"`), `${t}: real href`);
    assert.match(x.attrs, /\bclass="nav-link"/, `${t}: class nav-link`);
    assert.ok(!/data-view/.test(x.attrs), `${t}: no data-view (real navigation)`);
  }
  assert.match(a[0].attrs, /data-view="view-home"/); assert.match(a[1].attrs, /data-view="view-changelog"/);
});

// ---------- P4-1: on-page SEO (titles, descriptions, JSON-LD, FAQ wording, internal links, sitemap) ----------
// CONTRACT
//  Titles (generated from data, never typed per country; YEAR = year of the last-verified date in app.js; TITLE_MAX = 70):
//    country with a Key facts box : "<Name> payroll <YEAR>: key facts and law changes | Intelligent Payroll"
//    country without              : "<Name> payroll law changes <YEAR> | Intelligent Payroll"
//    If that string is longer than TITLE_MAX the " | Intelligent Payroll" suffix is dropped (deterministic fallback; the
//    brief's 65-character limit cannot hold: the mandated home title is 66 and "Poland payroll 2026: key facts and law changes | ..." is 68).
//    home (index.html)            : "Payroll law changes by country: free tracker | Intelligent Payroll"
//    other generated pages keep their current titles (countries, upcoming, glossary, keyfacts, suggest, privacy, terms).
//  Country description (exact): "<n> tracked payroll change(s) in <Name>: <T><F>. Sources linked, checked <D>."
//    n = entries for the country; "change" when n is 1 else "changes"; T = title of the first entry in page order (non-upcoming first), trailing
//    space/.,;:-dash stripped, then clipped at a word boundary so the whole description is <= 158 characters (no ellipsis);
//    F = ", plus minimum wage, contributions and tax bands" only when the country has a Key facts box; D = last-verified date as "1 October 2026".
//  Every public page (index.html + all generated pages; 404.html excluded, it is noindex): exactly one <title> <= 70 chars, one meta description of
//    70..158 chars that is plain text (no < or >) and ends with ".", one canonical equal to the page URL, exactly one <h1>; og:title/og:description/
//    twitter:title/twitter:description equal title/description; og:url equals the canonical; titles unique, descriptions unique.
//    index.html description is shortened to <= 158 and privacy.html description likewise (both are longer today).
//    build-pages.mjs --check enforces all of this on the generated pages in memory plus index.html, with messages:
//      "<file>: title is N characters (max 70)", "<file>: description is N characters (must be 70 to 158)", "<file>: expected exactly one <h1>, found N",
//      "duplicate title", "duplicate description", "<file>: og:title must equal the <title>" (likewise og:description, twitter:title, twitter:description),
//      "<file>: canonical must be <url>", "index.html: JSON-LD must contain only WebSite and Organization nodes" (P4-2: FAQ structured data was removed on purpose; the visible FAQ stays).
//  JSON-LD: exactly one <script type="application/ld+json">JSON</script> per public page, in <head>, compact JSON of the form
//    {"@context":"https://schema.org","@graph":[node,...]}. Characters < > & U+2028 U+2029 are written as \uXXXX escapes (so the raw block has none of them).
//    index.html: graph = WebSite {@type,name:"Intelligent Payroll",url:SITE,description:<meta description>} + Organization {@type,name,url} (no other keys)
//      and nothing else (P4-2: no FAQPage anywhere; the visible <details class="faq-item"> FAQ stays). No BreadcrumbList on the home page.
//    generated pages (not 404): graph has one BreadcrumbList; ListItem keys exactly @type,position,name,item (positions 1..n, item absolute canonical-origin URL):
//      country: Home > All countries > <Name>; countries.html: Home > All countries; upcoming: Home > What's coming; glossary: Home > Glossary;
//      keyfacts: Home > Key facts; suggest: Home > Suggest a change; privacy: Home > Privacy notice; terms: Home > Terms of use and disclaimer.
//    glossary.html additionally: DefinedTermSet {@type,name:"Payroll terms and abbreviations",url:glossary URL,hasDefinedTerm:[DefinedTerm...]},
//      DefinedTerm keys exactly @type,name(=term),description(=definition),inDefinedTermSet(=glossary URL),url(=glossary URL#term-<slug>), page (A-Z) order.
//    No Dataset (or any other) claims on country pages; Organization has no logo/sameAs.
//  validate.mjs: an inline <script> is rejected unless its type is exactly application/ld+json (message still contains "inline <script>");
//    each ld+json block in index.html must be valid JSON with @context https://schema.org (message contains "JSON-LD").
//  FAQ "Which countries are covered?" answer: "<N> countries today, across Europe (a), APAC (b), MENAT (c), LATAM (d), and Africa (e). <sentence naming the
//    Countries picker, the Key facts and Glossary menu items>" with N, a..e computed from countryToRegion; the stale "country selector in the header" is gone.
//  Country page intro (paragraphs between </h1> and the Key facts box / first entry): always <a href="../glossary.html">Glossary</a> once; only when the
//    country has facts also <a href="#key-facts">Key facts</a> once and a link to ../keyfacts.html once. Related-countries heading becomes
//    <h2 class="more">Related countries in <Region></h2>. keyfacts.html and glossary.html <main> each link to countries.html.
//  sitemap.xml lists exactly the public pages (index + generated, incl. keyfacts.html) each with an ISO lastmod, never 404.html; robots.txt names the sitemap.
const SITE_URL = 'https://www.intelligentpayroll.eu/';
const TITLE_MAX = 70, DESC_MIN = 70, DESC_MAX = 158;
const YEAR = VER22.slice(0, 4);
const fmtLong = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const publicPages = () => ['index.html', ...allGenerated()];
const urlOfPage = f => (f === 'index.html' ? SITE_URL : SITE_URL + f);
const normWs = s => decode(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const oneOf = (h, re, what, f) => { const m = [...h.matchAll(re)]; assert.equal(m.length, 1, `${f}: expected exactly one ${what}, found ${m.length}`); return decode(m[0][1]); };
const seoOf = (h, f) => ({
  title: oneOf(h, /<title>([^<]*)<\/title>/g, '<title>', f),
  desc: oneOf(h, /<meta name="description" content="([^"]*)">/g, 'meta description', f),
  canonical: oneOf(h, /<link rel="canonical" href="([^"]*)">/g, 'canonical link', f),
  ogTitle: oneOf(h, /<meta property="og:title" content="([^"]*)">/g, 'og:title', f),
  ogDesc: oneOf(h, /<meta property="og:description" content="([^"]*)">/g, 'og:description', f),
  ogUrl: oneOf(h, /<meta property="og:url" content="([^"]*)">/g, 'og:url', f),
  twTitle: oneOf(h, /<meta name="twitter:title" content="([^"]*)">/g, 'twitter:title', f),
  twDesc: oneOf(h, /<meta name="twitter:description" content="([^"]*)">/g, 'twitter:description', f),
  h1s: (h.match(/<h1[\s>]/g) || []).length,
});
const trimTail = s => s.replace(/[\s.,;:–—-]+$/, '');
const clipWords = (s, max) => { if (s.length <= max) return s; let cut = s.slice(0, max); if (!/\s/.test(s[max])) cut = cut.replace(/\s*\S*$/, ''); return trimTail(cut); };
const expectedTitle = (name, hasFacts, year = YEAR) => {
  const base = hasFacts ? `${name} payroll ${year}: key facts and law changes` : `${name} payroll law changes ${year}`;
  const full = `${base} | Intelligent Payroll`;
  return full.length <= TITLE_MAX ? full : base;
};
const expectedDesc = (entriesOfCountry, hasFacts, verifiedIso = VER22) => {
  const ordered = [...entriesOfCountry.filter(e => !e.upcoming), ...entriesOfCountry.filter(e => e.upcoming)];
  const n = entriesOfCountry.length;
  const lead = `${n} tracked payroll ${n === 1 ? 'change' : 'changes'} in ${entriesOfCountry[0].name}`;
  const FULL = ', plus minimum wage, contributions and tax bands', SHORT = ', plus contributions and tax bands', end = `. Sources linked, checked ${fmtLong(verifiedIso)}.`;
  // Review rule: clip T at a word boundary, drop trailing stopwords/connectors; omit T if >40% of the title was lost or <12 chars remain.
  const STOPS = ['to', 'by', 'from', 'for', 'with', 'of', 'in', 'on', 'at', 'and', 'or', 'new', 'the', 'a', 'an', 'up', 'as', 'than', 'into', 'per', 'under', 'over', 'earning', 'who', 'that', 'is', 'are', 'be', 'will', 'between', 'after', 'before', 'when'];
  const title = trimTail(ordered[0].title);
  let t = clipWords(title, DESC_MAX - (lead.length + 2) - ((hasFacts ? FULL.length : 0) + end.length));
  if (t.length < title.length) {
    const w = t.split(' ');
    while (w.length && STOPS.includes(w.at(-1).toLowerCase().replace(/[^a-z]/g, ''))) w.pop();
    t = trimTail(w.join(' '));
    if (t.length < 12 || t.length < 0.6 * title.length) t = '';
  }
  const f = hasFacts ? (/minimum wage/i.test(t) ? SHORT : FULL) : '';
  const d = t ? `${lead}: ${t}${f}${end}` : `${lead}${f}${end}`;
  return d.length < DESC_MIN ? `${lead}${f}. Payroll law changes, updated every two weeks. Sources linked, checked ${fmtLong(verifiedIso)}.` : d;
};
const factCodes = () => new Set(JSON.parse(read('data/facts.json')).map(f => f.code));
const ldBlocks = h => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
const ldGraph = (h, f) => {
  const b = ldBlocks(h);
  assert.equal(b.length, 1, `${f}: expected exactly one application/ld+json block, found ${b.length}`);
  const o = JSON.parse(b[0]);
  assert.equal(o['@context'], 'https://schema.org', `${f}: @context`);
  assert.ok(Array.isArray(o['@graph']) && o['@graph'].length >= 1, `${f}: @graph array`);
  return o['@graph'];
};
const byType = (g, t) => g.filter(n => n['@type'] === t);
const keysOf = o => Object.keys(o).sort().join(',');
const ldStrings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) ldStrings(x, out); return out; };
const slugToCode = new Map(CHANGES.map(e => [P2.slugify(e.name), e.country]));
const countryEntries = code => CHANGES.filter(e => e.country === code);
// P4-3: pages built from data files are dated by THEIR data (newest 'checked'), not by the site-wide LAST_VERIFIED.
const maxIso = a => a.reduce((m, x) => (x > m ? x : m), '0000-00-00');
const mwDateOf = (facts, fallback) => { const d = []; for (const c of facts) for (const f of c.facts || []) if (f.key === 'minimumWage' && f.headline) d.push(f.checked); return d.length ? maxIso(d) : fallback; };
const kfDateOf = (facts, fallback) => { const d = []; for (const c of facts) for (const f of c.facts || []) d.push(f.checked); return d.length ? maxIso(d) : fallback; };
const countryModOf = (facts, code, lv) => maxIso([lv, ...(facts.find(c => c.code === code)?.facts || []).map(f => f.checked)]);
const sitemapMod = (xml, file) => { const m = xml.match(new RegExp('<loc>' + (SITE_URL + file).replace(/[.\/]/g, '\\$&') + '</loc><lastmod>([^<]+)</lastmod>')); assert.ok(m, 'sitemap entry for ' + (file || 'home')); return m[1]; };
const inTemp = (s, file, fn) => { const p = path.join(s.dir, file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };

test('p4_1.country_titles_and_descriptions_follow_the_formulas', () => {
  const withFacts = factCodes();
  assert.ok(withFacts.size === 20, 'precondition: 20 fact countries');
  let seenFull = 0;
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const code = slugToCode.get(f.replace(/\.html$/, '')); assert.ok(code, `${f}: country`);
    const s = seoOf(read(`countries/${f}`), f), es = countryEntries(code), has = withFacts.has(code);
    assert.equal(s.title, expectedTitle(es[0].name, has), `${f}: title`);
    assert.equal(s.desc, expectedDesc(es, has), `${f}: description`);
    assert.ok(s.title.length <= TITLE_MAX && s.desc.length >= DESC_MIN && s.desc.length <= DESC_MAX, `${f}: lengths ${s.title.length}/${s.desc.length}`);
    if (s.title.endsWith('| Intelligent Payroll')) seenFull++;
  }
  assert.ok(seenFull > 0, 'short country names keep the brand suffix');
  // The brief's own example query: Poland (facts) is "Poland payroll 2026: key facts and law changes | Intelligent Payroll" (68 chars, within TITLE_MAX).
  assert.equal(seoOf(read('countries/poland.html'), 'poland').title, `Poland payroll ${YEAR}: key facts and law changes | Intelligent Payroll`);
});
test('p4_1.country_description_clipping_rules_hold_for_long_titles', () => {
  // On real data: no ellipsis and exactly one final period, whatever was clipped.
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const code = slugToCode.get(f.replace(/\.html$/, '')), es = countryEntries(code);
    const d = seoOf(read(`countries/${f}`), f).desc, first = [...es.filter(e => !e.upcoming), ...es.filter(e => e.upcoming)][0].title;
    assert.ok(!d.includes('…') && /\.$/.test(d) && !/\.\.$/.test(d), `${f}: no ellipsis, single final period`);
  }
  // Pure helper check of the contract's clipping rule.
  assert.equal(clipWords('alpha beta gamma delta', 12), 'alpha beta');
  assert.equal(clipWords('alpha beta gamma delta', 10), 'alpha beta');
  assert.equal(clipWords('alpha beta gamma delta', 11), 'alpha beta');
  assert.equal(clipWords('alpha beta, gamma', 11), 'alpha beta');
});
// Independent of the generator rule: the finished sentence must read cleanly on every real country page.
test('p4_1.country_descriptions_read_cleanly_on_all_pages', () => {
  const files = countryFiles.filter(f => f.endsWith('.html')); assert.equal(files.length, 75);
  for (const f of files) {
    const d = seoOf(read(`countries/${f}`), f).desc;
    assert.match(d, /^\d+ tracked payroll changes? in .+\. Sources linked, checked \d{1,2} \w+ \d{4}\.$/, `${f}: shape: ${d}`);
    assert.ok(!/\b(to|by|from|for|with|of|in|on|at|and|or|new|the|a|an|up)\s*(,|:|;)\s*plus/i.test(d), `${f}: cut mid-phrase before ", plus": ${d}`);
    assert.ok((d.match(/minimum wage/gi) || []).length <= 1, `${f}: "minimum wage" repeated: ${d}`);
    assert.ok(!/\b(to|by|from|for|with|of|in|on|at|and|or|new|the|a|an|up)\.\s+Sources/i.test(d), `${f}: ends mid-phrase: ${d}`);
    assert.ok(d.length >= DESC_MIN && d.length <= DESC_MAX, `${f}: length ${d.length}`);
  }
});
test('p4_1.country_page_crumb_is_home_all_countries_name', () => {
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const h = read(`countries/${f}`), m = h.match(/<p class="crumbs">([^]*?)<\/p>/);
    assert.ok(m, `${f}: crumbs`);
    assert.match(m[1], /^<a href="\.\.\/">Home<\/a> &rsaquo; <a href="\.\.\/countries\.html">All countries<\/a> &rsaquo; [^<]+$/, `${f}: crumb markup`);
    assert.equal(decode(m[1].split('&rsaquo; ').pop()), h.match(/<h1>[^ ]+ ([^<]*): payroll law changes<\/h1>/) ? decode(h.match(/<h1>[^ ]+ ([^<]*): payroll law changes<\/h1>/)[1]) : null, `${f}: last crumb is the country name`);
  }
});
test('p4_1.home_and_other_generated_pages_keep_short_unique_titles', () => {
  const want = {
    'index.html': 'Payroll law changes by country: free tracker | Intelligent Payroll',
    'countries.html': 'All countries | Intelligent Payroll',
    'upcoming.html': "What's coming: upcoming payroll changes | Intelligent Payroll",
    'glossary.html': 'Glossary: payroll terms and abbreviations | Intelligent Payroll',
    'keyfacts.html': 'Key facts by country | Intelligent Payroll',
    'suggest.html': 'Suggest a change | Intelligent Payroll',
    'privacy.html': 'Privacy notice | Intelligent Payroll',
    'terms.html': 'Terms of use and disclaimer | Intelligent Payroll',
  };
  for (const [f, t] of Object.entries(want)) assert.equal(seoOf(read(f), f).title, t, `${f}: title`);
});
test('p4_1.every_public_page_meets_the_seo_rules_and_is_unique', () => {
  const pages = publicPages(); assert.ok(pages.length > 80, `public pages: ${pages.length}`);
  const titles = new Map(), descs = new Map();
  for (const f of pages) {
    const h = read(f), s = seoOf(h, f), url = urlOfPage(f);
    assert.ok(s.title.length > 0 && s.title.length <= TITLE_MAX && s.title === s.title.trim(), `${f}: title is ${s.title.length} characters (max ${TITLE_MAX}): ${s.title}`);
    assert.ok(s.desc.length >= DESC_MIN && s.desc.length <= DESC_MAX, `${f}: description is ${s.desc.length} characters (must be ${DESC_MIN} to ${DESC_MAX})`);
    assert.ok(!/[<>]/.test(s.desc) && /\.$/.test(s.desc) && s.desc === s.desc.trim(), `${f}: description is plain text ending with a period`);
    assert.equal(s.canonical, url, `${f}: canonical`);
    assert.equal(s.h1s, 1, `${f}: expected exactly one <h1>, found ${s.h1s}`);
    assert.equal(s.ogTitle, s.title, `${f}: og:title equals title`); assert.equal(s.twTitle, s.title, `${f}: twitter:title equals title`);
    assert.equal(s.ogDesc, s.desc, `${f}: og:description equals description`); assert.equal(s.twDesc, s.desc, `${f}: twitter:description equals description`);
    assert.equal(s.ogUrl, url, `${f}: og:url equals canonical`);
    assert.ok(!titles.has(s.title), `duplicate title "${s.title}" on ${titles.get(s.title)} and ${f}`); titles.set(s.title, f);
    assert.ok(!descs.has(s.desc), `duplicate description on ${descs.get(s.desc)} and ${f}`); descs.set(s.desc, f);
  }
});
test('p4_1.404_is_noindex_and_outside_the_seo_set', () => {
  const h = read('404.html');
  assert.match(h, /<meta name="robots" content="noindex">/);
  assert.ok(!publicPages().includes('404.html'));
  assert.ok(!/404\.html/.test(read('sitemap.xml')), '404.html is not in the sitemap');
  assert.ok(!/Page not found/.test(read('sitemap.xml')));
});

// --- the generator enforces the SEO rules (build-pages.mjs --check), exercised in a temp copy ---
test('p4_1.check_rejects_bad_titles_descriptions_headings_and_duplicates', () => {
  const s = factsSite();
  try {
    const real = JSON.parse(read('data/facts.json'));
    let r = s.build(real); assert.ok(r.ok, r.out.slice(0, 400));
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, 'baseline --check passes: ' + r.out.slice(0, 400));
    const orig = fs.readFileSync(path.join(s.dir, 'index.html'), 'utf8');
    const attempt = (name, fn, re) => {
      fs.writeFileSync(path.join(s.dir, 'index.html'), fn(orig));
      const x = s.run('build-pages.mjs', '--check');
      assert.ok(!x.ok && re.test(x.out), `${name}: --check must fail with ${re}: ` + x.out.slice(0, 500));
    };
    const setTitle = t => h => h.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
    const setDesc = d => h => h.replace(/(<meta name="description" content=")[^"]*"/, `$1${d}"`);
    attempt('title too long', setTitle('x'.repeat(TITLE_MAX + 1)), /index\.html: title is 71 characters \(max 70\)/);
    attempt('duplicate title', setTitle('All countries | Intelligent Payroll'), /duplicate title/);
    attempt('description too short', setDesc('Too short.'), /index\.html: description is 10 characters \(must be 70 to 158\)/);
    attempt('description too long', setDesc('d'.repeat(159)), /index\.html: description is 159 characters \(must be 70 to 158\)/);
    attempt('duplicate description', setDesc(seoOf(read('countries.html'), 'c').desc), /duplicate description/);
    attempt('second h1', h => h.replace('</h1>', '</h1><h1>Another</h1>'), /index\.html: expected exactly one <h1>, found 2/);
    attempt('og:title differs', h => h.replace(/(<meta property="og:title" content=")[^"]*"/, '$1Different"'), /index\.html: og:title must equal the <title>/);
    attempt('twitter:description differs', h => h.replace(/(<meta name="twitter:description" content=")[^"]*"/, '$1Different but long enough to look like a real description of the page, honestly."'), /index\.html: twitter:description must equal the description/);
    fs.writeFileSync(path.join(s.dir, 'index.html'), orig);
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, 'restored index passes again: ' + r.out.slice(0, 300));
  } finally { s.done(); }
});

// --- formulas follow the data, not a hand-typed list (fixture: other facts, other year) ---
test('p4_1.titles_and_descriptions_are_generated_from_data_in_a_fixture', () => {
  const setYear = js => js.replace(/(new Date\(')\d{4}-\d{2}-\d{2}(T)/, (_, a, b) => `${a}2027-02-03${b}`);
  const s = factsSite(undefined, { appEdit: setYear });
  try {
    let r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 400));
    const has = new Set(['france', 'spain']);
    for (const f of s.pages()) {
      const code = slugToCode.get(f.replace(/\.html$/, '')), es = countryEntries(code);
      const x = seoOf(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8'), f);
      assert.equal(x.title, expectedTitle(es[0].name, has.has(code), '2027'), `${f}: title uses the last-verified year 2027 and the facts of THIS data set`);
      assert.equal(x.desc, expectedDesc(es, has.has(code), '2027-02-03'), `${f}: description`);
    }
    assert.ok(seoOf(s.page('poland'), 'poland').title.includes('payroll law changes 2027'), 'poland has no facts in the fixture');
    assert.ok(seoOf(s.page('spain'), 'spain').desc.includes('minimum wage, contributions and tax bands'));
    r = s.run('build-pages.mjs'); assert.ok(r.ok);
    const a = Object.fromEntries(s.pages().map(f => [f, fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')]));
    s.run('build-pages.mjs'); for (const f of s.pages()) assert.equal(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8'), a[f], `${f}: deterministic`);
  } finally { s.done(); }
});

// --- JSON-LD ---
test('p4_1.jsonld_home_has_website_and_organization_only', () => {
  const h = read('index.html'), g = ldGraph(h, 'index.html');
  assert.deepEqual(g.map(n => n['@type']).sort(), ['Organization', 'WebSite'], 'P4-2: index JSON-LD node types are exactly WebSite and Organization');
  const [ws] = byType(g, 'WebSite'), [org] = byType(g, 'Organization');
  assert.equal(keysOf(ws), '@type,description,name,url');
  assert.equal(ws.name, 'Intelligent Payroll'); assert.equal(ws.url, SITE_URL); assert.equal(ws.description, seoOf(h, 'index.html').desc);
  assert.equal(keysOf(org), '@type,name,url', 'Organization: no logo, no sameAs, nothing else');
  assert.equal(org.name, 'Intelligent Payroll'); assert.equal(org.url, SITE_URL);
  assert.equal(byType(g, 'BreadcrumbList').length, 0, 'no breadcrumb on the home page');
});
const faqVisible = h => [...h.matchAll(/<details class="faq-item">\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)].map(m => [normWs(m[1]), normWs(m[2])]);
test('p4_1.no_page_has_faqpage_structured_data_and_visible_faq_stays', () => {
  const vis = faqVisible(read('index.html'));
  assert.ok(vis.length >= 7, `the visible FAQ stays: ${vis.length} items`);
  for (const f of publicPages()) {
    const h = read(f);
    assert.equal(byType(ldGraph(h, f), 'FAQPage').length, 0, `${f}: no FAQPage node`);
    assert.ok(!/FAQPage|"mainEntity"|"acceptedAnswer"/.test(h), `${f}: no FAQ structured data of any kind`);
  }
});
test('p4_1.check_ignores_visible_faq_edits_and_rejects_extra_index_nodes', () => {
  const s = factsSite();
  try {
    let r = s.build(JSON.parse(read('data/facts.json'))); assert.ok(r.ok, r.out.slice(0, 300));
    const orig = fs.readFileSync(path.join(s.dir, 'index.html'), 'utf8');
    // The FAQ text is free to change: --check no longer compares it with any JSON-LD.
    fs.writeFileSync(path.join(s.dir, 'index.html'), orig.replace("Yes. There's no account", 'Yes. There is no account'));
    assert.notEqual(fs.readFileSync(path.join(s.dir, 'index.html'), 'utf8'), orig, 'fixture edit applied');
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, 'visible FAQ edit must pass --check: ' + r.out.slice(0, 400));
    // Anything but WebSite + Organization in the index graph is refused (a FAQPage or any third node).
    for (const node of [{ '@type': 'FAQPage', mainEntity: [] }, { '@type': 'BreadcrumbList', itemListElement: [] }]) {
      fs.writeFileSync(path.join(s.dir, 'index.html'), orig.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/, (_, a, json, c) => { const o = JSON.parse(json); o['@graph'].push(node); return a + JSON.stringify(o) + c; }));
      r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /index\.html: JSON-LD must contain only WebSite and Organization nodes/.test(r.out), `${node['@type']} node in index.html: ` + r.out.slice(0, 400));
    }
    fs.writeFileSync(path.join(s.dir, 'index.html'), orig);
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, r.out.slice(0, 300));
  } finally { s.done(); }
});
const CRUMB_NAMES = { 'countries.html': ['All countries'], 'upcoming.html': ["What's coming"], 'glossary.html': ['Glossary'], 'keyfacts.html': ['Key facts'], 'minimum-wage-europe.html': ['Minimum wage in Europe'], 'deadlines.html': ['Payroll deadlines'], 'suggest.html': ['Suggest a change'], 'privacy.html': ['Privacy notice'], 'terms.html': ['Terms of use and disclaimer'] };
test('p4_1.jsonld_breadcrumbs_on_every_generated_page', () => {
  const pages = allGenerated(); assert.ok(pages.length > 80);
  for (const f of pages) {
    const g = ldGraph(read(f), f), [bc, ...more] = byType(g, 'BreadcrumbList');
    assert.ok(bc && more.length === 0, `${f}: exactly one BreadcrumbList`);
    const isCountry = f.startsWith('countries/');
    const names = isCountry ? ['All countries', countryEntries(slugToCode.get(f.slice(10, -5)))[0].name] : CRUMB_NAMES[f];
    assert.ok(names && names.every(Boolean), `${f}: expected crumb names`);
    const want = [['Home', SITE_URL], ...names.map((n, i) => [n, i === names.length - 1 ? urlOfPage(f) : SITE_URL + 'countries.html'])];
    const got = bc.itemListElement.map((it, i) => {
      assert.equal(keysOf(it), '@type,item,name,position', `${f}: ListItem keys`);
      assert.equal(it['@type'], 'ListItem'); assert.equal(it.position, i + 1, `${f}: positions run 1..n`);
      return [it.name, it.item];
    });
    assert.deepEqual(got, want, `${f}: breadcrumb trail`);
  }
  assert.equal(seoOf(read('countries/poland.html'), 'p').canonical, ldGraph(read('countries/poland.html'), 'p')[0].itemListElement.at(-1).item);
});
test('p4_1.jsonld_glossary_defined_terms_match_data', () => {
  const gl = JSON.parse(read('data/glossary.json')), h = read('glossary.html'), g = ldGraph(h, 'glossary.html');
  const [set] = byType(g, 'DefinedTermSet'); assert.ok(set, 'DefinedTermSet');
  const url = SITE_URL + 'glossary.html';
  assert.equal(keysOf(set), '@type,hasDefinedTerm,name,url'); assert.equal(set.name, 'Payroll terms and abbreviations'); assert.equal(set.url, url);
  const sorted = [...gl].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  assert.equal(set.hasDefinedTerm.length, gl.length, 'one DefinedTerm per glossary term');
  const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  set.hasDefinedTerm.forEach((t, i) => {
    assert.equal(t['@type'], 'DefinedTerm'); assert.equal(keysOf(t), '@type,description,inDefinedTermSet,name,url');
    assert.equal(t.name, sorted[i].term, 'name = term, A-Z order'); assert.equal(t.description, sorted[i].definition, 'description = definition');
    assert.equal(t.inDefinedTermSet, url); assert.equal(t.url, `${url}#term-${P2.slugify(sorted[i].term)}`);
    assert.ok(ids.has(`term-${P2.slugify(sorted[i].term)}`), `${t.name}: anchor exists on the page`);
  });
  for (const f of publicPages().filter(f => f !== 'glossary.html')) assert.equal(byType(ldGraph(read(f), f), 'DefinedTermSet').length, 0, `${f}: no DefinedTermSet`);
});
test('p4_1.jsonld_is_safe_absolute_and_claims_nothing_invented', () => {
  for (const f of publicPages()) {
    const h = read(f), b = ldBlocks(h); assert.equal(b.length, 1, `${f}: one JSON-LD block`);
    assert.ok(!/[<>&\u2028\u2029]/.test(b[0]), `${f}: raw JSON-LD block must have < > & U+2028 U+2029 escaped as \\uXXXX`);
    assert.ok(!INLINE_SCRIPT.test(h), `${f}: no other inline script`);
    const g = ldGraph(h, f);
    for (const n of g) assert.ok(['WebSite', 'Organization', 'BreadcrumbList', 'DefinedTermSet'].includes(n['@type']), `${f}: unexpected node type ${n['@type']} (no Dataset or other invented claims)`);
    const strings = ldStrings(g);
    for (const x of strings) assert.ok(!/^http:\/\//i.test(x), `${f}: http URL ${x}`);
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (['url', 'item', 'inDefinedTermSet'].includes(k)) assert.ok(typeof x === 'string' && x.startsWith(SITE_URL), `${f}: ${k} must be an absolute URL on ${SITE_URL}: ${x}`); walk(x); } };
    walk(g);
    assert.ok(!/"(logo|sameAs|Dataset|aggregateRating|review|offers)"/.test(b[0]), `${f}: no logo/sameAs/Dataset/rating claims`);
  }
});
test('p4_1.jsonld_survives_hostile_data_and_is_deterministic', () => {
  const U2028 = String.fromCharCode(0x2028), U2029 = String.fromCharCode(0x2029);
  const EVIL = `France</script><script>alert(1)</script>${U2028}${U2029} & <!--`;
  const appEdit = js => js.replaceAll("name:'France'", `name:'France</script><script>alert(1)</script>\\u2028\\u2029 & <!--'`)
    .replace("title:'SMIC revalued twice", "title:'</SCRIPT><b>x</b>\\u2028 SMIC revalued twice");
  const s = factsSite(undefined, { appEdit });
  try {
    const evilTerm = { term: 'X</script><script>alert(1)</script>', expansion: 'e', definition: `d </script> ${U2028} ${U2029} & <b>`, countries: [], sourceUrl: 'https://example.org/x', sourceLabel: 'Source: A - B', checked: '2026-10-01' };
    let r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 500));
    fs.writeFileSync(path.join(s.dir, 'data/glossary.json'), JSON.stringify([evilTerm]));
    r = s.run('build-pages.mjs'); assert.ok(r.ok, r.out.slice(0, 500));
    const files = [...s.pages().map(f => `countries/${f}`), 'glossary.html', 'keyfacts.html', 'countries.html', 'upcoming.html'];
    for (const f of files) {
      const h = fs.readFileSync(path.join(s.dir, f), 'utf8'), b = ldBlocks(h);
      assert.equal(b.length, 1, `${f}: one block`); assert.ok(!/[<>&\u2028\u2029]/.test(b[0]), `${f}: block escaped`);
      assert.ok(!INLINE_SCRIPT.test(h), `${f}: hostile data did not create a second inline script`);
      assert.ok(!/<script>alert/i.test(h), `${f}: no injected script element`);
    }
    const franceFile = s.pages().find(f => /^france-/.test(f));
    assert.ok(franceFile, 'hostile country page generated');
    const bc = byType(ldGraph(fs.readFileSync(path.join(s.dir, 'countries', franceFile), 'utf8'), franceFile), 'BreadcrumbList')[0];
    assert.equal(bc.itemListElement.at(-1).name, EVIL, 'hostile name round-trips through JSON.parse unchanged');
    const gset = byType(ldGraph(fs.readFileSync(path.join(s.dir, 'glossary.html'), 'utf8'), 'glossary.html'), 'DefinedTermSet')[0];
    assert.equal(gset.hasDefinedTerm.length, 1); assert.equal(gset.hasDefinedTerm[0].name, evilTerm.term); assert.equal(gset.hasDefinedTerm[0].description, evilTerm.definition);
    // deterministic + --check covers the JSON-LD
    const snap = () => Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(s.dir, f), 'utf8')]));
    const a = snap(); s.run('build-pages.mjs'); assert.deepEqual(snap(), a, 'second build byte-identical');
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, r.out.slice(0, 400));
    inTemp(s, 'glossary.html', h => h.replace(/"name":"Glossary"/, '"name":"Glossary tampered"'));
    r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /glossary\.html is out of date/.test(r.out), '--check flags a tampered JSON-LD block: ' + r.out.slice(0, 300));
  } finally { s.done(); }
});

// --- validate.mjs: only JSON-LD may be inline ---
test('p4_1.validate_allows_only_jsonld_inline_scripts', () => {
  const s = factsSite();
  try {
    const run = () => s.run('validate.mjs');
    const orig = fs.readFileSync(path.join(s.dir, 'index.html'), 'utf8');
    const put = (html) => fs.writeFileSync(path.join(s.dir, 'index.html'), html);
    const addHead = tag => put(orig.replace('</head>', `${tag}\n</head>`));
    let r = run(); assert.ok(r.ok, 'baseline: ' + r.out.slice(0, 300));
    assert.equal(ldBlocks(orig).length, 1, 'real index.html carries its JSON-LD block');
    const ok = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x","url":"https://www.intelligentpayroll.eu/"}]}</script>';
    put(orig.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ok)); r = run(); assert.ok(r.ok, 'a valid ld+json block passes: ' + r.out.slice(0, 300));
    for (const [name, tag] of Object.entries({
      plain: '<script>alert(1)</script>',
      js_type: '<script type="text/javascript">alert(1)</script>',
      module: '<script type="module">alert(1)</script>',
      json_type: '<script type="application/json">{}</script>',
      ld_lookalike: '<script type="application/ld+json2">{}</script>',
      ld_with_extra_type_text: '<script type="text/plain application/ld+json">{}</script>',
      ld_with_handler: '<script type="application/ld+json" onload="alert(1)">{}</script>',
    })) {
      addHead(tag); r = run();
      assert.ok(!r.ok && /inline <script>|inline event handler/.test(r.out), `${name}: must be rejected: ` + r.out.slice(0, 300));
    }
    // A valid JSON-LD block does not excuse a second, executable one.
    put(orig.replace('</head>', '<script>alert(1)</script>\n</head>')); r = run(); assert.ok(!r.ok && /inline <script>/.test(r.out), 'ld+json present + plain inline script: still rejected');
    // JSON-LD content must parse and carry the schema.org context.
    put(orig.replace(/(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/, '$1{ not json $2')); r = run(); assert.ok(!r.ok && /JSON-LD/.test(r.out), 'invalid JSON-LD rejected: ' + r.out.slice(0, 300));
    put(orig.replace(/(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/, '$1{"@context":"https://evil.example/","@graph":[]}$2')); r = run(); assert.ok(!r.ok && /JSON-LD/.test(r.out), 'wrong @context rejected: ' + r.out.slice(0, 300));
    put(orig); r = run(); assert.ok(r.ok);
  } finally { s.done(); }
});

// --- FAQ wording ---
test('p4_1.faq_countries_answer_uses_current_wording_and_data_counts', () => {
  const { countryToRegion } = loadSite();
  const counts = {}; for (const r of Object.values(countryToRegion)) counts[r] = (counts[r] || 0) + 1;
  const vis = faqVisible(read('index.html')), hit = vis.find(([q]) => q === 'Which countries are covered?'); assert.ok(hit, 'FAQ item exists');
  const a = hit[1];
  const m = a.match(/^(\d+) countries today, across Europe \((\d+)\), APAC \((\d+)\), MENAT \((\d+)\), LATAM \((\d+)\), and Africa \((\d+)\)\./);
  assert.ok(m, 'sentence shape: ' + a);
  assert.deepEqual(m.slice(1).map(Number), [Object.keys(countryToRegion).length, counts.europe, counts.apac, counts.menat, counts.latam, counts.africa], 'numbers equal region counts from countryToRegion');
  assert.equal(Number(m[1]), m.slice(2).reduce((x, y) => x + Number(y), 0), 'regions add up to the total');
  assert.ok(/Countries picker/.test(a) && /Key facts/.test(a) && /Glossary/.test(a), 'mentions the Countries picker, Key facts and Glossary menu items: ' + a);
  assert.ok(!/country selector in the header/i.test(a) && !/see the full list/i.test(a), 'stale wording removed');
  const idx = read('index.html');
  assert.ok(/<summary id="country-picker-summary">Countries<\/summary>/.test(idx), 'a Countries picker exists');
  assert.ok(/<a href="keyfacts\.html" class="nav-link">Key facts<\/a>/.test(idx) && /<a href="glossary\.html" class="nav-link">Glossary<\/a>/.test(idx), 'Key facts and Glossary menu items exist');
});

// --- internal linking ---
const introOf = h => { const a = h.indexOf('</h1>'), ends = ['<section class="key-facts"', '<p class="partial">', '<article class="entry"'].map(x => h.indexOf(x)).filter(i => i > a); return h.slice(a, Math.min(...ends)); };
test('p4_1.country_intro_links_key_facts_only_with_facts_and_glossary_always', () => {
  const withFacts = factCodes(), count = (s, x) => s.split(x).length - 1;
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const h = read(`countries/${f}`), intro = introOf(h), has = withFacts.has(slugToCode.get(f.replace(/\.html$/, '')));
    assert.equal(count(intro, '<a href="../glossary.html">Glossary</a>'), 1, `${f}: intro links the Glossary once`);
    assert.equal(count(intro, '<a href="#key-facts">Key facts</a>'), has ? 1 : 0, `${f}: intro Key facts anchor link iff facts`);
    assert.equal(count(intro, 'href="../keyfacts.html"'), has ? 1 : 0, `${f}: intro link to ../keyfacts.html iff facts`);
    assert.equal(/id="key-facts"/.test(h), has);
    for (const m of intro.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]; if (/^(https?:|webcal:)/.test(href) || href.startsWith('../?') || href.endsWith('.ics')) continue;
      if (href.startsWith('#')) assert.ok(pageIds.get(`countries/${f}`).has(href.slice(1)), `${f}: ${href} exists`);
      else assert.ok(fs.existsSync(path.join(ROOT, 'countries', href.split('#')[0])), `${f}: link target ${href} exists`);
    }
  }
});
test('p4_1.related_countries_in_region_and_back_links_resolve', () => {
  const { countryToRegion } = loadSite(), names = new Map(CHANGES.map(e => [e.country, e.name]));
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const code = slugToCode.get(f.replace(/\.html$/, '')), region = REGION_OF[countryToRegion[code]], h = read(`countries/${f}`);
    assert.ok(h.includes(`<h2 class="more">Related countries in ${region}</h2>`), `${f}: heading "Related countries in ${region}"`);
    const chips = (h.match(/<p class="chips">([\s\S]*?)<\/p>/) || [])[1] || '';
    const hrefs = [...chips.matchAll(/<a href="([^"]+)">/g)].map(m => m[1]);
    const want = [...new Set(CHANGES.filter(e => countryToRegion[e.country] === countryToRegion[code] && e.country !== code).map(e => e.country))].map(c => `${P2.slugify(names.get(c))}.html`).sort();
    assert.deepEqual([...hrefs].sort(), want, `${f}: chips are the other countries of ${region}`);
    for (const x of hrefs) assert.ok(countryFiles.includes(x), `${f}: ${x} exists`);
  }
  for (const f of ['keyfacts.html', 'glossary.html']) {
    const main = (read(f).match(/<main>[\s\S]*?<\/main>/) || [''])[0];
    assert.ok(main.includes('href="countries.html"'), `${f}: main content links back to countries.html`);
    for (const m of main.matchAll(/href="(countries\/[^"]+)"/g)) assert.ok(resolves(m[1]), `${f}: ${m[1]} resolves`);
  }
});

// --- sitemap and robots ---
test('p4_1.sitemap_lists_exactly_the_public_pages_with_lastmod_and_robots_points_to_it', () => {
  const x = read('sitemap.xml'), entries = [...x.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/g)];
  assert.equal(entries.length, (x.match(/<url>/g) || []).length, 'every <url> has loc and lastmod');
  assert.deepEqual(entries.map(e => e[1]).sort(), publicPages().map(urlOfPage).sort(), 'sitemap = index + every generated page (incl. keyfacts.html), nothing else (no 404.html)');
  for (const [, loc, mod] of entries) assert.ok(isDay(mod), `${loc}: lastmod ${mod}`);
  assert.equal(entries.find(e => e[1] === SITE_URL + 'keyfacts.html')[2], kfDateOf(loadFacts(), VER22), 'keyfacts.html lastmod = newest checked date over ALL facts (P4-3; was LAST_VERIFIED)');
  const rb = read('robots.txt');
  assert.match(rb, /^Sitemap: https:\/\/www\.intelligentpayroll\.eu\/sitemap\.xml$/m); assert.ok(!/^\s*Disallow:\s*\/\s*$/m.test(rb), 'robots.txt does not block the site');
});

// ---------- P4-2: minimum-wage-europe.html (comparison table built ONLY from data/facts.json) + minimumWage `headline` ----------
// CONTRACT
//  data/facts.json: a key 'minimumWage' fact may carry an OPTIONAL `headline` (nowhere else; unknown keys rejected):
//    {amount:"13.90", period:"hour"|"month", scope:"age 21 and over"}      amount form
//    {statutory:false}                                                      no statutory national minimum
//  - amount: string matching /^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/; REQUIRED unless statutory:false. period: "hour"|"month", required with amount.
//    scope: required with amount, plain text, trimmed, <=60 chars, no < > control/bidi/invisible chars.
//  - statutory, when present, must be exactly false and then amount, period and scope must be absent.
//  - Drift guard: the amount must appear in the fact's `value` text. NORMALISATION (deterministic; the same function is applied to the amount and to every value token):
//      1. tokens = value.match(/\d+(?:[.,]\d+)*/g): maximal digit runs joined by "." or ",". A trailing sentence dot is not part of a token, and "113.90" is ONE token (never a hit for 13.90).
//      2. separators in a token: if it contains BOTH "." and ",", the LAST separator is the decimal mark and all others are thousands marks; if it contains one kind: two or more = thousands marks;
//         exactly one = a thousands mark when exactly 3 digits follow it, otherwise the decimal mark.
//      3. canonical form = integer digits (thousands marks removed, leading zeros dropped) + "." + fraction digits without trailing zeros (no "." when the fraction is empty).
//      4. hit when canonical(token) === canonical(amount). Spaces and NBSP are NOT separators ("1 221" is the two tokens 1 and 221).
//    Hits: 13.90 in 13.90, 13,90, 13.9, "EUR 13.90."; 1,867.02 in 1.867,02 and 1,867.02; 1,221 in 1221, 1.221, 1,221.00; 8 in 8.00.
//    Misses: 13.90 in 113.90, 13.09, 1,390, 1.390, 13.900, 3.90, 13.91, 13, "13 90"; 1,390 in 13.90; 15 in 1.5; 1 in 12.
//  - Messages (all contain "facts" and start with "headline ..."): "headline is only allowed on a minimumWage fact", "headline must be an object",
//    "headline unknown field "x"", "headline amount is required unless statutory is false", "headline amount must be digits ...",
//    "headline amount "13.90" does not appear in value", "headline period ...", "headline scope ..." (plain text / control / 60), "headline statutory ...".
//  minimum-wage-europe.html (build-pages.mjs): title "Minimum wage in Europe <YEAR>: statutory rates by country | Intelligent Payroll" with the suffix dropped when
//    longer than 70 (it is 77 long, so the shipped title is the 55-character base: same deterministic rule as the country pages); description 70..158, ends with ".",
//    contains the number of table rows; canonical SITE+minimum-wage-europe.html; og/twitter; JSON-LD BreadcrumbList Home > "Minimum wage in Europe"; one h1;
//    in sitemap.xml (lastmod = last verified); standard header (NO new nav item) and footer; footer of every generated page gets
//    <a href="[../]minimum-wage-europe.html">Minimum wage</a> between Key facts and Glossary; keyfacts.html <main> links to it once; index.html header unchanged,
//    index.html footer nav (<nav class="footer-links">) gets <a href="minimum-wage-europe.html">Minimum wage</a> right after <a href="glossary.html">Glossary</a> (the only link on index.html).
//    The page <main> links to keyfacts.html and countries.html.
//  Body: intro <p> (mentions statutory minimum, "as stated by", "not converted", "hours worked", "check the source"); then, if any row, exactly
//    <div class="table-scroll" tabindex="0" role="region" aria-label="Minimum wage by country table"><table class="min-wage"><caption>Statutory minimum wage by country, <YEAR>: ...</caption>
//    <thead><tr><th scope="col">Country</th>Currency Monthly Hourly "Applies to" "Valid from" Source</tr></thead><tbody>rows</tbody></table></div>
//    row (countries with a minimumWage fact whose headline has no statutory:false, sorted by name.localeCompare):
//    <tr><th scope="row"><a href="countries/<slug>.html#key-facts">FLAG Name</a></th><td>CUR</td><td>monthly</td><td>hourly</td><td>scope</td><td>valid from</td><td><a href="sourceUrl" rel="noopener">sourceLabel</a></td></tr>
//    monthly/hourly cell = "CUR amount" (amount exactly as stored) in the column of its period, else "—" (U+2014); valid from = long en-GB date or "—".
//    Then, if any statutory:false: <h2 id="no-statutory-minimum">No statutory national minimum wage</h2><ul class="no-min-wage"> one
//    <li><a href="countries/<slug>.html#key-facts">FLAG Name</a>: <value text>[ <span class="note"><note></span>] &middot; <a href="sourceUrl" rel="noopener">sourceLabel</a></li> per country (sorted; the span only when the fact has a note), all text escaped & < > " '.
const MW_FILE = 'minimum-wage-europe.html';
const MW_BASE = year => `Minimum wage in Europe ${year}: statutory rates by country`;
const expectedMwTitle = (year = YEAR) => { const full = `${MW_BASE(year)} | Intelligent Payroll`; return full.length <= TITLE_MAX ? full : MW_BASE(year); };
const mwInfo = new Map(CHANGES.map(e => [e.country, e]));
const renderMinWage = facts => {
  const items = [];
  for (const c of facts) {
    const f = c.facts.find(x => x.key === 'minimumWage' && x.headline); if (!f) continue;
    const e = mwInfo.get(c.code); items.push({ c, f, h: f.headline, name: e.name, flag: e.flag, slug: P2.slugify(e.name) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  const link = i => `<a href="countries/${i.slug}.html#key-facts">${i.flag} ${escH(i.name)}${i.h.region ? ` (${escH(i.h.region)})` : ''}</a>`;
  const src = i => `<a href="${escH(i.f.sourceUrl)}" rel="noopener">${escH(i.f.sourceLabel)}</a>`;
  const cell = (i, p) => (i.h.period === p ? `${escH(i.c.currency)} ${escH(i.h.amount)}` : '—');
  const rows = items.filter(i => i.h.statutory !== false).map(i => `<tr><th scope="row">${link(i)}</th><td>${escH(i.c.currency)}</td><td>${cell(i, 'month')}</td><td>${cell(i, 'hour')}</td><td>${escH(i.h.scope)}</td><td>${i.f.validFrom ? longDay(i.f.validFrom) : '—'}</td><td>${src(i)}</td></tr>`);
  const none = items.filter(i => i.h.statutory === false).map(i => `<li>${link(i)}: ${escH(i.f.value)}${i.f.note ? ` <span class="note">${escH(i.f.note)}</span>` : ''} &middot; ${src(i)}</li>`);
  return { rows, none, count: rows.length };
};
const MW_THEAD = '<thead><tr><th scope="col">Country</th><th scope="col">Currency</th><th scope="col">Monthly</th><th scope="col">Hourly</th><th scope="col">Applies to</th><th scope="col">Valid from</th><th scope="col">Source</th></tr></thead>';
const mwParts = html => {
  const q = squash(html), main = (q.match(/<main>[\s\S]*<\/main>/) || [''])[0];
  const t = main.match(/<div class="table-scroll" tabindex="0" role="region" aria-label="([^"]*)"><table class="min-wage"><caption>([^<]*)<\/caption>(<thead>[\s\S]*?<\/thead>)<tbody>([\s\S]*?)<\/tbody><\/table><\/div>/);
  const u = main.match(/<h2 id="no-statutory-minimum">([^<]*)<\/h2>[\s\S]*?<ul class="no-min-wage">([\s\S]*?)<\/ul>/);
  return { q, main, table: t && { label: t[1], caption: t[2], thead: t[3], rows: t[4].match(/<tr>.*?<\/tr>/g) || [] }, none: u && { heading: u[1], items: u[2].match(/<li>.*?<\/li>/g) || [] } };
};
const assertMwMatches = (html, facts, what) => {
  const want = renderMinWage(facts), got = mwParts(html);
  if (want.rows.length) { assert.ok(got.table, `${what}: table.min-wage inside .table-scroll`); assert.equal(got.table.thead, MW_THEAD, `${what}: header cells`); assert.deepEqual(got.table.rows, want.rows, `${what}: one row per country with a headline amount, sorted by name, exactly per the contract`); } else assert.ok(!got.table, `${what}: no table without rows`);
  if (want.none.length) { assert.ok(got.none, `${what}: no-statutory section`); assert.equal(got.none.heading, 'No statutory national minimum wage'); assert.deepEqual(got.none.items, want.none, `${what}: no-statutory items`); } else assert.ok(!got.none, `${what}: no no-statutory section when none`);
  return got;
};
const mwFixture = () => [
  fixCountry({ facts: [fixFact({ validFrom: '2026-01-01', headline: { amount: '1,000', period: 'month', scope: 'full-time, age 18 and over', region: 'Test & "x"' } })] }),
  fixCountry({ code: 'spain', facts: [fixFact({ value: 'No statutory national minimum wage; pay is set by collective agreements', note: 'Sectoral agreements set the floors & "minimums".', sourceUrl: 'https://example.org/es?a=1&b=2', sourceLabel: 'Source: Example - No statutory minimum', headline: { statutory: false } })] }),
];
const mwSorting = () => [
  fixCountry({ code: 'spain', currency: 'EUR', facts: [fixFact({ value: 'EUR 8.50 per hour', headline: { amount: '8.50', period: 'hour', scope: 'all employees' } })] }),
  fixCountry({ code: 'poland', currency: 'PLN', facts: [fixFact({ value: 'No statutory minimum', headline: { statutory: false } })] }),
  fixCountry({ code: 'germany', currency: 'EUR', facts: [fixFact({ value: 'EUR 13,90 per hour; EUR 2,411 per month', validFrom: '2026-01-01', headline: { amount: '13.90', period: 'hour', scope: 'age 18 and over' } })] }),
  fixCountry({ code: 'italy', currency: 'EUR', facts: [fixFact({ value: 'No statutory minimum, collective agreements', headline: { statutory: false } })] }),
  fixCountry({ code: 'france', currency: 'EUR', facts: [fixFact({ value: 'EUR 1,867.02 per month', headline: { amount: '1,867.02', period: 'month', scope: 'full-time' } })] }),
];
const hlCountry = (headline, value = 'EUR 13.90 gross per hour (age 21 and over); EUR 1,221 per month', extra = {}) => [fixCountry({ facts: [fixFact({ value, headline, ...extra })] })];
// Independent reference of the value-text normalisation (contract above), used on the real data.
const canonNum = t => {
  const seps = [...t.matchAll(/[.,]/g)].map(m => ({ ch: m[0], at: m.index }));
  let dec = -1;
  if (seps.length) { const last = seps.at(-1); if (new Set(seps.map(x => x.ch)).size === 2) dec = last.at; else if (seps.length === 1 && t.length - last.at - 1 !== 3) dec = last.at; }
  const ip = (dec < 0 ? t : t.slice(0, dec)).replace(/[.,]/g, '').replace(/^0+(?=\d)/, ''), fp = dec < 0 ? '' : t.slice(dec + 1).replace(/0+$/, '');
  return fp ? `${ip}.${fp}` : ip;
};
const amountInValue = (amount, value) => (value.match(/\d+(?:[.,]\d+)*/g) || []).some(t => canonNum(t) === canonNum(amount));

test('p4_2.reference_normalisation_hits_and_misses', () => {
  for (const [a, v] of [['13.90', 'EUR 13.90 per hour'], ['13.90', '13,90 EUR'], ['13.9', 'EUR 13.90'], ['13.90', 'EUR 13.9'], ['1,867.02', 'EUR 1.867,02 a month'], ['1,867.02', 'EUR 1,867.02'], ['1,221', 'EUR 1221'], ['4806', '4,806 zl'], ['1,221', 'EUR 1,221.00'], ['1,221', 'EUR 1.221'], ['13.90', 'EUR 13.90.'], ['8', 'EUR 8.00 per hour'], ['0.5', 'EUR 0,50'], ['13.90', 'EUR 7.05 and EUR 13.90']]) assert.ok(amountInValue(a, v), `hit expected: ${a} in "${v}"`);
  for (const [a, v] of [['13.90', 'EUR 113.90'], ['13.90', 'EUR 13.09'], ['13.90', 'EUR 1,390'], ['13.90', 'EUR 3.90'], ['13.90', 'EUR 13.91'], ['13.90', 'EUR 13 per hour'], ['13.90', 'in 2026, no amount'], ['1,221', 'EUR 12,210'], ['1,390', 'EUR 13.90'], ['13.90', 'EUR 1.390'], ['13.90', 'EUR 13.900'], ['15', 'EUR 1.5'], ['1', 'EUR 12'], ['13.90', 'EUR 13 90']]) assert.ok(!amountInValue(a, v), `miss expected: ${a} in "${v}"`);
});

test('p4_2.validate_accepts_valid_headlines', () => {
  const s = factsSite();
  try {
    const ok = (name, data) => { const r = s.validate(data); assert.ok(r.ok, `${name} must pass: ` + r.out.slice(0, 500)); };
    ok('hourly amount', hlCountry({ amount: '13.90', period: 'hour', scope: 'age 21 and over' }));
    ok('monthly with thousands comma', hlCountry({ amount: '1,221', period: 'month', scope: 'full-time' }));
    ok('amount 13.9 vs value 13.90', hlCountry({ amount: '13.9', period: 'hour', scope: 'x' }));
    ok('amount vs European comma form', hlCountry({ amount: '13.90', period: 'hour', scope: 'x' }, 'EUR 13,90 brutto per hour'));
    ok('thousands vs European thousands', hlCountry({ amount: '1,867.02', period: 'month', scope: 'full-time' }, '€1.867,02 per month'));
    ok('thousands comma vs European dot thousands', hlCountry({ amount: '1,500', period: 'month', scope: 'full-time' }, 'EUR 1.500 per month'));
    ok('trailing zeros ignored', hlCountry({ amount: '8', period: 'hour', scope: 'x' }, 'EUR 8.00 per hour'));
    ok('plain integer vs thousands in value', hlCountry({ amount: '4806', period: 'month', scope: 'full-time' }, '4,806 zł gross per month'));
    ok('scope of exactly 60 chars', hlCountry({ amount: '13.90', period: 'hour', scope: 'x'.repeat(60) }));
    ok('region (regional minimum)', hlCountry({ amount: '13.90', period: 'hour', scope: 'cantonal minimum', region: 'Geneva' }));
    ok('region of exactly 40 chars', hlCountry({ amount: '13.90', period: 'hour', scope: 'x', region: 'r'.repeat(40) }));
    ok('period hour next to hourly wording', hlCountry({ amount: '31.40', period: 'hour', scope: 'x' }, '4,806 zl gross per month; minimum hourly rate 31.40 zl'));
    ok('period month with a/per month wording', hlCountry({ amount: '1,000', period: 'month', scope: 'x' }, 'EUR 1,000 a month'));
    ok('statutory false', hlCountry({ statutory: false }, 'No statutory national minimum wage; collective agreements apply'));
    ok('country without any headline stays valid', [fixCountry()]);
    ok('mixed fixture', mwFixture());
    ok('sorting fixture', mwSorting());
  } finally { s.done(); }
});
test('p4_2.validate_rejects_bad_headlines', () => {
  const s = factsSite();
  const good = { amount: '13.90', period: 'hour', scope: 'age 21 and over' };
  const H = (o, value) => hlCountry({ ...good, ...o }, value);
  const noKey = (o, k) => { const { [k]: _, ...rest } = o; return rest; };
  const cases = {
    on_other_key: [[fixCountry({ facts: [fixFact({ key: 'ssEmployer', label: 'Employer', headline: good })] })], /headline is only allowed on a minimumWage fact/],
    not_object: [hlCountry('13.90'), /headline must be an object/],
    array: [hlCountry([]), /headline must be an object/],
    null_value: [hlCountry(null), /headline must be an object/],
    unknown_key: [H({ extra: 1 }), /headline unknown field "extra"/],
    unknown_key_currency: [H({ currency: 'EUR' }), /headline unknown field "currency"/],
    empty_object: [hlCountry({}), /headline amount.*required/],
    period_scope_only: [hlCountry({ period: 'hour', scope: 'x' }), /headline amount.*required/],
    amount_number: [H({ amount: 13.9 }), /headline amount/],
    amount_comma_decimal: [H({ amount: '13,90' }), /headline amount/],
    amount_three_decimals: [H({ amount: '13.999' }), /headline amount/],
    amount_bad_thousands: [H({ amount: '1,22' }), /headline amount/],
    amount_currency: [H({ amount: '€13.90' }), /headline amount/],
    amount_padded: [H({ amount: ' 13.90' }), /headline amount/],
    amount_trailing_dot: [H({ amount: '13.' }), /headline amount/],
    amount_leading_dot: [H({ amount: '.5' }), /headline amount/],
    amount_exponent: [H({ amount: '1e3' }), /headline amount/],
    amount_negative: [H({ amount: '-5' }), /headline amount/],
    amount_empty: [H({ amount: '' }), /headline amount/],
    amount_markup: [H({ amount: '<b>1</b>' }), /headline amount/],
    amount_not_in_value_longer_number: [H({ amount: '13.90' }, 'EUR 113.90 per hour'), /headline amount "13\.90" .*value/],
    amount_not_in_value_digit_swap: [H({ amount: '13.90' }, 'EUR 13.09 per hour'), /headline amount .*value/],
    amount_not_in_value_thousands: [H({ amount: '13.90' }, 'EUR 1,390 per month'), /headline amount .*value/],
    amount_not_in_value_other_decimals: [H({ amount: '13.90' }, 'EUR 13.91 per hour'), /headline amount .*value/],
    amount_not_in_value_decimal_is_not_thousands: [H({ amount: '1,390' }, 'EUR 13.90 per hour'), /headline amount .*value/],
    amount_not_in_value_thousands_is_not_decimal: [H({ amount: '13.90' }, 'EUR 1.390 per month'), /headline amount .*value/],
    amount_not_in_value_one_dot_five: [H({ amount: '15' }, 'EUR 1.5 per hour'), /headline amount .*value/],
    amount_not_in_value_integer: [H({ amount: '13.90' }, 'EUR 13 per hour'), /headline amount .*value/],
    period_missing: [H({ period: undefined }), /headline period/],
    period_week: [H({ period: 'week' }), /headline period/],
    period_case: [H({ period: 'Hour' }), /headline period/],
    period_number: [H({ period: 1 }), /headline period/],
    scope_missing: [hlCountry(noKey(good, 'scope')), /headline scope/],
    scope_empty: [H({ scope: '' }), /headline scope/],
    scope_untrimmed: [H({ scope: ' all' }), /headline scope/],
    scope_markup: [H({ scope: 'age <b>21</b>' }), /headline scope.*plain text/],
    scope_gt: [H({ scope: 'a > b' }), /headline scope.*plain text/],
    scope_newline: [H({ scope: 'a\nb' }), /headline scope.*control/],
    scope_long: [H({ scope: 'x'.repeat(61) }), /headline scope.*60/],
    scope_number: [H({ scope: 21 }), /headline scope/],
    region_markup: [H({ region: 'a<b' }), /headline region.*plain text/],
    region_empty: [H({ region: '' }), /headline region/],
    region_untrimmed: [H({ region: ' Geneva' }), /headline region/],
    region_newline: [H({ region: 'a\nb' }), /headline region.*control/],
    region_long: [H({ region: 'r'.repeat(41) }), /headline region.*40/],
    region_number: [H({ region: 5 }), /headline region/],
    region_with_statutory: [hlCountry({ statutory: false, region: 'Geneva' }), /headline statutory/],
    period_hour_but_value_says_month: [hlCountry({ amount: '4,806', period: 'hour', scope: 'x' }, '4,806 zl gross per month; minimum hourly rate 31.40 zl'), /headline period "hour"/],
    period_month_but_value_says_hour: [H({ period: 'month' }), /headline period "month"/],
    period_hour_but_value_says_day: [hlCountry({ amount: '40.70', period: 'hour', scope: 'x' }, '40.70 per day or 1,221 per month'), /headline period "hour"/],
    period_keyword_beyond_next_number: [hlCountry({ amount: '13.90', period: 'hour', scope: 'x' }, 'EUR 13.90 gross, from 1 January 2026, per hour'), /headline period "hour"/],
    statutory_true: [hlCountry({ statutory: true }), /headline statutory/],
    statutory_string: [hlCountry({ statutory: 'false' }), /headline statutory/],
    statutory_with_amount: [hlCountry({ statutory: false, amount: '13.90' }), /headline statutory/],
    statutory_with_period: [hlCountry({ statutory: false, period: 'hour' }), /headline statutory/],
    statutory_with_scope: [hlCountry({ statutory: false, scope: 'x' }), /headline statutory/],
    statutory_with_everything: [hlCountry({ ...good, statutory: false }), /headline statutory/],
  };
  try {
    assert.ok(s.validate(H({})).ok, 'baseline headline passes');
    for (const [name, [data, re]] of Object.entries(cases)) {
      const r = s.validate(data);
      assert.ok(!r.ok && /facts/i.test(r.out) && re.test(r.out), `validate.mjs must reject headline case "${name}" naming "facts" and matching ${re}: ` + r.out.slice(0, 500));
    }
    for (const cp of bidiAndInvisible) {
      const r = s.validate(H({ scope: 'age' + String.fromCharCode(cp) + ' 21' }));
      assert.ok(!r.ok && /headline scope.*control/.test(r.out), `U+${cp.toString(16).toUpperCase()} in headline scope must be rejected: ` + r.out.slice(0, 300));
    }
  } finally { s.done(); }
});

test('p4_2.page_exists_with_seo_head_jsonld_and_sitemap', () => {
  assert.ok(fs.existsSync(path.join(ROOT, MW_FILE)), `${MW_FILE} not generated by build-pages.mjs`);
  const h = read(MW_FILE), s = seoOf(h, MW_FILE), url = SITE_URL + MW_FILE;
  assert.equal(s.title, expectedMwTitle(), 'title');
  assert.ok(s.title.startsWith(`Minimum wage in Europe ${YEAR}: statutory rates by country`) && s.title.length <= TITLE_MAX, 'title uses the last-verified YEAR and is <= 70');
  assert.ok(s.desc.length >= DESC_MIN && s.desc.length <= DESC_MAX && /\.$/.test(s.desc) && !/[<>]/.test(s.desc), `description 70..158, plain, ends with a period (${s.desc.length})`);
  const rows = renderMinWage(JSON.parse(read('data/facts.json'))).count;
  assert.ok(new RegExp(`(^|\\D)${rows}(\\D|$)`).test(s.desc), `description names the number of countries in the table (${rows}): ${s.desc}`);
  assert.equal(s.canonical, url); assert.equal(s.ogUrl, url); assert.equal(s.h1s, 1);
  assert.equal(s.ogTitle, s.title); assert.equal(s.twTitle, s.title); assert.equal(s.ogDesc, s.desc); assert.equal(s.twDesc, s.desc);
  assert.match(h, /<h1>Minimum wage in Europe 2026<\/h1>|<h1>Minimum wage in Europe \d{4}<\/h1>/, 'h1');
  assert.ok(h.includes(`<h1>Minimum wage in Europe ${YEAR}</h1>`), 'h1 carries the year');
  assert.match(h, /<link rel="stylesheet" href="legal\.css">/); assert.match(h, /Content-Security-Policy/);
  assert.ok(!/\son[a-z]+=|\sstyle=/i.test(h) && !INLINE_SCRIPT.test(h), 'CSP: no inline handlers/scripts/styles');
  const bc = byType(ldGraph(h, MW_FILE), 'BreadcrumbList');
  assert.equal(bc.length, 1);
  assert.deepEqual(bc[0].itemListElement.map(i => [i.position, i.name, i.item]), [[1, 'Home', SITE_URL], [2, 'Minimum wage in Europe', url]]);
  assert.match(read('sitemap.xml'), new RegExp(`<loc>${url.replace(/\./g, '\\.')}</loc><lastmod>${mwDateOf(loadFacts(), VER22)}</lastmod>`), 'in sitemap.xml with lastmod = newest checked date of the displayed minimumWage facts (P4-3; was LAST_VERIFIED)');
  assert.ok(publicPages().includes(MW_FILE), 'part of the public page set (SEO and uniqueness tests cover it)');
});
test('p4_2.page_links_footers_keyfacts_and_no_nav_change', () => {
  const gen = allGenerated(); assert.ok(gen.includes(MW_FILE));
  for (const f of gen) {
    const d = f.startsWith('countries/') ? '../' : '', h = read(f), ft = footerOf(h);
    const a = `<a href="${d}minimum-wage-europe.html">Minimum wage</a>`;
    assert.ok(ft.includes(a), `${f}: footer link "Minimum wage"`);
    assert.ok(ft.indexOf(`<a href="${d}keyfacts.html">Key facts</a>`) < ft.indexOf(a) && ft.indexOf(a) < ft.indexOf(`<a href="${d}glossary.html">Glossary</a>`), `${f}: footer order Key facts, Minimum wage, Glossary`);
    assert.ok(!/minimum-wage-europe/.test(headerOf(h)), `${f}: no header nav change`);
  }
  const idx = read('index.html');
  assert.ok(!/minimum-wage-europe/.test((idx.match(/<header>[\s\S]*?<\/header>/) || [''])[0]), 'index.html header nav unchanged');
  assert.match(footerOf(idx), /<a href="glossary\.html">Glossary<\/a>\s*<a href="minimum-wage-europe\.html">Minimum wage<\/a>\s*<a href="deadlines\.html">Deadlines<\/a>\s*<a href="suggest\.html">/, 'index.html footer nav: Minimum wage link right after Glossary, then Deadlines (P2-12)');
  assert.equal(idx.split('href="minimum-wage-europe.html"').length - 1, 1, 'index.html links the page exactly once (footer)');
  const kmain = (read('keyfacts.html').match(/<main>[\s\S]*?<\/main>/) || [''])[0];
  assert.equal(kmain.split('href="minimum-wage-europe.html"').length - 1, 1, 'keyfacts.html main links to the page once');
  assert.ok(((kmain.match(/<\/h1>\s*<p>([\s\S]*?)<\/p>/) || ['', ''])[1]).includes('<a href="minimum-wage-europe.html">'), 'keyfacts.html: the intro paragraph (first <p> after the h1) holds the link');
  const mmain = (read(MW_FILE).match(/<main>[\s\S]*?<\/main>/) || [''])[0];
  assert.ok(mmain.includes('href="keyfacts.html"') && mmain.includes('href="countries.html"'), 'page main links back to keyfacts.html and countries.html');
  for (const m of mmain.matchAll(/href="(countries\/[^"]+)"/g)) assert.ok(resolves(m[1]), `${m[1]} resolves`);
});
test('p4_2.page_intro_states_figures_are_not_converted', () => {
  const m = mwParts(read(MW_FILE)), txt = m.main.replace(/<table[\s\S]*?<\/table>/g, ' ').replace(/<[^>]*>/g, ' ');
  for (const re of [/statutory minimum/i, /as stated by/i, /not converted/i, /hours worked/i, /age bands?/i, /check the source/i, /Monthly figures are not comparable across countries/, /12, 13 or 14/, /working hours and the gross\/net basis/, /collective agreement or apply to one region/]) assert.match(txt, re, `intro text matches ${re}`);
  assert.equal((m.q.match(/<h1[\s>]/g) || []).length, 1);
  assert.ok(!/<h[3-6]\b/.test(m.main), 'heading levels: h1 then h2 only');
});

test('p4_2.data.every_country_has_a_minimum_wage_headline_matching_its_value', () => {
  const facts = loadFacts(); assert.equal(facts.length, 20);
  let amounts = 0, none = 0;
  for (const c of facts) {
    const f = c.facts.find(x => x.key === 'minimumWage'), at = c.code;
    assert.ok(f, `${at}: has a minimumWage fact`);
    assert.ok(f.headline && typeof f.headline === 'object', `${at}: minimumWage fact needs a headline (amount or statutory:false)`);
    const h = f.headline;
    for (const k of Object.keys(h)) assert.ok(['amount', 'period', 'scope', 'region', 'statutory'].includes(k), `${at}: headline key ${k}`);
    if (h.statutory === false) { none++; assert.deepEqual(Object.keys(h), ['statutory'], `${at}: statutory:false carries nothing else`); assert.match(f.value, /\bno\b|\bnot\b|\bwithout\b|\bneither\b/i, `${at}: statutory:false but value does not say there is none: ${f.value}`); }
    else {
      amounts++;
      assert.ok(!('statutory' in h), `${at}: no statutory key with an amount`);
      assert.match(h.amount, /^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/, `${at}: amount format`);
      assert.ok(amountInValue(h.amount, f.value), `${at}: headline amount ${h.amount} must appear in value: ${f.value}`);
      assert.ok(['hour', 'month'].includes(h.period), `${at}: period`);
      assert.ok(typeof h.scope === 'string' && h.scope.trim() === h.scope && h.scope.length > 0 && h.scope.length <= 60 && !/[<>]/.test(h.scope), `${at}: scope`);
    }
  }
  assert.equal(amounts + none, 20); assert.ok(amounts >= 8, `most of the 20 countries have a statutory amount: ${amounts} amounts, ${none} statutory:false`);
});
test('p4_2.data.page_matches_data_exactly', () => {
  const facts = loadFacts();
  assert.ok(fs.existsSync(path.join(ROOT, MW_FILE)), `${MW_FILE} missing`);
  const got = assertMwMatches(read(MW_FILE), facts, 'real data');
  assert.equal(got.table.label, 'Minimum wage by country table');
  assert.ok(got.table.caption.includes(YEAR) && /Statutory minimum wage/.test(got.table.caption), 'caption names the year');
  const want = renderMinWage(facts);
  assert.equal(want.rows.length + want.none.length, 20, 'every one of the 20 countries appears exactly once');
  assert.ok(got.q.indexOf('</table>') < got.q.indexOf('id="no-statutory-minimum"'), 'no-statutory section follows the table');
  const names = want.rows.map(r => r.match(/#key-facts">[^ ]+ ([^<]*)<\/a>/)[1]);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'rows sorted by name');
  assert.ok(!/\sstyle=/.test(got.q));
});

test('p4_2.fixture_page_is_data_driven_and_deterministic', () => {
  const setYear = js => js.replace(/(new Date\(')\d{4}-\d{2}-\d{2}(T)/, (_, a, b) => `${a}2027-02-03${b}`);
  const s = factsSite(undefined, { appEdit: setYear });
  try {
    const data = mwFixture(), r = s.build(data); assert.ok(r.ok, r.out.slice(0, 400));
    const file = path.join(s.dir, MW_FILE); assert.ok(fs.existsSync(file), `${MW_FILE} not generated`);
    const h = fs.readFileSync(file, 'utf8'), got = assertMwMatches(h, data, 'fixture');
    assert.equal(got.table.rows.length, 1); assert.equal(got.none.items.length, 1);
    assert.ok(got.table.rows[0].includes('<td>EUR 1,000</td><td>—</td><td>full-time, age 18 and over</td><td>1 January 2026</td>'), 'monthly cell filled, hourly "—": ' + got.table.rows[0]);
    assert.ok(got.none.items[0].includes('href="https://example.org/es?a=1&amp;b=2"'), 'source href escaped');
    assert.ok(got.none.items[0].includes('<span class="note">Sectoral agreements set the floors &amp; &quot;minimums&quot;.</span>'), 'note shown and escaped: ' + got.none.items[0]);
    assert.ok(!/Poland|Germany|Sweden/.test(got.main), 'no hard-coded countries');
    const sx = seoOf(h, MW_FILE); assert.equal(sx.title, expectedMwTitle('2027'), 'title uses the fixture year'); assert.ok(/(^|\D)1(\D|$)/.test(sx.desc), 'description names 1 country: ' + sx.desc);
    assert.match(fs.readFileSync(path.join(s.dir, 'sitemap.xml'), 'utf8'), /minimum-wage-europe\.html<\/loc><lastmod>2026-10-01<\/lastmod>/, 'lastmod = the fixture facts checked date 2026-10-01, not LAST_VERIFIED 2027-02-03 (P4-3)');
    assert.ok(fs.readFileSync(path.join(s.dir, 'keyfacts.html'), 'utf8').includes('href="minimum-wage-europe.html"'));
    const a = h; s.run('build-pages.mjs'); assert.equal(fs.readFileSync(file, 'utf8'), a, 'second build byte-identical');
    // sorted by name regardless of file order, hourly column used for hour amounts
    const sorted = mwSorting(); assert.ok(s.build(sorted).ok);
    const g2 = assertMwMatches(fs.readFileSync(file, 'utf8'), sorted, 'sorting fixture');
    assert.deepEqual(g2.table.rows.map(x => x.match(/#key-facts">[^ ]+ ([^<]*)<\/a>/)[1]), ['France', 'Germany', 'Spain']);
    assert.deepEqual(g2.none.items.map(x => x.match(/#key-facts">[^ ]+ ([^<]*)<\/a>/)[1]), ['Italy', 'Poland']);
    assert.ok(g2.table.rows[1].includes('<td>EUR</td><td>—</td><td>EUR 13.90</td>'), 'germany: hourly column');
    // no rows and no list: still a valid page without table or list
    assert.ok(s.build([]).ok); const e = fs.readFileSync(file, 'utf8'); assert.ok(!/<table\b|no-min-wage/.test(e), 'empty facts: no table, no list');
  } finally { s.done(); }
});
test('p4_2.fixture_escapes_hostile_strings', () => {
  const s = factsSite();
  try {
    const evil = '<img src=x onerror=alert(1)>';
    const data = [
      fixCountry({ currency: 'EUR', facts: [fixFact({ value: `EUR 1 ${evil} "q" 's' & more`, sourceLabel: 'Source: <i>X</i> - "Y"', sourceUrl: 'https://example.org/a"onmouseover="x&y=1', validFrom: '2026-01-01', headline: { amount: '<b>1</b>', period: 'month', scope: `${evil} & "s" 't'` } })] }),
      fixCountry({ code: 'spain', facts: [fixFact({ value: `No minimum ${evil} & 'x'`, note: `${evil} & "n" 'm'`, sourceLabel: 'Source: <u>Z</u> - "W"', headline: { statutory: false } })] }),
    ];
    const r = s.build(data); assert.ok(r.ok, 'build without validate must not crash on hostile text: ' + r.out.slice(0, 400));
    const h = fs.readFileSync(path.join(s.dir, MW_FILE), 'utf8');
    assertMwMatches(h, data, 'hostile');
    assert.ok(!/<(img|b|i|u)\b/i.test(mwParts(h).main.replace(/<a href="[^"]*"/g, '<a')), 'no raw tags from data');
    assert.ok(!/<[^>]*\son[a-z]+=/i.test(h), 'no event-handler attribute inside any tag (the escaped text may still contain the words)');
    assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'hostile text is shown as escaped text');
    assert.ok(h.includes('href="https://example.org/a&quot;onmouseover=&quot;x&amp;y=1"'), 'href attribute-escaped');
    // a headline with a missing period shows an em dash in both columns
    const nop = [fixCountry({ facts: [fixFact({ headline: { amount: '1,000', scope: 'all' } })] })];
    assert.ok(s.build(nop).ok); assert.ok(mwParts(fs.readFileSync(path.join(s.dir, MW_FILE), 'utf8')).table.rows[0].includes('<td>EUR</td><td>—</td><td>—</td><td>all</td>'), 'missing period: both columns "—"');
  } finally { s.done(); }
});
test('p4_2.check_tracks_the_page', () => {
  const s = factsSite();
  try {
    const real = JSON.parse(read('data/facts.json'));
    let r = s.build(real); assert.ok(r.ok, r.out.slice(0, 300));
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, r.out.slice(0, 300));
    const file = path.join(s.dir, MW_FILE), orig = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, orig.replace('<td>', '<td>tampered ')); r = s.run('build-pages.mjs', '--check');
    assert.ok(!r.ok && /minimum-wage-europe\.html is out of date/.test(r.out), 'tampered page: ' + r.out.slice(0, 300));
    fs.rmSync(file); r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /minimum-wage-europe\.html is missing/.test(r.out), 'deleted page: ' + r.out.slice(0, 300));
    s.run('build-pages.mjs');
    const changed = JSON.parse(JSON.stringify(real)), f = changed.find(c => c.facts.find(x => x.key === 'minimumWage' && x.headline && x.headline.amount)).facts.find(x => x.key === 'minimumWage');
    f.headline.scope = 'a changed scope'; s.setFacts(changed);
    r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /minimum-wage-europe\.html is out of date/.test(r.out), 'changed headline makes the page stale: ' + r.out.slice(0, 300));
  } finally { s.done(); }
});

test('p4_2.css_min_wage_table_at_375px', () => {
  const css = read('legal.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const screen = css.replace(/@media\s+print\s*\{[\s\S]*$/, '');
  // Lookbehind (not a consumed '}') so EVERY rule is read, whatever its position in the file.
  const rule = sel => [...screen.matchAll(/(?<=^|\})\s*([^{}]*)\{([^}]*)\}/g)].filter(m => m[1].split(',').map(x => x.trim().replace(/\s+/g, ' ')).includes(sel)).map(m => m[2]).join(';');
  const t = rule('.min-wage');
  assert.match(t, /border-collapse\s*:\s*collapse/, '.min-wage border-collapse'); assert.match(t, /width\s*:\s*100%/, '.min-wage width: 100%');
  const mw = t.match(/min-width\s*:\s*(\d+(?:\.\d+)?)rem/); assert.ok(mw && Number(mw[1]) >= 34 && Number(mw[1]) <= 64, '.min-wage min-width in rem (34 to 64) so 7 columns scroll inside .table-scroll instead of crushing at 375px');
  const cells = rule('.min-wage th') + ';' + rule('.min-wage td') + ';' + [...screen.matchAll(/\.min-wage th,\s*\.min-wage td\s*\{([^}]*)\}/g)].map(m => m[1]).join(';');
  assert.match(cells, /border\s*:\s*1px solid var\(--border\)/); assert.match(cells, /padding\s*:/); assert.match(cells, /text-align\s*:\s*left/); assert.match(cells, /vertical-align\s*:\s*top/); assert.match(cells, /font-variant-numeric\s*:\s*tabular-nums/);
  assert.match(rule('.min-wage caption'), /text-align\s*:\s*left/, '.min-wage caption');
  const th = rule('.min-wage tbody th');
  assert.match(th, /position\s*:\s*sticky/, 'first column sticks on screen'); assert.match(th, /left\s*:\s*0/); assert.match(th, /background\s*:\s*var\(--bg\)/, 'opaque background so scrolled cells do not show through');
  assert.match(css.match(/@media\s+print\s*\{[\s\S]*$/)[0], /\.min-wage tbody th\s*\{[^}]*position\s*:\s*static/, 'print: no sticky');
  assert.match(rule('.no-min-wage'), /overflow-wrap\s*:\s*(anywhere|break-word)/, 'long values and URLs in the no-statutory list wrap');
  assert.match(screen, /(^|\})\s*a\s*\{[^}]*color\s*:\s*var\(--accent\)/, 'links keep the readable accent colour on the dark UI');
  assert.ok(!/\.min-wage[^{]*\{[^}]*display\s*:\s*none/.test(screen), 'nothing in the table is hidden on screen');
  assert.match(screen, /\.table-scroll\s*\{[^}]*overflow-x\s*:\s*auto/); assert.match(screen, /\.table-scroll\s*\{[^}]*max-width\s*:\s*100%/);
  assert.match(read(MW_FILE), /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
});
test('p4_2.readme_and_example', () => {
  const readme = read('README.md'), kf = readme.split('### Country key facts')[1].split(/\n##+ /)[0];
  for (const re of [/`headline`/, /`amount`/, /`period`/, /`scope`/, /`statutory`/, /`region`/, /minimum-wage-europe\.html/, /not converted/i, /appear[s]? in (the )?`value`/]) assert.match(kf, re, `README Country key facts mentions ${re}`);
  const blocks = [...kf.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
  const withHl = blocks.filter(b => (b.facts || []).some(f => f.headline));
  assert.ok(withHl.length >= 1, 'a README json example shows a minimumWage headline');
  const s = factsSite();
  try { for (const b of blocks) { const r = s.validate([b]); assert.ok(r.ok, 'README example validates: ' + r.out.slice(0, 400)); } } finally { s.done(); }
  const seo = readme.split('## On-page SEO')[1].split(/\n## /)[0];
  assert.ok(!/\(WebSite, Organization, FAQPage\)/.test(seo) && !/update the FAQPage/.test(seo) && !/FAQPage JSON-LD does not match/.test(seo), 'README On-page SEO no longer describes FAQ structured data');
  assert.match(seo, /WebSite, Organization/); assert.match(seo, /minimum-wage-europe/, 'On-page SEO documents the new page title/description');
  assert.match(seo, /no FAQ|without FAQ|FAQ structured data (was|is) removed|no FAQPage/i, 'README states that the visible FAQ has no structured data');
});

// ---------- P4-3: pages built from data files carry THEIR OWN data date ----------
// CONTRACT
//  FACT_DATE(page) = the newest ISO 'checked' among the facts the page displays; the site-wide LAST_VERIFIED is NOT changed.
//  minimum-wage-europe.html: facts = minimumWage facts that have a headline (table rows AND the no-statutory list; a minimumWage fact without headline
//    and every other key are ignored). description ends "... checked <D>." (D = FACT_DATE as 'd MMMM yyyy'; case of "checked" not asserted);
//    page footer note "Sources last checked <D>."; sitemap lastmod = FACT_DATE (ISO). h1/title/caption YEAR stays LAST_VERIFIED's year.
//  keyfacts.html: FACT_DATE = newest 'checked' over ALL facts in data/facts.json; footer note and sitemap lastmod use it, no other date appears.
//  Country pages: page-level meta line, description and footer note keep LAST_VERIFIED; sitemap lastmod = max(LAST_VERIFIED, newest 'checked' of that country's facts).
//  glossary.html: sitemap lastmod = newest glossary 'checked' (existing logic). Pages without data dates (index, countries, upcoming, suggest) keep LAST_VERIFIED
//    in footer and sitemap. privacy/terms keep operator.legalUpdated.
//  No facts for a page (empty facts.json): FACT_DATE falls back to LAST_VERIFIED. Output stays deterministic; build-pages --check tracks it and the SEO checks pass.
//  The shared footer() helper takes an optional date override (internal; observable only through the page output above).
const hasWords = (h, d) => h.includes(fmtLong(d));
test('p4_3.real_min_wage_page_is_dated_by_its_own_facts', () => {
  const facts = loadFacts(), D = mwDateOf(facts, VER22), h = read(MW_FILE), s = seoOf(h, MW_FILE);
  assert.match(D, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(s.desc.toLowerCase().endsWith('checked ' + fmtLong(D).toLowerCase() + '.'), 'description ends with "checked ' + fmtLong(D) + '.": ' + s.desc);
  assert.ok(footerOf(h).includes('Sources last checked ' + fmtLong(D) + '.'), 'footer note uses the facts date ' + fmtLong(D));
  if (D !== VER22) assert.ok(!hasWords(h, VER22), 'the page must not state the site-wide ' + fmtLong(VER22) + ' (the reported bug)');
  assert.equal(sitemapMod(read('sitemap.xml'), MW_FILE), D, 'sitemap lastmod = FACT_DATE');
  assert.ok(s.desc.length >= DESC_MIN && s.desc.length <= DESC_MAX, 'description length ' + s.desc.length);
});
test('p4_3.real_keyfacts_page_is_dated_by_its_own_facts', () => {
  const facts = loadFacts(), D = kfDateOf(facts, VER22), h = read('keyfacts.html'), s = seoOf(h, 'keyfacts.html');
  assert.ok(footerOf(h).includes('Sources last checked ' + fmtLong(D) + '.'), 'footer note uses the facts date ' + fmtLong(D));
  if (D !== VER22) assert.ok(!hasWords(h, VER22), 'keyfacts.html must not state the site-wide ' + fmtLong(VER22));
  if (/checked/i.test(s.desc)) assert.ok(s.desc.includes(fmtLong(D)), 'if the description states a check date it is the facts date');
  assert.equal(sitemapMod(read('sitemap.xml'), 'keyfacts.html'), D, 'sitemap lastmod = newest checked over all facts');
});
test('p4_3.real_country_and_other_pages_keep_last_verified_text_but_sitemap_follows_data', () => {
  const x = read('sitemap.xml'), facts = loadFacts(), files = countryFiles.filter(f => f.endsWith('.html'));
  assert.equal(files.length, 75);
  for (const f of files) {
    const code = slugToCode.get(f.replace(/\.html$/, '')), h = read('countries/' + f);
    assert.equal(sitemapMod(x, 'countries/' + f), countryModOf(facts, code, VER22), f + ': lastmod = max(LAST_VERIFIED, newest checked of its facts)');
    assert.ok(footerOf(h).includes('Sources last checked ' + fmtLong(VER22) + '.'), f + ': page-level footer note stays LAST_VERIFIED');
    assert.ok(h.includes('sources last checked ' + fmtLong(VER22) + '</p>'), f + ': meta line stays LAST_VERIFIED');
    assert.ok(seoOf(h, f).desc.endsWith('checked ' + fmtLong(VER22) + '.'), f + ': description stays LAST_VERIFIED');
  }
  for (const f of ['countries.html', 'upcoming.html', 'suggest.html']) { assert.equal(sitemapMod(x, f), VER22, f + ': no data dates, lastmod = LAST_VERIFIED'); assert.ok(footerOf(read(f)).includes('Sources last checked ' + fmtLong(VER22) + '.'), f + ': footer'); }
  assert.equal(sitemapMod(x, ''), VER22, 'index lastmod = LAST_VERIFIED');
  assert.equal(sitemapMod(x, 'glossary.html'), maxIso(JSON.parse(read('data/glossary.json')).map(t => t.checked)), 'glossary lastmod = its own newest checked date');
});

const dateFixture = () => [
  fixCountry({ code: 'france', facts: [fixFact({ checked: '2026-11-05', headline: { amount: '1,000', period: 'month', scope: 'full-time' } }), fixFact({ key: 'ssEmployer', label: "Employer's social security", value: 'About 40% of gross pay', checked: '2026-12-31' })] }),
  fixCountry({ code: 'spain', facts: [fixFact({ value: 'No statutory national minimum wage', checked: '2026-12-20', headline: { statutory: false } })] }),
  fixCountry({ code: 'germany', facts: [fixFact({ value: 'EUR 13.90 per hour', checked: '2027-01-15' })] }),
  fixCountry({ code: 'poland', currency: 'PLN', facts: [fixFact({ value: 'PLN 4,806 per month', checked: '2026-09-01', headline: { amount: '4,806', period: 'month', scope: 'all employees' } })] }),
];
const MW_D = '2026-12-20', KF_D = '2027-01-15';
const withLv = lv => ({ appEdit: js => js.replace(/(new Date\(')\d{4}-\d{2}-\d{2}(T)/, (_, a, b) => a + lv + b) });
for (const lv of ['2026-12-01', '2027-02-03']) {
  test('p4_3.fixture_pages_follow_their_data_not_last_verified_nor_first_fact (LAST_VERIFIED ' + lv + ')', () => {
    const s = factsSite(undefined, withLv(lv));
    try {
      const data = dateFixture(), rd = f => fs.readFileSync(path.join(s.dir, f), 'utf8');
      assert.equal(mwDateOf(data, lv), MW_D); assert.equal(kfDateOf(data, lv), KF_D);
      let r = s.build(data); assert.ok(r.ok, r.out.slice(0, 400));
      const x = rd('sitemap.xml'), mw = rd(MW_FILE), kf = rd('keyfacts.html');
      // minimum wage: max over headline facts only (spain statutory:false counts; germany's headline-less fact and france's ssEmployer do not)
      assert.ok(seoOf(mw, MW_FILE).desc.endsWith('hecked ' + fmtLong(MW_D) + '.'), 'mw description: ' + seoOf(mw, MW_FILE).desc);
      assert.ok(footerOf(mw).includes('Sources last checked ' + fmtLong(MW_D) + '.'), 'mw footer');
      for (const wrong of [lv, '2026-11-05', '2026-09-01', KF_D, '2026-12-31']) assert.ok(!hasWords(mw, wrong), 'mw page must not show ' + fmtLong(wrong));
      assert.equal(sitemapMod(x, MW_FILE), MW_D, 'mw lastmod');
      // keyfacts: max over every fact
      assert.ok(footerOf(kf).includes('Sources last checked ' + fmtLong(KF_D) + '.'), 'keyfacts footer');
      for (const wrong of [lv, MW_D, '2026-11-05']) assert.ok(!hasWords(kf, wrong), 'keyfacts page must not show ' + fmtLong(wrong));
      assert.equal(sitemapMod(x, 'keyfacts.html'), KF_D, 'keyfacts lastmod');
      // country pages: text stays LAST_VERIFIED, lastmod = max(LAST_VERIFIED, newest own fact)
      for (const f of s.pages()) {
        const code = slugToCode.get(f.replace(/\.html$/, '')), h = rd('countries/' + f);
        assert.equal(sitemapMod(x, 'countries/' + f), countryModOf(data, code, lv), f + ' lastmod');
        assert.ok(footerOf(h).includes('Sources last checked ' + fmtLong(lv) + '.') && h.includes('sources last checked ' + fmtLong(lv) + '</p>'), f + ' page-level text = LAST_VERIFIED');
      }
      const exp = lv === '2026-12-01' ? { france: '2026-12-31', spain: MW_D, germany: KF_D, poland: lv } : { france: lv, spain: lv, germany: lv, poland: lv };
      for (const [slug, d] of Object.entries(exp)) assert.equal(sitemapMod(x, 'countries/' + slug + '.html'), d, slug + ' expected lastmod');
      // pages without data dates, and glossary
      for (const f of ['countries.html', 'upcoming.html', 'suggest.html']) { assert.equal(sitemapMod(x, f), lv, f); assert.ok(footerOf(rd(f)).includes('Sources last checked ' + fmtLong(lv) + '.'), f + ' footer'); }
      assert.equal(sitemapMod(x, ''), lv, 'home');
      assert.equal(sitemapMod(x, 'glossary.html'), maxIso(JSON.parse(rd('data/glossary.json')).map(t => t.checked)), 'glossary');
      // SEO rules still hold, descriptions unique, --check green, build deterministic
      const descs = new Map();
      for (const f of ['index.html', 'countries.html', 'upcoming.html', 'glossary.html', 'privacy.html', 'terms.html', 'suggest.html', 'keyfacts.html', MW_FILE, ...s.pages().map(p => 'countries/' + p)]) {
        const d = seoOf(rd(f), f).desc; assert.ok(d.length >= DESC_MIN && d.length <= DESC_MAX && d.endsWith('.'), f + ' description ' + d.length);
        assert.ok(!descs.has(d), 'duplicate description ' + f + ' / ' + descs.get(d)); descs.set(d, f);
      }
      r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, '--check must pass (no SEO or stale problem): ' + r.out.slice(0, 400));
      s.run('build-pages.mjs'); assert.equal(rd(MW_FILE), mw); assert.equal(rd('keyfacts.html'), kf); assert.equal(rd('sitemap.xml'), x, 'deterministic');
    } finally { s.done(); }
  });
}
test('p4_3.no_facts_fall_back_to_last_verified', () => {
  const s = factsSite(undefined, withLv('2027-02-03'));
  try {
    const r = s.build([]); assert.ok(r.ok, r.out.slice(0, 300));
    const rd = f => fs.readFileSync(path.join(s.dir, f), 'utf8'), x = rd('sitemap.xml');
    for (const f of [MW_FILE, 'keyfacts.html']) { assert.equal(sitemapMod(x, f), '2027-02-03', f + ' lastmod'); assert.ok(footerOf(rd(f)).includes('Sources last checked 3 February 2027.'), f + ' footer'); }
    assert.ok(seoOf(rd(MW_FILE), MW_FILE).desc.endsWith('hecked 3 February 2027.'));
    assert.ok(s.run('build-pages.mjs', '--check').ok);
  } finally { s.done(); }
});
test('p4_3.check_tracks_the_data_dates', () => {
  const s = factsSite();
  try {
    const data = dateFixture(); let r = s.build(data); assert.ok(r.ok, r.out.slice(0, 300));
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, r.out.slice(0, 300));
    // a newer 'checked' on a fact the minimum wage page does not show: keyfacts + sitemap + that country go stale, the minimum wage page does not
    const a = JSON.parse(JSON.stringify(data)); a.find(c => c.code === 'germany').facts[0].checked = '2027-01-20'; s.setFacts(a);
    r = s.run('build-pages.mjs', '--check');
    assert.ok(!r.ok && /keyfacts\.html is out of date/.test(r.out) && /sitemap\.xml is out of date/.test(r.out) && /countries\/germany\.html is out of date/.test(r.out), 'kf-only change: ' + r.out.slice(0, 500));
    assert.ok(!/minimum-wage-europe\.html is out of date/.test(r.out), 'a fact without headline must not touch the minimum wage page: ' + r.out.slice(0, 500));
    // a newer 'checked' on a headline fact makes the minimum wage page stale
    const b = JSON.parse(JSON.stringify(data)); b.find(c => c.code === 'spain').facts[0].checked = '2027-01-10'; s.setFacts(b);
    r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && /minimum-wage-europe\.html is out of date/.test(r.out), 'headline date change: ' + r.out.slice(0, 500));
    s.run('build-pages.mjs'); assert.ok(s.run('build-pages.mjs', '--check').ok, 'rebuilt = green again');
  } finally { s.done(); }
});

// ---------- P2-12: compliance deadlines (data model, validator, page, JSON, calendar) ----------
// CONTRACT
//  DATA  data/deadlines.json = array of flat objects, unknown keys rejected:
//    id        kebab-case /^[a-z0-9]+(-[a-z0-9]+)*$/, unique
//    country   key of countryToRegion
//    title     plain text <=120 (non-empty, trimmed, no < > control/bidi/invisible characters: same helper as facts)
//    kind      'payment' | 'filing' | 'both'
//    frequency 'monthly' | 'quarterly' | 'annual'
//    rule      monthly   {day: 1..28 | 'last', monthOffset: 0|1}
//              quarterly {day: 1..28 | 'last', monthOffset: 0, months: [4 distinct ints 1..12 in ascending order]}   (months = calendar months in which the due date FALLS)
//              annual    {day: 1..days-in-month (February at most 28) | 'last', monthOffset: 0, month: 1..12}
//              unknown rule keys (also a key of another frequency) are rejected
//    ruleText  plain <=300;  appliesTo? plain <=120;  weekendNote? plain <=200 (what the source says about non-working days; ABSENT = source silent)
//    sourceUrl https public host, no userinfo (same rules as facts);  sourceLabel 'Source: X - Y' <=200 plain;  checked real date <= UTC today + 1
//  VALIDATOR scripts/validate.mjs: every message contains "deadlines" and starts "data/deadlines.json[<i>] (<id>): ..." with these texts:
//    file missing / bad JSON: "deadlines file missing or not valid JSON"; not an array: "deadlines must be an array of deadline objects"; entry: "deadline must be an object"
//    unknown field "x"; "id must be kebab-case (lower-case letters, digits, single hyphens)"; duplicate id "x"; "country must be a known country code (as in countryToRegion)"
//    text fields via the facts helper: "<field> must be a non-empty trimmed string" / "<field> must be plain text (no < or >)" / "<field> must not contain control characters, line breaks or invisible/bidirectional formatting characters" / "<field> is N characters (max M)"
//    "kind must be one of payment, filing, both"; "frequency must be one of monthly, quarterly, annual"; "rule must be an object"; 'rule unknown field "x"';
//    "rule day ..." (any bad day, incl. annual Feb 29/30, Apr 31, monthly 29..31); "rule monthOffset ..." (monthly 0|1, others exactly 0); "rule months ..." ; "rule month must ..."
//    sourceUrl / sourceLabel / checked ("checked ... is in the future") exactly like facts. WARNING (exit 0) "... deadlines checked <date> is more than 365 days ago ..." for old checked dates.
//    validate.mjs also applies the app.js guard rules (XSS template rule, inline handler / style / javascript: scan) to deadlines.js, messages prefixed "deadlines.js".
//  PAGE  deadlines.html (build-pages.mjs): title "Payroll deadlines by country | Intelligent Payroll"; <h1>Payroll deadlines by country</h1>; description
//    "<N> recurring payroll filing and payment deadlines across <K> countries, each with its rule and official source. Checked <D>." (singular forms for 1 are free; 70..158 chars, N and K appear);
//    D = newest `checked` over ALL deadlines (fallback LAST_VERIFIED when there are none): footer note "Sources last checked <D>." and sitemap lastmod = D, like the other data pages (P4-3);
//    BreadcrumbList Home > "Payroll deadlines"; <main>: h1, intro <p>(s) (see test), a calendar row, <h2 id="upcoming">, the placeholder, then one section per country WITH deadlines (alphabetical by name).
//    <p><a class="cta" href="webcal://www.intelligentpayroll.eu/deadlines.ics">Subscribe in your calendar app</a> <a class="cta secondary" href="deadlines.ics">Download once (.ics)</a></p>
//    <h2 id="upcoming">Coming up in the next 12 months</h2><div id="deadlines-upcoming"><noscript><p>... JavaScript ... the tables below list every deadline ...</p></noscript></div>
//    section: <h2 id="<slug>"><a href="countries/<slug>.html">FLAG Name</a></h2>
//             <p class="deadline-subscribe"><a class="cta secondary" href="webcal://www.intelligentpayroll.eu/deadlines/<slug>.ics">Subscribe to Name deadlines</a> <a href="deadlines/<slug>.ics">Download (.ics)</a></p>
//             <div class="table-scroll" tabindex="0" role="region" aria-label="Name payroll deadlines table"><table class="deadlines"><caption>Payroll deadlines in Name</caption>
//             <thead><tr>Deadline | When | Applies to | Non-working day | Source (all <th scope="col">)</tr></thead><tbody> rows in data order </tbody></table></div>
//             row: <tr id="<deadline id>"><th scope="row">TITLE <span class="deadline-meta">KIND, frequency</span></th><td>ruleText</td><td>appliesTo or &mdash;(U+2014)</td><td>weekendNote or Check the source</td><td><a href="sourceUrl" rel="noopener">sourceLabel</a></td></tr>
//             KIND = Payment | Filing | Payment and filing; frequency = monthly | quarterly | annual; every data value HTML-escaped (& < > " ').
//    After </footer>: <script src="filters.js"></script><script src="deadlines.js"></script> (external only). Footer of every generated page: <a href="[../]deadlines.html">Deadlines</a> between Minimum wage and Glossary; index.html footer: right after Minimum wage.
//    keyfacts.html intro <p> links href="deadlines.html"; a country page WITH deadlines links, in its intro, <a href="../deadlines.html#<slug>">Payroll deadlines</a> once (none without).
//  JSON  deadlines.json = JSON.stringify({countries: {<code>: {name, flag, slug}} (only countries with deadlines, by name), deadlines: <data/deadlines.json content>}, null, 0) + '\n'
//  ICS   deadlines.ics and deadlines/<slug>.ics (only countries with deadlines): see the event tests. LAST_VERIFIED is the DTSTART reference date.
//  build-pages --check: tracks deadlines.html/.json/.ics, deadlines/*.ics (stale ones: "is no longer generated (delete it)") and sitemap.xml.
const plainArr = a => JSON.parse(JSON.stringify(a));
const DL_FILE = 'data/deadlines.json', DL_DOMAIN = 'intelligentpayroll.eu', DL_SITE = SITE_URL;
const loadDeadlines = () => { assert.ok(fs.existsSync(path.join(ROOT, DL_FILE)), DL_FILE + ' missing'); return JSON.parse(read(DL_FILE)); };
const dlNames = new Map(CHANGES.map(e => [e.country, { name: e.name, flag: e.flag, slug: P2.slugify(e.name) }]));
const dlCountries = list => [...new Set(list.map(d => d.country))].sort((a, b) => dlNames.get(a).name.localeCompare(dlNames.get(b).name));
const dlNewest = (list, fallback) => (list.length ? maxIso(list.map(d => d.checked)) : fallback);
const DL_KIND = { payment: 'Payment', filing: 'Filing', both: 'Payment and filing' };
const dlRow = d => `<tr id="${escH(d.id)}"><th scope="row">${escH(d.title)} <span class="deadline-meta">${DL_KIND[d.kind]}, ${d.frequency}</span></th><td>${escH(d.ruleText)}</td><td>${d.appliesTo ? escH(d.appliesTo) : '\u2014'}</td><td>${d.weekendNote ? escH(d.weekendNote) + (d.weekendSourceUrl ? ` <a href="${escH(d.weekendSourceUrl)}" rel="noopener">(source)</a>` : '') : 'Check the source'}</td><td><a href="${escH(d.sourceUrl)}" rel="noopener">${escH(d.sourceLabel)}</a></td></tr>`;
const dlSection = (code, list) => {
  const { name, flag, slug } = dlNames.get(code), mine = list.filter(d => d.country === code);
  return squash(`<h2 id="${slug}"><a href="countries/${slug}.html">${flag} ${escH(name)}</a></h2>`
    + `<p class="deadline-subscribe"><a class="cta secondary" href="webcal://www.${DL_DOMAIN}/deadlines/${slug}.ics">Subscribe to ${escH(name)} deadlines</a> <a href="deadlines/${slug}.ics">Download (.ics)</a></p>`
    + `<div class="table-scroll" tabindex="0" role="region" aria-label="${escH(name)} payroll deadlines table"><table class="deadlines"><caption>Payroll deadlines in ${escH(name)}</caption>`
    + `<thead><tr><th scope="col">Deadline</th><th scope="col">When</th><th scope="col">Applies to</th><th scope="col">Non-working day</th><th scope="col">Source</th></tr></thead><tbody>${mine.map(dlRow).join('')}</tbody></table></div>`);
};
const mainOf = h => (h.match(/<main>[\s\S]*?<\/main>/) || [''])[0];
const dlPageChecks = (h, list, lv, label) => {
  const main = squash(mainOf(h)), codes = dlCountries(list);
  let at = -1;
  for (const c of codes) { const i = main.indexOf(dlSection(c, list)); assert.ok(i > at, `${label}: section for ${c} missing or out of alphabetical order`); at = i; }
  assert.equal((main.match(/<h2[\s>]/g) || []).length, codes.length + 1, `${label}: one h2 per country plus the upcoming heading`);
  assert.equal((main.match(/<table\b/g) || []).length, codes.length, `${label}: one table per country`);
  assert.equal((main.match(/<tr id=/g) || []).length, list.length, `${label}: one row per deadline`);
  const s = seoOf(h, 'deadlines.html'), D = dlNewest(list, lv);
  assert.equal(s.title, 'Payroll deadlines by country | Intelligent Payroll', `${label}: title`);
  assert.ok(s.desc.length >= DESC_MIN && s.desc.length <= DESC_MAX && s.desc.endsWith('.') && !/[<>]/.test(s.desc), `${label}: description ${s.desc.length} chars`);
  assert.ok(new RegExp(`(^|\\D)${list.length}(\\D|$)`).test(s.desc) && new RegExp(`(^|\\D)${codes.length}(\\D|$)`).test(s.desc), `${label}: description names ${list.length} deadlines and ${codes.length} countries: ${s.desc}`);
  assert.ok(s.desc.toLowerCase().endsWith('checked ' + fmtLong(D).toLowerCase() + '.'), `${label}: description ends "Checked ${fmtLong(D)}.": ${s.desc}`);
  assert.ok(footerOf(h).includes('Sources last checked ' + fmtLong(D) + '.'), `${label}: footer note uses the newest checked date`);
  return { main, s, D };
};
// An .ics file (absolute path) -> {raw, lines, events: [{prop: rawValue}]}; same structural rules as checkIcs.
const icsAt = (abs, label) => {
  const s = fs.readFileSync(abs).toString('utf8');
  assert.ok(s.endsWith('\r\n'), `${label}: must end with CRLF`);
  assert.ok(!/[^\r]\n/.test(s) && !/\r(?!\n)/.test(s), `${label}: bare LF or CR`);
  const lines = s.slice(0, -2).split('\r\n');
  lines.forEach((l, n) => assert.ok(Buffer.byteLength(l) <= 75, `${label}: line ${n + 1} is ${Buffer.byteLength(l)} octets`));
  assert.equal(lines[0], 'BEGIN:VCALENDAR'); assert.equal(lines.at(-1), 'END:VCALENDAR');
  const logical = []; for (const l of lines) { if (l.startsWith(' ')) logical[logical.length - 1] += l.slice(1); else logical.push(l); }
  const events = []; let cur = null;
  for (const l of logical) { if (l === 'BEGIN:VEVENT') { assert.equal(cur, null, 'nested VEVENT'); cur = {}; } else if (l === 'END:VEVENT') { events.push(cur); cur = null; } else if (cur) { const i = l.indexOf(':'); assert.ok(!(l.slice(0, i) in cur), `${label}: duplicate property ${l.slice(0, i)}`); cur[l.slice(0, i)] = l.slice(i + 1); } }
  assert.equal(cur, null, `${label}: unterminated VEVENT`);
  assert.equal(new Set(events.map(e => e.UID)).size, events.length, `${label}: duplicate UIDs`);
  return { raw: s, logical, events };
};
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUnesc = s => s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
const rruleOf = d => { const bd = d.rule.day === 'last' ? -1 : d.rule.day; return d.frequency === 'monthly' ? `FREQ=MONTHLY;BYMONTHDAY=${bd}` : d.frequency === 'quarterly' ? `FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=${bd}` : `FREQ=YEARLY;BYMONTH=${d.rule.month};BYMONTHDAY=${bd}`; };
const nextDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const eventOf = (d, lv, newest) => {
  const { name, slug } = dlNames.get(d.country), page = `${DL_SITE}deadlines.html#${slug}`, start = P2.occurrences(d, lv, 1)[0];
  const desc = `${d.ruleText}${d.appliesTo ? `\nApplies to: ${d.appliesTo}` : ''}\n${d.weekendNote ? `Non-working day: ${d.weekendNote}${d.weekendSourceUrl ? `\nSource for non-working-day rule: ${d.weekendSourceUrl}` : ''}` : 'Non-working-day rule: check the source.'}\n\nSource: ${d.sourceUrl}\nDetails: ${page}\n\nFor information only, not legal or tax advice. Dates follow the recurring rule stated by the source; weekends and holidays are not applied. Sources last checked ${fmtLong(d.checked)}.`;
  return { UID: `${d.id}@${DL_DOMAIN}`, DTSTAMP: newest.replace(/-/g, '') + 'T000000Z', 'DTSTART;VALUE=DATE': start.replace(/-/g, ''), 'DTEND;VALUE=DATE': nextDay(start).replace(/-/g, ''), RRULE: rruleOf(d), SUMMARY: icsEsc(`${name}: ${d.title}`), DESCRIPTION: icsEsc(desc), URL: page, TRANSP: 'TRANSPARENT' };
};
const checkDlEvents = (file, ev, list, lv, newest, label) => {
  assert.deepEqual(ev.events.map(e => e.UID), list.map(d => `${d.id}@${DL_DOMAIN}`), `${label}: one VEVENT per deadline in data order, UID <id>@${DL_DOMAIN}`);
  list.forEach((d, i) => {
    const got = ev.events[i], want = eventOf(d, lv, newest);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${label}/${d.id}: property set`);
    for (const k of Object.keys(want)) assert.equal(got[k], want[k], `${label}/${d.id}: ${k}`);
  });
};
const checkDlHeader = (ev, calname, label) => {
  for (const l of ['VERSION:2.0', 'PRODID:-//Intelligent Payroll//Payroll deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEsc(calname)]) assert.ok(ev.logical.includes(l), `${label}: header line ${l}`);
};

// ----- real data -----
const BATCH1 = [
  // id, country, kind, frequency, rule, weekendNote present (the verification notes' weekendRuleStated.stated)
  ['uk-paye-payment', 'uk', 'payment', 'monthly', { day: 22, monthOffset: 1 }, false], ['uk-paye-payment-post', 'uk', 'payment', 'monthly', { day: 19, monthOffset: 1 }, false],
  ['uk-paye-eps', 'uk', 'filing', 'monthly', { day: 19, monthOffset: 1 }, false], ['uk-p60', 'uk', 'filing', 'annual', { day: 31, monthOffset: 0, month: 5 }, false],
  ['uk-p11d', 'uk', 'filing', 'annual', { day: 6, monthOffset: 0, month: 7 }, false], ['uk-class1a-payment', 'uk', 'payment', 'annual', { day: 22, monthOffset: 0, month: 7 }, false],
  ['de-lohnsteuer-anmeldung-monthly', 'germany', 'both', 'monthly', { day: 10, monthOffset: 1 }, false], ['de-lohnsteuer-anmeldung-quarterly', 'germany', 'both', 'quarterly', { day: 10, monthOffset: 0, months: [1, 4, 7, 10] }, false],
  ['de-lohnsteuer-anmeldung-annual', 'germany', 'both', 'annual', { day: 10, monthOffset: 0, month: 1 }, false], ['de-lohnsteuerbescheinigung', 'germany', 'filing', 'annual', { day: 'last', monthOffset: 0, month: 2 }, false],
  ['de-uv-jahresmeldung', 'germany', 'filing', 'annual', { day: 16, monthOffset: 0, month: 2 }, false],
  ['fr-dsn-under50', 'france', 'both', 'monthly', { day: 15, monthOffset: 1 }, true], ['fr-dsn-50plus-same-month', 'france', 'both', 'monthly', { day: 5, monthOffset: 1 }, true],
  ['fr-dsn-50plus-deferred-pay', 'france', 'payment', 'monthly', { day: 15, monthOffset: 1 }, true], ['fr-cotisations-quarterly-under11', 'france', 'payment', 'quarterly', { day: 15, monthOffset: 0, months: [1, 4, 7, 10] }, false],
  ['nl-loonaangifte-monthly', 'netherlands', 'both', 'monthly', { day: 'last', monthOffset: 1 }, true], ['nl-loonaangifte-annual', 'netherlands', 'both', 'annual', { day: 'last', monthOffset: 0, month: 1 }, true],
  ['es-modelo-111-quarterly', 'spain', 'both', 'quarterly', { day: 20, monthOffset: 0, months: [1, 4, 7, 10] }, true], ['es-modelo-111-monthly', 'spain', 'both', 'monthly', { day: 20, monthOffset: 1 }, true],
  ['es-modelo-190', 'spain', 'filing', 'annual', { day: 31, monthOffset: 0, month: 1 }, true], ['es-cotizacion-ss', 'spain', 'payment', 'monthly', { day: 'last', monthOffset: 1 }, true],
  ['it-ritenute-f24', 'italy', 'payment', 'monthly', { day: 16, monthOffset: 1 }, true], ['it-inps-contributi', 'italy', 'payment', 'monthly', { day: 16, monthOffset: 1 }, false],
  ['it-uniemens', 'italy', 'filing', 'monthly', { day: 'last', monthOffset: 1 }, true], ['it-cu', 'italy', 'filing', 'annual', { day: 16, monthOffset: 0, month: 3 }, true], ['it-770', 'italy', 'filing', 'annual', { day: 31, monthOffset: 0, month: 10 }, true],
];
const OFFICIAL_HOSTS = { uk: /(^|\.)gov\.uk$/, germany: /(^|\.)gesetze-im-internet\.de$/, france: /(^|\.)gouv\.fr$/, netherlands: /(^|\.)belastingdienst\.nl$/, spain: /(^|\.)(gob\.es|boe\.es)$/, italy: /(^|\.)(agenziaentrate\.gov\.it|inps\.it)$/ };
test('p2_12.data.batch1_has_the_26_verified_deadlines_for_six_countries', () => {
  const data = loadDeadlines();
  assert.ok(Array.isArray(data));
  const first = data.slice(0, BATCH1.length);
  assert.deepEqual(first.map(d => d.id), BATCH1.map(r => r[0]), 'the first 26 ids are the verified batch-1 ids (same order); later batches may be appended');
  for (const [id, country, kind, frequency, rule, hasNote] of BATCH1) {
    const d = data.find(x => x.id === id);
    assert.equal(d.country, country, id); assert.equal(d.kind, kind, id); assert.equal(d.frequency, frequency, id); assert.deepEqual(d.rule, rule, `${id}: rule`);
    assert.equal('weekendNote' in d, hasNote, `${id}: weekendNote present exactly when the verification notes say weekendRuleStated.stated is true`);
  }
  assert.equal(BATCH1.filter(r => r[5]).length, 13);
  for (const c of Object.keys(OFFICIAL_HOSTS)) assert.ok(data.filter(d => d.country === c).length >= 2, `${c}: at least 2 deadlines`);
  assert.deepEqual([...new Set(data.slice(0, 26).map(d => d.country))].sort(), ['france', 'germany', 'italy', 'netherlands', 'spain', 'uk']);
  for (const d of data) {
    const u = new URL(d.sourceUrl);
    assert.equal(u.protocol, 'https:', `${d.id}: https source`);
    if (OFFICIAL_HOSTS[d.country]) assert.match(u.hostname, OFFICIAL_HOSTS[d.country], `${d.id}: official host ${u.hostname}`);
    assert.match(d.sourceLabel, /^Source: .+ - .+/);
    if ('appliesTo' in d) assert.ok(d.appliesTo.length <= 120);
    if ('weekendNote' in d) assert.ok(typeof d.weekendNote === 'string' && d.weekendNote.trim() === d.weekendNote && d.weekendNote.length >= 10 && d.weekendNote.length <= 200 && !/[<>]/.test(d.weekendNote), `${d.id}: weekendNote is plain text of 10 to 200 characters`);
    assert.ok(d.checked >= '2026-10-04' && d.checked <= ymd(1), `${d.id}: checked ${d.checked}`);
  }
});
test('p2_12.data.passes_the_validator_and_every_deadline_has_upcoming_dates', () => {
  runNode('scripts/validate.mjs');
  for (const d of loadDeadlines()) assert.equal(plainArr(P2.occurrences(d, VER22, 3)).length, 3, `${d.id}: occurrences give 3 dates`);
});
// ----- validator -----
const dlFix = (o = {}) => ({ id: 'uk-paye-payment', country: 'uk', title: 'PAYE and National Insurance payment to HMRC (monthly)', kind: 'payment', frequency: 'monthly', rule: { day: 22, monthOffset: 1 }, ruleText: 'Pay what you owe by the 22nd of the month.', sourceUrl: 'https://www.gov.uk/running-payroll/paying-hmrc', sourceLabel: 'Source: GOV.UK - Running payroll: Paying HMRC', checked: '2026-10-04', ...o });
const dlQ = (o = {}) => dlFix({ id: 'de-quarterly', country: 'germany', frequency: 'quarterly', rule: { day: 10, monthOffset: 0, months: [1, 4, 7, 10] }, ...o });
const dlA = (o = {}) => dlFix({ id: 'uk-p60', kind: 'filing', frequency: 'annual', rule: { day: 31, monthOffset: 0, month: 5 }, ...o });
test('p2_12.validate_accepts_valid_deadlines', () => {
  const s = factsSite();
  try {
    let r = s.validateDl([dlFix(), dlQ({ weekendNote: 'The page does not mention weekends.', appliesTo: 'Employers in Germany' }), dlA()]); assert.ok(r.ok, 'valid fixture: ' + r.out.slice(0, 500));
    r = s.validateDl([]); assert.ok(r.ok, 'an empty array is valid: ' + r.out.slice(0, 300));
    const ok = {
      lengths: dlFix({ title: 't'.repeat(120), ruleText: 'r'.repeat(300), appliesTo: 'a'.repeat(120), weekendNote: 'w'.repeat(200), sourceLabel: 'Source: X - ' + 'y'.repeat(188) }),
      monthly_28_last_offset0: dlFix({ id: 'a', rule: { day: 28, monthOffset: 0 } }), monthly_last: dlFix({ id: 'b', rule: { day: 'last', monthOffset: 1 } }), monthly_1: dlFix({ id: 'c', rule: { day: 1, monthOffset: 0 } }),
      quarterly_last: dlQ({ id: 'd', rule: { day: 'last', monthOffset: 0, months: [3, 6, 9, 12] } }), quarterly_28: dlQ({ id: 'e', rule: { day: 28, monthOffset: 0, months: [2, 5, 8, 11] } }),
      annual_feb_28: dlA({ id: 'f', rule: { day: 28, monthOffset: 0, month: 2 } }), annual_feb_last: dlA({ id: 'g', rule: { day: 'last', monthOffset: 0, month: 2 } }), annual_jan_31: dlA({ id: 'h', rule: { day: 31, monthOffset: 0, month: 1 } }),
      annual_apr_30: dlA({ id: 'i', rule: { day: 30, monthOffset: 0, month: 4 } }), annual_dec_31: dlA({ id: 'j', rule: { day: 31, monthOffset: 0, month: 12 } }),
      quarterly_march: dlQ({ id: 'q1', rule: { day: 10, monthOffset: 0, months: [3, 6, 9, 12] } }), quarterly_feb: dlQ({ id: 'q2', rule: { day: 'last', monthOffset: 0, months: [2, 5, 8, 11] } }),
      weekend_source: dlFix({ id: 'ws', weekendNote: 'Payment must arrive before a weekend date.', weekendSourceUrl: 'https://www.belastingdienst.nl/x?a=1&b=2' }), id_close_to_reserved: dlFix({ id: 'upcoming-x' }), id_country_prefix: dlFix({ id: 'spain-modelo' }),
      kind_both: dlFix({ id: 'k', kind: 'both' }), kind_filing: dlFix({ id: 'l', kind: 'filing' }), checked_tomorrow: dlFix({ id: 'm', checked: ymd(1) }), id_digits: dlFix({ id: '2026-x1' }), id_single: dlFix({ id: 'a' }),
      apostrophe_ampersand: dlFix({ id: 'n', title: "Employer's PAYE & NI", ruleText: 'Pay "by" the 22nd; or the 19th, if paying by post.' }), unicode_text: dlFix({ id: 'o', title: 'Lohnsteuer-Anmeldung (M\u00e4rz)', weekendNote: 'Ab Fr\u00fchling: \u20ac \u00fc \u00e9' }),
    };
    for (const [name, d] of Object.entries(ok)) { r = s.validateDl([d]); assert.ok(r.ok, `${name} must pass: ` + r.out.slice(0, 400)); }
  } finally { s.done(); }
});
test('p2_12.validate_rejects_missing_or_unparseable_file', () => {
  const s = factsSite();
  try {
    let r = s.validateDl(undefined); assert.ok(!r.ok && /deadlines/i.test(r.out) && /missing|not valid JSON/.test(r.out), 'missing file: ' + r.out.slice(0, 300));
    r = s.validateDl('{not json'); assert.ok(!r.ok && /deadlines/i.test(r.out), 'bad JSON');
    r = s.validateDl('"text"'); assert.ok(!r.ok && /deadlines/i.test(r.out) && /array/i.test(r.out), 'non-array');
    r = s.validateDl('{"id":"uk-x"}'); assert.ok(!r.ok && /deadlines/i.test(r.out) && /array/i.test(r.out), 'object instead of array');
  } finally { s.done(); }
});
test('p2_12.validate_rejects_bad_deadlines', () => {
  const s = factsSite();
  const f = dlFix, noKey = (o, k) => { const { [k]: _, ...rest } = o; return rest; };
  const rule = (frequency, r, o = {}) => [dlFix({ frequency, rule: r, ...o })];
  const cases = {
    entry_not_object: [[1], /deadline must be an object/], entry_array: [[[]], /deadline must be an object/], entry_null: [[null], /deadline must be an object/],
    unknown_field: [[f({ extra: 1 })], /unknown field "extra"/], unknown_field_weekend_typo: [[f({ weekendnote: 'x' })], /unknown field "weekendnote"/], unknown_field_region: [[f({ region: 'europe' })], /unknown field "region"/],
    id_missing: [[noKey(f(), 'id')], /id must be kebab-case/], id_upper: [[f({ id: 'UK-Paye' })], /id must be kebab-case/], id_underscore: [[f({ id: 'uk_paye' })], /id must be kebab-case/], id_leading_dash: [[f({ id: '-uk' })], /id must be kebab-case/],
    id_trailing_dash: [[f({ id: 'uk-' })], /id must be kebab-case/], id_double_dash: [[f({ id: 'uk--paye' })], /id must be kebab-case/], id_space: [[f({ id: 'uk paye' })], /id must be kebab-case/], id_empty: [[f({ id: '' })], /id must be kebab-case/],
    id_number: [[f({ id: 5 })], /id must be kebab-case/], id_dot: [[f({ id: 'uk.paye' })], /id must be kebab-case/], id_unicode: [[f({ id: 'uk-p\u00e4ye' })], /id must be kebab-case/],
    duplicate_id: [[f(), f({ title: 'Another title' })], /duplicate id "uk-paye-payment"/],
    country_unknown: [[f({ country: 'atlantis' })], /country must be a known country code/], country_proto: [[f({ country: 'constructor' })], /country must be a known country code/], country_case: [[f({ country: 'UK' })], /country must be a known country code/],
    country_missing: [[noKey(f(), 'country')], /country must be a known country code/], country_number: [[f({ country: 44 })], /country must be a known country code/],
    title_missing: [[noKey(f(), 'title')], /title/], title_empty: [[f({ title: '' })], /title/], title_untrimmed: [[f({ title: ' PAYE' })], /title/], title_markup: [[f({ title: 'PAYE <b>x</b>' })], /title.*plain text/], title_gt: [[f({ title: 'a > b' })], /title.*plain text/],
    title_newline: [[f({ title: 'PAYE\npayment' })], /title.*control/], title_tab: [[f({ title: 'PAYE\tpayment' })], /title.*control/], title_bidi: [[f({ title: 'PAYE \u202E payment' })], /title.*control/], title_zero_width: [[f({ title: 'PAYE\u200B payment' })], /title.*control/],
    title_bom: [[f({ title: 'PAYE\uFEFF payment' })], /title.*control/], title_long: [[f({ title: 't'.repeat(121) })], /title.*120/], title_number: [[f({ title: 12 })], /title/],
    kind_missing: [[noKey(f(), 'kind')], /kind must be one of payment, filing, both/], kind_unknown: [[f({ kind: 'reporting' })], /kind must be one of payment, filing, both/], kind_case: [[f({ kind: 'Payment' })], /kind must be one of payment, filing, both/],
    kind_proto: [[f({ kind: 'constructor' })], /kind must be one of/], kind_array: [[f({ kind: ['payment'] })], /kind must be one of/],
    frequency_missing: [[noKey(f(), 'frequency')], /frequency must be one of monthly, quarterly, annual/], frequency_weekly: [[f({ frequency: 'weekly' })], /frequency must be one of monthly, quarterly, annual/], frequency_case: [[f({ frequency: 'Monthly' })], /frequency must be one of/],
    frequency_proto: [[f({ frequency: 'constructor' })], /frequency must be one of/],
    rule_missing: [[noKey(f(), 'rule')], /rule must be an object/], rule_null: [[f({ rule: null })], /rule must be an object/], rule_array: [[f({ rule: [22, 1] })], /rule must be an object/], rule_string: [[f({ rule: '22' })], /rule must be an object/],
    rule_unknown_field: [rule('monthly', { day: 22, monthOffset: 1, extra: 1 }), /rule unknown field "extra"/], monthly_with_months: [rule('monthly', { day: 22, monthOffset: 1, months: [1, 4, 7, 10] }), /rule unknown field "months"/],
    monthly_with_month: [rule('monthly', { day: 22, monthOffset: 1, month: 5 }), /rule unknown field "month"/], quarterly_with_month: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 4, 7, 10], month: 1 }), /rule unknown field "month"/],
    annual_with_months: [rule('annual', { day: 10, monthOffset: 0, month: 1, months: [1, 4, 7, 10] }), /rule unknown field "months"/],
    monthly_day_31: [rule('monthly', { day: 31, monthOffset: 0 }), /rule day/], monthly_day_29: [rule('monthly', { day: 29, monthOffset: 1 }), /rule day/], monthly_day_30: [rule('monthly', { day: 30, monthOffset: 1 }), /rule day/], monthly_day_0: [rule('monthly', { day: 0, monthOffset: 0 }), /rule day/],
    monthly_day_neg: [rule('monthly', { day: -1, monthOffset: 0 }), /rule day/], monthly_day_float: [rule('monthly', { day: 2.5, monthOffset: 0 }), /rule day/], monthly_day_string: [rule('monthly', { day: '22', monthOffset: 0 }), /rule day/],
    monthly_day_LAST: [rule('monthly', { day: 'LAST', monthOffset: 0 }), /rule day/], monthly_day_null: [rule('monthly', { day: null, monthOffset: 0 }), /rule day/], monthly_day_missing: [rule('monthly', { monthOffset: 0 }), /rule day/],
    quarterly_day_29: [rule('quarterly', { day: 29, monthOffset: 0, months: [1, 4, 7, 10] }), /rule day/], quarterly_day_31: [rule('quarterly', { day: 31, monthOffset: 0, months: [1, 4, 7, 10] }), /rule day/],
    annual_feb_29: [rule('annual', { day: 29, monthOffset: 0, month: 2 }), /rule day/], annual_feb_30: [rule('annual', { day: 30, monthOffset: 0, month: 2 }), /rule day/], annual_apr_31: [rule('annual', { day: 31, monthOffset: 0, month: 4 }), /rule day/],
    annual_jun_31: [rule('annual', { day: 31, monthOffset: 0, month: 6 }), /rule day/], annual_day_32: [rule('annual', { day: 32, monthOffset: 0, month: 1 }), /rule day/], annual_day_0: [rule('annual', { day: 0, monthOffset: 0, month: 1 }), /rule day/],
    monthly_offset_missing: [rule('monthly', { day: 22 }), /rule monthOffset/], monthly_offset_2: [rule('monthly', { day: 22, monthOffset: 2 }), /rule monthOffset/], monthly_offset_neg: [rule('monthly', { day: 22, monthOffset: -1 }), /rule monthOffset/],
    monthly_offset_string: [rule('monthly', { day: 22, monthOffset: '1' }), /rule monthOffset/], monthly_offset_float: [rule('monthly', { day: 22, monthOffset: 0.5 }), /rule monthOffset/], monthly_offset_true: [rule('monthly', { day: 22, monthOffset: true }), /rule monthOffset/],
    quarterly_offset_1: [rule('quarterly', { day: 10, monthOffset: 1, months: [1, 4, 7, 10] }), /rule monthOffset/], quarterly_offset_missing: [rule('quarterly', { day: 10, months: [1, 4, 7, 10] }), /rule monthOffset/],
    annual_offset_1: [rule('annual', { day: 10, monthOffset: 1, month: 1 }), /rule monthOffset/], annual_offset_missing: [rule('annual', { day: 10, month: 1 }), /rule monthOffset/],
    quarterly_months_missing: [rule('quarterly', { day: 10, monthOffset: 0 }), /rule months/], quarterly_three: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 4, 7] }), /rule months/], quarterly_five: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 3, 5, 7, 9] }), /rule months/],
    quarterly_dupes: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 4, 4, 10] }), /rule months/], quarterly_unsorted: [rule('quarterly', { day: 10, monthOffset: 0, months: [4, 7, 10, 1] }), /rule months/],
    quarterly_descending: [rule('quarterly', { day: 10, monthOffset: 0, months: [10, 7, 4, 1] }), /rule months/], quarterly_13: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 4, 7, 13] }), /rule months/],
    quarterly_0: [rule('quarterly', { day: 10, monthOffset: 0, months: [0, 4, 7, 10] }), /rule months/], quarterly_strings: [rule('quarterly', { day: 10, monthOffset: 0, months: ['1', '4', '7', '10'] }), /rule months/],
    quarterly_consecutive: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 2, 3, 4] }), /rule months/], quarterly_one_off: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 4, 7, 11] }), /rule months/],
    quarterly_mixed: [rule('quarterly', { day: 10, monthOffset: 0, months: [2, 3, 8, 12] }), /rule months/],
    id_upcoming: [[f({ id: 'upcoming' })], /id .*reserved/], id_deadlines: [[f({ id: 'deadlines' })], /id .*reserved/], id_country_slug: [[f({ id: 'spain' })], /id .*reserved/], id_country_slug_multiword: [[f({ id: 'united-kingdom' })], /id .*reserved/],
    weekendSourceUrl_without_note: [[f({ weekendSourceUrl: 'https://www.gov.uk/x' })], /weekendSourceUrl.*weekendNote/], weekendSourceUrl_http: [[f({ weekendNote: 'Moves to the next working day.', weekendSourceUrl: 'http://www.gov.uk/x' })], /weekendSourceUrl/],
    weekendSourceUrl_junk: [[f({ weekendNote: 'Moves to the next working day.', weekendSourceUrl: 'javascript:alert(1)' })], /weekendSourceUrl/], weekendSourceUrl_ip: [[f({ weekendNote: 'Moves to the next working day.', weekendSourceUrl: 'https://10.0.0.1/x' })], /weekendSourceUrl/],
    weekendSourceUrl_userinfo: [[f({ weekendNote: 'Moves to the next working day.', weekendSourceUrl: 'https://a:b@www.gov.uk/x' })], /weekendSourceUrl/], weekendSourceUrl_number: [[f({ weekendNote: 'Moves to the next working day.', weekendSourceUrl: 5 })], /weekendSourceUrl/],
    quarterly_not_array: [rule('quarterly', { day: 10, monthOffset: 0, months: '1,4,7,10' }), /rule months/], quarterly_float: [rule('quarterly', { day: 10, monthOffset: 0, months: [1, 4, 7, 10.5] }), /rule months/],
    annual_month_missing: [rule('annual', { day: 10, monthOffset: 0 }), /rule month must/], annual_month_0: [rule('annual', { day: 10, monthOffset: 0, month: 0 }), /rule month must/], annual_month_13: [rule('annual', { day: 10, monthOffset: 0, month: 13 }), /rule month must/],
    annual_month_string: [rule('annual', { day: 10, monthOffset: 0, month: '1' }), /rule month must/], annual_month_float: [rule('annual', { day: 10, monthOffset: 0, month: 1.5 }), /rule month must/],
    ruleText_missing: [[noKey(f(), 'ruleText')], /ruleText/], ruleText_empty: [[f({ ruleText: ' ' })], /ruleText/], ruleText_markup: [[f({ ruleText: 'Pay <script>alert(1)</script>' })], /ruleText.*plain text/], ruleText_control: [[f({ ruleText: 'a\nb' })], /ruleText.*control/],
    ruleText_long: [[f({ ruleText: 'r'.repeat(301) })], /ruleText.*300/], ruleText_bidi: [[f({ ruleText: 'a\u2067b' })], /ruleText.*control/],
    appliesTo_empty: [[f({ appliesTo: '' })], /appliesTo/], appliesTo_markup: [[f({ appliesTo: 'Large <i>employers</i>' })], /appliesTo.*plain text/], appliesTo_long: [[f({ appliesTo: 'a'.repeat(121) })], /appliesTo.*120/], appliesTo_control: [[f({ appliesTo: 'a\tb' })], /appliesTo.*control/],
    weekendNote_empty: [[f({ weekendNote: '' })], /weekendNote/], weekendNote_markup: [[f({ weekendNote: 'See <a href="x">this</a>' })], /weekendNote.*plain text/], weekendNote_long: [[f({ weekendNote: 'w'.repeat(201) })], /weekendNote.*200/],
    weekendNote_control: [[f({ weekendNote: 'a\u0007b' })], /weekendNote.*control/], weekendNote_null: [[f({ weekendNote: null })], /weekendNote/],
    url_http: [[f({ sourceUrl: 'http://www.gov.uk/x' })], /sourceUrl/], url_userinfo: [[f({ sourceUrl: 'https://user:pw@www.gov.uk/x' })], /sourceUrl/], url_js: [[f({ sourceUrl: 'javascript:alert(1)' })], /sourceUrl/], url_space: [[f({ sourceUrl: 'https://www.gov.uk/a b' })], /sourceUrl/],
    url_quote: [[f({ sourceUrl: 'https://www.gov.uk/a"b' })], /sourceUrl/], url_missing: [[noKey(f(), 'sourceUrl')], /sourceUrl/], url_ip: [[f({ sourceUrl: 'https://192.168.0.1/x' })], /sourceUrl/], url_localhost: [[f({ sourceUrl: 'https://localhost/x' })], /sourceUrl/],
    url_angle: [[f({ sourceUrl: 'https://www.gov.uk/a<b' })], /sourceUrl/],
    label_pattern: [[f({ sourceLabel: 'GOV.UK' })], /sourceLabel/], label_missing: [[noKey(f(), 'sourceLabel')], /sourceLabel/], label_markup: [[f({ sourceLabel: 'Source: GOV.UK - <b>x</b>' })], /sourceLabel.*plain text/],
    label_control: [[f({ sourceLabel: 'Source: GOV.UK - a\tb' })], /sourceLabel.*control/], label_long: [[f({ sourceLabel: 'Source: X - ' + 'y'.repeat(190) })], /sourceLabel.*200/],
    checked_missing: [[noKey(f(), 'checked')], /checked/], checked_not_real: [[f({ checked: '2026-02-30' })], /checked/], checked_format: [[f({ checked: '2026-1-5' })], /checked/], checked_future: [[f({ checked: ymd(2) })], /checked.*in the future/], checked_number: [[f({ checked: 20261004 })], /checked/],
  };
  try {
    assert.ok(s.validateDl([f()]).ok, 'baseline fixture must pass: ' + s.validateDl([f()]).out.slice(0, 300));
    for (const [name, [data, re]] of Object.entries(cases)) {
      const r = s.validateDl(data);
      assert.ok(!r.ok && /deadlines/i.test(r.out) && re.test(r.out), `validate.mjs must reject deadlines case "${name}" with a message naming "deadlines" and matching ${re}: ` + r.out.slice(0, 400));
    }
  } finally { s.done(); }
});
test('p2_12.validate_warns_when_stale_but_passes', () => {
  const s = factsSite();
  try {
    let r = s.validateDl([dlFix({ checked: ymd(-370) })]); assert.ok(r.ok, 'stale deadline must not fail: ' + r.out.slice(0, 300));
    assert.ok(/WARNING/.test(r.out) && /deadlines/i.test(r.out.split('\n').filter(l => /WARNING/.test(l)).join('\n')) && /365/.test(r.out), 'WARNING line naming "deadlines" and 365: ' + r.out.slice(0, 400));
    r = s.validateDl([dlFix({ checked: ymd(-360) })]); assert.ok(r.ok && !/WARNING.*deadlines/i.test(r.out), 'a deadline checked 360 days ago must not warn');
    r = s.validateDl([dlFix({ checked: ymd(0) })]); assert.ok(r.ok && !/WARNING.*deadlines/i.test(r.out), 'a fresh deadline must not warn');
  } finally { s.done(); }
});
test('p2_12.validate_applies_the_app_js_guard_rules_to_deadlines_js', () => {
  const s = factsSite();
  try {
    const p = path.join(s.dir, 'deadlines.js'), orig = fs.readFileSync(p, 'utf8');
    let r = s.run('validate.mjs'); assert.ok(r.ok, 'the real deadlines.js passes the guard rules: ' + r.out.slice(0, 500));
    const cases = {
      handler: ['\nel.innerHTML = \'<a onclick="x()">y</a>\';\n', /deadlines\.js: inline event handler/], style: ['\nel.innerHTML = \'<p style="color:red">y</p>\';\n', /deadlines\.js: inline style attribute/],
      js_url: ['\nel.innerHTML = \'<a href="javascript:alert(1)">y</a>\';\n', /deadlines\.js: javascript: URL/], xss_template: ['\nel.innerHTML = `<p>${params}</p>`;\n', /deadlines\.js:\d+: unescaped user-controlled value/],
    };
    for (const [name, [add, re]] of Object.entries(cases)) { fs.writeFileSync(p, orig + add); r = s.run('validate.mjs'); assert.ok(!r.ok && re.test(r.out), `${name}: ` + r.out.slice(0, 400)); }
    fs.writeFileSync(p, orig);
  } finally { s.done(); }
});

// ----- real page, JSON and calendars -----
const dlReal = () => {
  const list = loadDeadlines(), D = dlNewest(list, VER22);
  assert.ok(list.length >= 26);
  return { list, D };
};
test('p2_12.page_exists_with_seo_head_jsonld_sitemap_and_scripts', () => {
  const { list, D } = dlReal();
  assert.ok(fs.existsSync(path.join(ROOT, 'deadlines.html')), 'deadlines.html not generated by build-pages.mjs');
  const h = read('deadlines.html'), url = SITE_URL + 'deadlines.html', { s } = dlPageChecks(h, list, VER22, 'real');
  assert.equal(s.canonical, url); assert.equal(s.ogUrl, url); assert.equal(s.h1s, 1);
  assert.equal(s.ogTitle, s.title); assert.equal(s.twTitle, s.title); assert.equal(s.ogDesc, s.desc); assert.equal(s.twDesc, s.desc);
  assert.ok(h.includes('<h1>Payroll deadlines by country</h1>'), 'h1');
  assert.match(h, /<link rel="stylesheet" href="legal\.css">/); assert.match(h, /Content-Security-Policy/);
  const csp = (h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
  assert.ok(!/unsafe-/.test(csp) && !/script-src 'none'/.test(csp) && /(default-src|script-src) 'self'/.test(csp), 'CSP allows same-origin scripts and fetch (default-src or script-src/connect-src self) and nothing unsafe: ' + csp);
  assert.ok(!/connect-src 'none'/.test(csp), 'CSP must not block fetch of deadlines.json');
  assert.ok(!/\son[a-z]+=|\sstyle=/i.test(h) && !INLINE_SCRIPT.test(h), 'CSP: no inline handlers/styles/scripts');
  const scripts = [...h.matchAll(/<script\b[^>]*>/g)].map(m => m[0]).filter(t => !/application\/ld\+json/.test(t));
  assert.deepEqual(scripts, ['<script src="filters.js">', '<script src="deadlines.js">'], 'external scripts: filters.js then deadlines.js');
  assert.ok(h.indexOf('<script src="deadlines.js">') > h.indexOf('</footer>'), 'scripts come after the footer');
  const bc = byType(ldGraph(h, 'deadlines.html'), 'BreadcrumbList');
  assert.equal(bc.length, 1); assert.deepEqual(bc[0].itemListElement.map(i => [i.position, i.name, i.item]), [[1, 'Home', SITE_URL], [2, 'Payroll deadlines', url]]);
  assert.equal(sitemapMod(read('sitemap.xml'), 'deadlines.html'), D, 'sitemap lastmod = newest deadline checked date');
  assert.ok(publicPages().includes('deadlines.html'), 'part of the public page set (SEO uniqueness, breadcrumb and sitemap tests cover it)');
  if (D !== VER22) assert.ok(!hasWords(h, VER22), 'the page must not state the site-wide last verified date');
});
test('p2_12.page_intro_states_the_rules_and_the_disclaimer', () => {
  const h = read('deadlines.html'), main = mainOf(h), intro = main.slice(0, main.indexOf('<h2')), t = normWs(intro);
  assert.match(t, /recurring/i, 'recurring dates');
  assert.match(t, /If a date falls on a non-working day, check the source's rule/, 'exact sentence about non-working days');
  assert.match(t, /(weekend|holiday)[^.]*not (applied|shifted|moved|adjusted)|not (applied|shifted|moved|adjusted)[^.]*(weekend|holiday)/i, 'states that weekend and holiday shifting is not applied');
  assert.match(t, /employer size/i, 'deadlines can differ by employer size'); assert.match(t, /Applies to/, 'points to the "Applies to" column');
  assert.match(t, /stated by (the|each) (cited )?source/i, 'dates are the rules stated by the cited sources');
  assert.ok(t.includes('as stated by each cited source, or directly derived from it (the When column quotes the rule)') && !/exactly as stated/i.test(t), 'intro wording: stated by each cited source, or directly derived from it');;
  assert.ok(main.includes('href="countries.html"') && main.includes('href="keyfacts.html"'), 'main links back to countries.html and keyfacts.html');
  assert.ok(!/<h[3-6]\b/.test(main), 'static headings: h1 then h2 only');
  const ph = main.match(/<h2 id="upcoming">[^<]+<\/h2>\s*<div id="deadlines-upcoming">\s*<noscript>([\s\S]*?)<\/noscript>\s*<\/div>/);
  assert.ok(ph, 'upcoming heading + placeholder + noscript');
  assert.match(normWs(ph[1]), /JavaScript/); assert.match(normWs(ph[1]), /tables below/);
  assert.ok(main.indexOf('id="deadlines-upcoming"') < main.indexOf('<h2 id="' + [...dlNames.values()].find(n => n.slug === 'france').slug + '"'), 'placeholder comes before the country sections');
  assert.ok(squash(main).includes('<a class="cta" href="webcal://www.intelligentpayroll.eu/deadlines.ics">Subscribe in your calendar app</a> <a class="cta secondary" href="deadlines.ics">Download once (.ics)</a>'.replace(/> </g, '><')), 'calendar row with webcal subscribe and download links');
});
test('p2_12.page_tables_match_data_exactly', () => {
  const { list } = dlReal(), h = read('deadlines.html');
  dlPageChecks(h, list, VER22, 'real');
  for (const m of mainOf(h).matchAll(/href="(countries\/[^"]+)"/g)) assert.ok(resolves(m[1]), `${m[1]} resolves`);
  const weekendCells = [...mainOf(h).matchAll(/<tr id="([^"]+)">[\s\S]*?<\/tr>/g)].filter(m => !m[0].includes('<td>Check the source</td>')).map(m => m[1]);
  assert.deepEqual(weekendCells.sort(), BATCH1.filter(r => r[5]).map(r => r[0]).concat(['at-lohnabgaben-payment', 'at-kommunalsteuer-payment', 'at-sv-contributions-payment', 'cz-health-insurance-payment', 'pl-zus-contributions-legal-entities', 'pl-zus-contributions-other-payers', 'no-a-melding-monthly', 'fi-incomes-register-separate-report', 'fi-employer-contributions-payment']).sort(), 'the "Non-working day" cell shows the note exactly for the deadlines that have one');
});
test('p2_12.footers_nav_keyfacts_and_country_pages_link_to_the_page', () => {
  const gen = allGenerated(); assert.ok(gen.includes('deadlines.html'));
  for (const f of gen) {
    const d = f.startsWith('countries/') ? '../' : '', h = read(f), ft = footerOf(h), a = `<a href="${d}deadlines.html">Deadlines</a>`;
    assert.ok(ft.includes(a), `${f}: footer link "Deadlines"`);
    assert.ok(ft.indexOf(`<a href="${d}minimum-wage-europe.html">Minimum wage</a>`) < ft.indexOf(a) && ft.indexOf(a) < ft.indexOf(`<a href="${d}glossary.html">Glossary</a>`), `${f}: footer order Minimum wage, Deadlines, Glossary`);
    assert.ok(!/deadlines\.html/.test(headerOf(h)), `${f}: no header nav change`);
  }
  const idx = read('index.html');
  assert.ok(!/deadlines\.html/.test((idx.match(/<header>[\s\S]*?<\/header>/) || [''])[0]), 'index.html header unchanged');
  assert.equal(idx.split('href="deadlines.html"').length - 1, 1, 'index.html links the page once (footer)');
  const kmain = mainOf(read('keyfacts.html'));
  assert.equal(kmain.split('href="deadlines.html"').length - 1, 1, 'keyfacts.html main links to the page once');
  assert.ok(((kmain.match(/<\/h1>\s*<p>([\s\S]*?)<\/p>/) || ['', ''])[1]).includes('<a href="deadlines.html">'), 'keyfacts.html: the intro paragraph holds the link');
  const dh = read('deadlines.html'), ids = new Set([...dh.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])), withDl = new Set(loadDeadlines().map(d => d.country));
  for (const f of countryFiles.filter(f => f.endsWith('.html'))) {
    const code = slugToCode.get(f.replace(/\.html$/, '')), intro = introOf(read(`countries/${f}`)), slug = f.replace(/\.html$/, '');
    if (withDl.has(code)) {
      assert.equal(intro.split(`<a href="../deadlines.html#${slug}">Payroll deadlines</a>`).length - 1, 1, `${f}: intro links its deadlines section once`);
      assert.ok(ids.has(slug), `${f}: deadlines.html has id="${slug}"`);
    } else assert.ok(!/deadlines\.html/.test(intro), `${f}: no deadlines link without deadlines`);
  }
});
test('p2_12.json_is_generated_from_the_data', () => {
  const { list } = dlReal(); assert.ok(fs.existsSync(path.join(ROOT, 'deadlines.json')), 'deadlines.json not generated');
  const countries = {}; for (const c of dlCountries(list)) countries[c] = dlNames.get(c);
  assert.equal(read('deadlines.json'), JSON.stringify({ countries, deadlines: list }, null, 0) + '\n', 'byte-exact: {countries (by name), deadlines (as in data/deadlines.json)}');
  assert.deepEqual(Object.keys(JSON.parse(read('deadlines.json')).countries), dlCountries(list), 'country order = by name');
});
test('p2_12.ics_real_calendars', () => {
  const { list, D } = dlReal(); assert.ok(fs.existsSync(path.join(ROOT, 'deadlines.ics')), 'deadlines.ics not generated');
  const all = icsAt(path.join(ROOT, 'deadlines.ics'), 'deadlines.ics');
  checkDlHeader(all, 'Intelligent Payroll: payroll deadlines', 'deadlines.ics'); checkDlEvents('deadlines.ics', all, list, VER22, D, 'deadlines.ics');
  const dir = path.join(ROOT, 'deadlines'); assert.ok(fs.existsSync(dir), 'deadlines/ directory missing');
  const want = dlCountries(list).map(c => dlNames.get(c).slug + '.ics').sort();
  assert.deepEqual(fs.readdirSync(dir).sort(), want, 'deadlines/<slug>.ics exists exactly for countries with deadlines (and nothing else is in the folder)');
  for (const c of dlCountries(list)) {
    const { name, slug } = dlNames.get(c), mine = list.filter(d => d.country === c), f = `deadlines/${slug}.ics`, ev = icsAt(path.join(ROOT, f), f);
    checkDlHeader(ev, `Intelligent Payroll: ${name} payroll deadlines`, f); checkDlEvents(f, ev, mine, VER22, D, f);
  }
  for (const e of all.events) {
    const d = list.find(x => `${x.id}@${DL_DOMAIN}` === e.UID);
    assert.equal(e['DTSTART;VALUE=DATE'], plainArr(P2.occurrences(d, VER22, 1))[0].replace(/-/g, ''), `${d.id}: DTSTART = first occurrence on/after LAST_VERIFIED`);
    const desc = icsUnesc(e.DESCRIPTION);
    assert.ok(desc.includes(d.ruleText) && desc.includes('Source: ' + d.sourceUrl) && (desc.includes('Non-working day: ' + d.weekendNote) || desc.includes('Non-working-day rule: check the source.')), `${d.id}: description content`);
  }
  // spot checks of the literal RRULE strings
  const rr = id => all.events.find(e => e.UID === `${id}@${DL_DOMAIN}`).RRULE;
  assert.equal(rr('uk-paye-payment'), 'FREQ=MONTHLY;BYMONTHDAY=22'); assert.equal(rr('nl-loonaangifte-monthly'), 'FREQ=MONTHLY;BYMONTHDAY=-1');
  assert.equal(rr('de-lohnsteuer-anmeldung-quarterly'), 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'); assert.equal(rr('uk-p60'), 'FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=31');
  assert.equal(rr('de-lohnsteuerbescheinigung'), 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1');
});
test('p2_12.page_has_subscribe_and_download_links_for_all_and_per_country', () => {
  const { list } = dlReal(), main = squash(mainOf(read('deadlines.html')));
  assert.ok(main.includes('href="webcal://www.intelligentpayroll.eu/deadlines.ics">Subscribe in your calendar app</a>') && main.includes('href="deadlines.ics">Download once (.ics)</a>'));
  for (const c of dlCountries(list)) { const { name, slug } = dlNames.get(c); assert.ok(main.includes(`href="webcal://www.intelligentpayroll.eu/deadlines/${slug}.ics">Subscribe to ${escH(name)} deadlines</a>`) && main.includes(`href="deadlines/${slug}.ics">Download (.ics)</a>`), `${slug}: subscribe + download`); }
});
test('p2_12.build_is_deterministic_and_check_tracks_every_output', () => {
  const s = factsSite();
  try {
    const real = JSON.parse(read(DL_FILE));
    let r = s.buildDl(real); assert.ok(r.ok, r.out.slice(0, 400));
    const files = ['deadlines.html', 'deadlines.json', 'deadlines.ics', ...dlCountries(real).map(c => `deadlines/${dlNames.get(c).slug}.ics`), 'sitemap.xml', 'keyfacts.html'];
    const snap = Object.fromEntries(files.map(f => [f, s.read(f)]));
    s.run('build-pages.mjs'); for (const f of files) assert.equal(s.read(f), snap[f], `${f}: second build byte-identical`);
    for (const f of ['deadlines.html', 'deadlines.json', 'deadlines.ics', 'deadlines/spain.ics']) assert.equal(s.read(f), read(f), `${f}: build output of the real data equals the committed file`);
    r = s.run('build-pages.mjs', '--check'); assert.ok(r.ok, r.out.slice(0, 300));
    for (const f of ['deadlines.html', 'deadlines.json', 'deadlines.ics', 'deadlines/spain.ics']) {
      const p = path.join(s.dir, f), orig = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, orig + ' '); r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && new RegExp(f.replace(/[./]/g, '\\$&') + ' is out of date').test(r.out), `tampered ${f}: ` + r.out.slice(0, 300));
      fs.rmSync(p); r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && new RegExp(f.replace(/[./]/g, '\\$&') + ' is missing').test(r.out), `deleted ${f}: ` + r.out.slice(0, 300));
      fs.writeFileSync(p, orig);
    }
    // stale per-country file
    fs.writeFileSync(path.join(s.dir, 'deadlines/zz-nowhere.ics'), 'x'); r = s.run('build-pages.mjs', '--check');
    assert.ok(!r.ok && /deadlines\/zz-nowhere\.ics is no longer generated \(delete it\)/.test(r.out), 'stale deadlines/*.ics: ' + r.out.slice(0, 300));
    s.run('build-pages.mjs'); assert.ok(!s.exists('deadlines/zz-nowhere.ics'), 'a normal build deletes stale deadlines/*.ics'); assert.ok(s.run('build-pages.mjs', '--check').ok);
    // changing the data makes everything derived stale
    const changed = JSON.parse(JSON.stringify(real)); changed[0].ruleText = 'A changed rule text.'; s.setDeadlines(changed);
    r = s.run('build-pages.mjs', '--check'); assert.ok(!r.ok && ['deadlines.html', 'deadlines.json', 'deadlines.ics', 'deadlines/united-kingdom.ics'].every(f => r.out.includes(f + ' is out of date')), 'changed data: ' + r.out.slice(0, 500));
  } finally { s.done(); }
});

test('p2_12.quarterly_rrule_expansion_equals_occurrences_for_four_years', () => {
  const { list } = dlReal(), quarterly = list.filter(d => d.frequency === 'quarterly'); assert.ok(quarterly.length >= 3);
  const all = icsAt(path.join(ROOT, 'deadlines.ics'), 'deadlines.ics');
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  // A tiny expander for FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=k (negative = from the end of the month), starting at DTSTART.
  const expand = (rrule, dtstart, count) => {
    const m = rrule.match(/^FREQ=MONTHLY;INTERVAL=(\d+);BYMONTHDAY=(-?\d+)$/); assert.ok(m, 'quarterly rule is FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=n: ' + rrule);
    const step = +m[1], bd = +m[2], out = []; let y = +dtstart.slice(0, 4), mo = +dtstart.slice(4, 6);
    while (out.length < count) {
      const day = bd > 0 ? bd : dim(y, mo) + 1 + bd, iso = y + '-' + String(mo).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      if (iso.replace(/-/g, '') >= dtstart) out.push(iso);
      mo += step; while (mo > 12) { mo -= 12; y++; }
    }
    return out;
  };
  for (const d of quarterly) {
    const ev = all.events.find(e => e.UID === d.id + '@' + DL_DOMAIN), start = ev['DTSTART;VALUE=DATE'];
    assert.ok(/INTERVAL=3/.test(ev.RRULE) && !/BYMONTH=/.test(ev.RRULE), d.id + ': portable rule without BYMONTH');
    assert.deepEqual(expand(ev.RRULE, start, 16), plainArr(P2.occurrences(d, VER22, 16)), d.id + ': 4 years of the calendar rule = occurrences()');
  }
});
test('p2_12.build_check_and_write_handle_nested_files_in_deadlines', () => {
  const s = factsSite();
  try {
    const real = JSON.parse(read(DL_FILE)); assert.ok(s.buildDl(real).ok);
    fs.mkdirSync(path.join(s.dir, 'deadlines/old/deeper'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'deadlines/old/deeper/x.ics'), 'x'); fs.writeFileSync(path.join(s.dir, 'deadlines/notes.txt'), 'x');
    let r = s.run('build-pages.mjs', '--check');
    assert.ok(!r.ok && /deadlines\/old\/deeper\/x\.ics is no longer generated \(delete it\)/.test(r.out) && /deadlines\/notes\.txt is no longer generated/.test(r.out), 'nested and non-ics files are reported: ' + r.out.slice(0, 400));
    s.run('build-pages.mjs');
    assert.ok(!s.exists('deadlines/old/deeper/x.ics') && !s.exists('deadlines/notes.txt') && !s.exists('deadlines/old'), 'a normal build removes them and the empty folders');
    assert.ok(s.exists('deadlines/spain.ics') && s.run('build-pages.mjs', '--check').ok);
  } finally { s.done(); }
});

// ----- fixtures -----
const dlSet = () => [
  dlFix({ id: 'es-monthly', country: 'spain', title: 'Spain monthly return', kind: 'both', rule: { day: 'last', monthOffset: 1 }, ruleText: 'By the last day of the following month.', appliesTo: 'Large employers', weekendNote: 'A non-working last day moves the deadline to the next working day.', weekendSourceUrl: 'https://sede.agenciatributaria.gob.es/w?x=1&y=2', sourceUrl: 'https://sede.agenciatributaria.gob.es/a?x=1&y=2', sourceLabel: 'Source: AEAT - Modelo 111', checked: '2026-11-05' }),
  dlQ({ id: 'de-quarterly', title: 'Lohnsteuer quarterly', kind: 'both', ruleText: 'On the 10th after each calendar quarter.', sourceUrl: 'https://www.gesetze-im-internet.de/estg/__41a.html', sourceLabel: 'Source: BMJ - 41a EStG', checked: '2026-10-02' }),
  dlA({ id: 'uk-annual-feb', title: 'UK annual (Feb)', rule: { day: 'last', monthOffset: 0, month: 2 }, ruleText: 'By the end of February.', checked: '2026-10-03' }),
  dlFix({ id: 'uk-monthly', title: 'UK monthly payment', checked: '2026-10-04' }),
  dlA({ id: 'uk-annual-may', title: 'UK annual (May)', ruleText: 'By 31 May.', checked: '2026-09-30' }),
];
const dlLv = lv => ({ appEdit: js => js.replace(/(new Date\(')\d{4}-\d{2}-\d{2}(T)/, (_, a, b) => a + lv + b) });
test('p2_12.fixture_pages_json_and_calendars_follow_the_data', () => {
  for (const lv of ['2026-10-01', '2028-02-15']) {
    const s = factsSite(undefined, dlLv(lv));
    try {
      const data = dlSet(), r = s.buildDl(data); assert.ok(r.ok, r.out.slice(0, 500));
      const D = dlNewest(data, lv); assert.equal(D, '2026-11-05');
      const h = s.read('deadlines.html'), { main } = dlPageChecks(h, data, lv, 'fixture@' + lv);
      assert.deepEqual([...main.matchAll(/<h2 id="([^"]+)">/g)].map(m => m[1]).slice(1), ['germany', 'spain', 'united-kingdom'], 'countries alphabetical by name');
      assert.equal(sitemapMod(s.read('sitemap.xml'), 'deadlines.html'), D, 'lastmod = newest checked even when later than LAST_VERIFIED');
      assert.ok(footerOf(s.read('countries/spain.html')).includes('Sources last checked ' + fmtLong(lv) + '.'), 'country pages keep LAST_VERIFIED text');
      const countries = {}; for (const c of ['germany', 'spain', 'uk']) countries[c] = dlNames.get(c);
      assert.equal(s.read('deadlines.json'), JSON.stringify({ countries, deadlines: data }, null, 0) + '\n');
      const all = icsAt(path.join(s.dir, 'deadlines.ics'), 'fixture deadlines.ics'); checkDlHeader(all, 'Intelligent Payroll: payroll deadlines', 'fixture'); checkDlEvents('', all, data, lv, D, 'fixture@' + lv);
      assert.deepEqual(fs.readdirSync(path.join(s.dir, 'deadlines')).sort(), ['germany.ics', 'spain.ics', 'united-kingdom.ics']);
      for (const [code, f] of [['uk', 'united-kingdom'], ['spain', 'spain'], ['germany', 'germany']]) checkDlEvents('', icsAt(path.join(s.dir, `deadlines/${f}.ics`), f), data.filter(d => d.country === code), lv, D, f);
      // RRULE strings, literally
      const rr = id => all.events.find(e => e.UID === `${id}@${DL_DOMAIN}`);
      assert.equal(rr('uk-monthly').RRULE, 'FREQ=MONTHLY;BYMONTHDAY=22'); assert.equal(rr('es-monthly').RRULE, 'FREQ=MONTHLY;BYMONTHDAY=-1');
      assert.equal(rr('de-quarterly').RRULE, 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10'); assert.equal(rr('uk-annual-feb').RRULE, 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1'); assert.equal(rr('uk-annual-may').RRULE, 'FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=31');
      // DTSTART = first occurrence on/after LAST_VERIFIED
      const starts = lv === '2026-10-01'
        ? { 'uk-monthly': '20261022', 'es-monthly': '20261031', 'de-quarterly': '20261010', 'uk-annual-feb': '20270228', 'uk-annual-may': '20270531' }
        : { 'uk-monthly': '20280222', 'es-monthly': '20280229', 'de-quarterly': '20280410', 'uk-annual-feb': '20280229', 'uk-annual-may': '20280531' };
      for (const [id, v] of Object.entries(starts)) assert.equal(rr(id)['DTSTART;VALUE=DATE'], v, `${id} DTSTART @${lv}`);
      assert.ok(s.run('build-pages.mjs', '--check').ok, '--check green');
    } finally { s.done(); }
  }
});
test('p2_12.fixture_country_pages_link_only_with_deadlines', () => {
  const s = factsSite();
  try {
    assert.ok(s.buildDl([dlFix({ id: 'es-monthly', country: 'spain' })]).ok);
    const sp = introOf(s.page('spain')), uk = introOf(s.page('united-kingdom'));
    assert.equal(sp.split('<a href="../deadlines.html#spain">Payroll deadlines</a>').length - 1, 1);
    assert.ok(!/deadlines\.html/.test(uk), 'no link on a country without deadlines');
    assert.ok(!s.exists('deadlines/united-kingdom.ics') && s.exists('deadlines/spain.ics'), 'per-country calendar only for countries with deadlines');
    assert.ok(s.read('deadlines.html').includes('id="spain"') && !s.read('deadlines.html').includes('id="united-kingdom"'));
  } finally { s.done(); }
});
test('p2_12.fixture_empty_data_builds_a_valid_page_and_calendar', () => {
  const s = factsSite(undefined, dlLv('2027-02-03'));
  try {
    const r = s.buildDl([]); assert.ok(r.ok, r.out.slice(0, 400));
    const h = s.read('deadlines.html');
    assert.ok(!/<table\b/.test(h) && h.includes('id="deadlines-upcoming"'), 'no table without data');
    const ev = icsAt(path.join(s.dir, 'deadlines.ics'), 'empty'); assert.equal(ev.events.length, 0);
    assert.ok(!s.exists('deadlines') || fs.readdirSync(path.join(s.dir, 'deadlines')).length === 0, 'no per-country calendars');
    assert.equal(s.read('deadlines.json'), '{"countries":{},"deadlines":[]}\n');
    assert.equal(sitemapMod(s.read('sitemap.xml'), 'deadlines.html'), '2027-02-03', 'no deadlines: lastmod falls back to LAST_VERIFIED');
    assert.ok(footerOf(h).includes('Sources last checked 3 February 2027.'));
    assert.ok(s.run('build-pages.mjs', '--check').ok, '--check green (SEO rules hold with no data)');
  } finally { s.done(); }
});
test('p2_12.fixture_escapes_hostile_strings_everywhere', () => {
  const s = factsSite();
  try {
    const H = '<img src=x onerror=alert(1)>';
    const data = [dlFix({ id: 'uk-evil', title: `T ${H} "q" 's' & more`, ruleText: `R ${H} ; , \\ end`, appliesTo: `A ${H}`, weekendNote: `W ${H}`, sourceLabel: `Source: <u>Z</u> - "W" ${H}`, sourceUrl: 'https://example.org/a"onmouseover="x&y=1' })];
    const r = s.buildDl(data); assert.ok(r.ok, 'build without validate must not crash on hostile text: ' + r.out.slice(0, 400));
    const h = s.read('deadlines.html'), main = mainOf(h);
    assert.ok(!/<(img|u)\b/i.test(main.replace(/<a href="[^"]*"/g, '<a')), 'no raw tags from data');
    assert.ok(!/<[^>]*\son[a-z]+=/i.test(h.replace(/="[^"]*"/g, '=""')), 'no event-handler attribute');
    assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;') && h.includes('href="https://example.org/a&quot;onmouseover=&quot;x&amp;y=1"'));
    assert.ok(squash(main).includes(dlRow(data[0]).replace(/> </g, '><')), 'row equals the escaped expectation');
    const ev = icsAt(path.join(s.dir, 'deadlines.ics'), 'hostile'); checkDlEvents('', ev, data, VER22, '2026-10-04', 'hostile');
    const un = ev.logical.join('\n'); assert.ok(un.includes('\\;') && un.includes('\\,') && un.includes('\\\\') && un.includes('\\n'), 'ics text is escaped (; , \\ newline)');
  } finally { s.done(); }
});
test('p2_12.fixture_ics_lines_fold_at_75_octets_and_unfold_exactly', () => {
  const s = factsSite();
  try {
    const data = [dlFix({ id: 'uk-long', title: 'Zahlung \u{1F4B6} f\u00fcr Lohnsteuer \u00e4nderung \u4e2d\u6587 '.repeat(5).trim().slice(0, 120), ruleText: 'Lange Beschreibung mit Umlauten \u00e4\u00f6\u00fc, Kommas; und Semikolons. '.repeat(4).trim().slice(0, 300), appliesTo: '\u00dcberl\u00e4nge '.repeat(12).trim().slice(0, 120), sourceUrl: 'https://www.gov.uk/' + 'a'.repeat(150) })];
    assert.ok(s.buildDl(data).ok);
    const ev = icsAt(path.join(s.dir, 'deadlines.ics'), 'long');
    assert.ok(ev.raw.split('\r\n').some(l => l.startsWith(' ')), 'folded continuation lines exist');
    checkDlEvents('', ev, data, VER22, '2026-10-04', 'long');
    for (const l of ev.raw.split('\r\n')) assert.ok(!/[\uD800-\uDBFF]$/.test(l), 'no line ends in half a surrogate pair');
  } finally { s.done(); }
});
test('p2_12.fixture_page_is_data_driven_without_hard_coded_countries', () => {
  const s = factsSite();
  try {
    assert.ok(s.buildDl([dlFix({ id: 'es-monthly', country: 'spain', title: 'Only Spain' })]).ok);
    const main = mainOf(s.read('deadlines.html'));
    assert.ok(!/United Kingdom|Germany|France|Italy|Netherlands/.test(main), 'no hard-coded countries');
    assert.equal((main.match(/<table\b/g) || []).length, 1);
    const d = seoOf(s.read('deadlines.html'), 'deadlines.html').desc; assert.ok(/(^|\D)1(\D|$)/.test(d), 'description names 1 country / 1 deadline: ' + d);
    assert.ok(s.run('build-pages.mjs', '--check').ok);
  } finally { s.done(); }
});

// ----- docs, CI, link checking -----
test('p2_12.readme_documents_the_deadlines', () => {
  const readme = read('README.md'); assert.ok(readme.includes('### Payroll deadlines'), 'README needs a "### Payroll deadlines" section');
  const sec = readme.split('### Payroll deadlines')[1].split(/\n##+ /)[0];
  for (const re of [/`data\/deadlines\.json`/, /`weekendNote`/, /`weekendSourceUrl`/, /`monthOffset`/, /does not change the (date|dates)/, /INTERVAL=3|every third month/, /`months`/, /`ruleText`/, /`appliesTo`/, /`kind`/, /`frequency`/, /`sourceUrl`/, /`checked`/, /'last'|"last"|`last`/,
    /deadlines\.html/, /deadlines\.json/, /deadlines\.ics/, /deadlines\/<slug>\.ics|deadlines\/&lt;slug&gt;\.ics/, /no (automatic )?weekend|not (shifted|applied)/i, /holiday/i, /365 days/, /UTC today plus one day/, /How to add|how to add|To add a deadline/, /build-pages\.mjs/, /validate\.mjs/, /test-deadlines\.mjs/]) assert.match(sec, re, `README Payroll deadlines mentions ${re}`);
  const blocks = [...sec.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
  assert.ok(blocks.length >= 1, 'a README json example'); assert.ok(blocks.some(b => (Array.isArray(b) ? b : [b]).some(d => d.weekendNote)), 'an example with weekendNote');
  const s = factsSite();
  try { for (const b of blocks) { const r = s.validateDl(Array.isArray(b) ? b : [b]); assert.ok(r.ok, 'README example validates: ' + r.out.slice(0, 400)); } } finally { s.done(); }
  assert.match(readme.split('## On-page SEO')[1].split(/\n## /)[0], /deadlines\.html/, 'On-page SEO documents the deadlines page title and description');
});
test('p2_12.ci_and_hook_run_the_deadline_tests_and_links_are_checked', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/test-deadlines.mjs')));
  assert.match(read('.github/workflows/validate.yml'), /run: node scripts\/test-deadlines\.mjs/, 'CI runs scripts/test-deadlines.mjs');
  assert.match(read('scripts/hooks/pre-commit'), /node scripts\/test-deadlines\.mjs/, 'pre-commit runs scripts/test-deadlines.mjs');
  const cl = read('scripts/check-links.mjs'); assert.ok(/data\/deadlines\.json/.test(cl) && /deadlines\//.test(cl), 'check-links.mjs probes every deadlines sourceUrl (labelled deadlines/<id>)');
});
test('p2_12.css_deadlines_table_at_375px', () => {
  const css = read('legal.css').replace(/\/\*[\s\S]*?\*\//g, ''), screen = css.replace(/@media\s+print\s*\{[\s\S]*$/, '');
  const rule = sel => [...screen.matchAll(/(?<=^|\})\s*([^{}]*)\{([^}]*)\}/g)].filter(m => m[1].split(',').map(x => x.trim().replace(/\s+/g, ' ')).includes(sel)).map(m => m[2]).join(';');
  const t = rule('.deadlines');
  assert.match(t, /border-collapse\s*:\s*collapse/); assert.match(t, /width\s*:\s*100%/);
  const mw = t.match(/min-width\s*:\s*(\d+(?:\.\d+)?)rem/); assert.ok(mw && Number(mw[1]) >= 30 && Number(mw[1]) <= 64, '.deadlines min-width in rem (30 to 64): five columns scroll inside .table-scroll instead of crushing at 375px');
  const cells = rule('.deadlines th') + ';' + rule('.deadlines td') + ';' + [...screen.matchAll(/\.deadlines th,\s*\.deadlines td\s*\{([^}]*)\}/g)].map(m => m[1]).join(';');
  assert.match(cells, /border\s*:\s*1px solid var\(--border\)/); assert.match(cells, /padding\s*:/); assert.match(cells, /text-align\s*:\s*left/); assert.match(cells, /vertical-align\s*:\s*top/);
  assert.match(rule('.deadlines caption'), /text-align\s*:\s*left/);
  assert.match(rule('.deadline-meta'), /display\s*:\s*block|color\s*:/, '.deadline-meta is styled (muted, own line)');
  assert.match(screen, /\.deadline-chip[^{]*\{[^}]*(border|background)/, 'filter chips are styled on screen'); assert.match(screen, /\.deadline-chip\[aria-pressed="true"\]|\.deadline-chip\.active/, 'pressed chip looks different');
  assert.match(screen, /\.deadline-items[^{]*\{/, 'upcoming list is styled'); assert.ok(!/\.deadlines[^{]*\{[^}]*display\s*:\s*none/.test(screen), 'nothing in the table is hidden on screen');
  assert.match(screen, /\.deadline-(filter|chip)[^{]*\{[^}]*(flex-wrap\s*:\s*wrap|display\s*:\s*inline-flex|display\s*:\s*inline-block)/, 'chips wrap onto several lines on a phone');
});

console.log(`${passed} site tests passed.`);
