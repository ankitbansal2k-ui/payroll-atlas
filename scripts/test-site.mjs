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
  // P2-4: infrastructure button removed entirely (see p2_4.* tests).
  assert.ok(!/data-filter="upcoming"/.test(indexHtml), 'Upcoming moved out of the category buttons');
  assert.match(indexHtml, /data-filter="high-impact"/, 'high impact stays a category button');
});

// P2-4: five non-payroll entries dropped; infrastructure category removed.
const DROPPED = ['cn-vat', 'do-reporting', 'qa-reporting-upcoming', 'bh-tax-upcoming', 'kw-infrastructure'];
test('p2_4.entries_removed', () => {
  // CHANGES comes from another vm realm: spread into a local array before strict comparison.
  assert.deepEqual([...CHANGES.filter(e => DROPPED.includes(e.section)).map(key)], [], 'dropped sections still in CHANGES');
  assert.equal(CHANGES.length, 172);
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'app.js', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
  assert.ok(!/\son[a-z]+=|<script(?![^>]*\ssrc=)|\sstyle=/i.test(h), 'CSP: no inline handlers/scripts/styles');
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
  for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'scripts/build-pages.mjs', 'scripts/operator.json', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json', 'data/facts.json', 'data/glossary.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'scripts/templates'), path.join(dir, 'scripts/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.js'), appEdit ? appEdit(read('app.js')) : read('app.js'));
  if (fs.existsSync(path.join(ROOT, '.well-known'))) fs.cpSync(path.join(ROOT, '.well-known'), path.join(dir, '.well-known'), { recursive: true });
  const site = {
    dir,
    setFacts: v => { const p = path.join(dir, 'data/facts.json'); if (v === undefined) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); },
    run: (script, ...args) => { const r = spawnSync(process.execPath, ['scripts/' + script, ...args], { cwd: dir, encoding: 'utf8' }); return { ok: r.status === 0, out: String(r.stdout) + String(r.stderr) }; },
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
    assert.ok(!/\sstyle=|<script(?![^>]*\ssrc=)|<[a-z][^>]*\son[a-z]+=/i.test(h), 'CSP: no inline styles, scripts or handlers');
    assert.ok(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(h), 'no nested links');
  } finally { s.done(); }
});
test('p2_8.render_only_for_listed_countries', () => {
  const s = factsSite();
  try {
    let r = s.build(richFixture()); assert.ok(r.ok, r.out.slice(0, 300));
    const withBox = s.pages().filter(f => /key-facts|Key facts/.test(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')));
    assert.deepEqual(withBox.sort(), ['france.html', 'spain.html'], 'only listed countries get a box');
    for (const f of ['countries.html', 'glossary.html', 'upcoming.html', 'index.html']) {
      const p = path.join(s.dir, f); if (fs.existsSync(p)) assert.ok(!/id="key-facts"/.test(fs.readFileSync(p, 'utf8')), `${f}: no fact box`);
    }
    r = s.build([]); assert.ok(r.ok, r.out.slice(0, 300));
    for (const f of s.pages()) assert.ok(!/key-facts|Key facts|fact-disclaimer/.test(fs.readFileSync(path.join(s.dir, 'countries', f), 'utf8')), `${f}: empty facts.json renders no box at all`);
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
    } else assert.ok(!/key-facts|Key facts|fact-disclaimer|class="fact"/.test(h), `${f}: must not render a fact box`);
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

console.log(`${passed} site tests passed.`);
