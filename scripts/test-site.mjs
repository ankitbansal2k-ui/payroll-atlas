// Behaviour tests for shipped site features (regression baseline).
// Usage: node scripts/test-site.mjs   (no dependencies)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'app.js', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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
    for (const f of ['scripts/validate.mjs', 'scripts/load.mjs', 'filters.js', 'index.html', 'vercel.json', '_headers', 'data/requests.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
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

console.log(`${passed} site tests passed.`);
