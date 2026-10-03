// CP1 behaviour tests for filters.js (pure helpers). Run: node scripts/test-filters.mjs
// Decisions (documented):
// - CSV header follows gates/plan.json: Country,Title,Effective,Status,Impact,Category,Source URL,Page URL
//   Country = display name, Status = badge text, Source URL = detail.sourceUrl,
//   Page URL = `${site}countries/<slugify(name)>.html#<section>`.
// - Selection order is preserved (serializeCountries joins in given order).
// - Both ?countries= and legacy ?country= present: merged, countries first (plan test params.both).
// - Search matches case-insensitively across title, name and detail.lead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadSite } from './load.mjs';

const file = new URL('../filters.js', import.meta.url);
const src = fs.readFileSync(file, 'utf8'); // throws ENOENT until filters.js exists
assert.ok(!/\b(document|window\.location|localStorage|sessionStorage)\b/.test(src.replace(/typeof window[^\n]*/g, '')), 'filters.js must not touch the DOM or storage');
const sandbox = { module: { exports: {} } };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(src, sandbox, { filename: 'filters.js' });
const F = sandbox.module.exports;
const site0 = loadSite();
const plain = v => JSON.parse(JSON.stringify(v)); // cross-realm arrays -> local arrays
const CHANGES = plain(site0.CHANGES), countryToRegion = plain(site0.countryToRegion);

let n = 0, failed = 0;
function test(name, fn) {
  try { fn(); n++; console.log(`ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e && e.message || e).split('\n').slice(0, 3).join('\n  ')}`); }
}

test('exports', () => {
  for (const k of ['parseCountries', 'serializeCountries', 'readSelection', 'readUrlState', 'applyFilters', 'csvCell', 'toCsv', 'csvFilename', 'slugify'])
    assert.equal(typeof F[k], 'function', k);
  assert.equal(F.MAX_COUNTRIES, 30);
});

const P = raw => plain(F.parseCountries(raw, countryToRegion));
test('parse.basic', () => assert.deepEqual(P('poland,germany,uk'), ['poland', 'germany', 'uk']));
test('parse.dedupe_trim_case', () => assert.deepEqual(P(' Poland , poland,GERMANY'), ['poland', 'germany']));
test('parse.unknown_dropped', () => assert.deepEqual(P('poland,<script>,xx,../etc,<img src=x onerror=alert(1)>'), ['poland']));
test('parse.empty', () => { for (const v of ['', null, undefined, ',,,', 42, {}, []]) assert.deepEqual(P(v), []); });
test('parse.cap', () => {
  const all = Object.keys(countryToRegion);
  assert.ok(all.length > 30);
  const r = P(Array(500).fill(all).flat().join(','));
  assert.equal(r.length, 30);
  assert.deepEqual(r, all.slice(0, 30));
  assert.deepEqual(P('x'.repeat(200000) + ',poland'), ['poland']);
});
test('parse.proto', () => assert.deepEqual(P('__proto__,constructor,toString,hasOwnProperty,valueOf'), []));
test('serialize.roundtrip', () => {
  assert.equal(F.serializeCountries(['uk', 'poland']), 'uk,poland');
  assert.equal(F.serializeCountries([]), '');
  const x = ['uk', 'poland', 'germany'];
  assert.deepEqual(P(F.serializeCountries(x)), x);
});
const S = q => plain(F.readSelection(new URLSearchParams(q), countryToRegion));
test('params.legacy', () => assert.deepEqual(S('country=poland'), ['poland']));
test('params.both', () => assert.deepEqual(S('country=france&countries=poland,germany'), ['poland', 'germany', 'france']));
test('params.invalid', () => assert.deepEqual(S('countries=<script>,xx&country=__proto__'), []));
test('urlstate', () => {
  const st = plain(F.readUrlState('?countries=poland,uk&filter=high-impact&region=europe&q=Tax', countryToRegion));
  assert.deepEqual(st.countries, ['poland', 'uk']);
  assert.equal(st.filter, 'high-impact');
  assert.equal(st.region, 'europe');
  assert.equal(st.search, 'Tax');
  assert.ok(!('q' in st), 'only `search` is exposed');
  const bad = plain(F.readUrlState('?filter=<b>&region=mars', countryToRegion));
  assert.equal(bad.filter, 'all');
  assert.ok(!bad.region, 'unknown region dropped');
  assert.deepEqual(bad.countries, []);
  assert.deepEqual(plain(F.readUrlState('', countryToRegion)).countries, []);
});

const A = st => plain(F.applyFilters(CHANGES, st, countryToRegion));
const key = c => c.country + '#' + c.section;
test('filter.none', () => {
  const before = JSON.stringify(CHANGES);
  assert.equal(A({}).length, CHANGES.length);
  assert.deepEqual(A({}).map(key), CHANGES.map(key));
  assert.equal(JSON.stringify(CHANGES), before, 'input not mutated');
  assert.notEqual(F.applyFilters(CHANGES, {}), CHANGES, 'returns a new array');
});
test('filter.countries', () => {
  const r = A({ countries: ['poland', 'germany'] });
  assert.ok(r.every(c => c.country === 'poland' || c.country === 'germany'));
  const exp = CHANGES.filter(c => c.country === 'poland').length + CHANGES.filter(c => c.country === 'germany').length;
  assert.equal(r.length, exp);
  assert.deepEqual(r.map(key), CHANGES.filter(c => ['poland', 'germany'].includes(c.country)).map(key), 'original order');
});
test('filter.combo', () => {
  const r = A({ countries: ['poland', 'germany'], filter: 'high-impact', search: 'TAX' });
  const exp = CHANGES.filter(c => ['poland', 'germany'].includes(c.country) && c.impact === 'high' &&
    [c.title, c.name, c.detail && c.detail.lead].some(t => (t || '').toLowerCase().includes('tax')));
  assert.deepEqual(r.map(key), exp.map(key));
});
test('filter.search_fields', () => {
  for (const q of ['poland', 'minimum wage', 'VDU']) {
    const exp = CHANGES.filter(c => [c.title, c.name, c.detail && c.detail.lead].some(t => (t || '').toLowerCase().includes(q.toLowerCase())));
    assert.deepEqual(A({ search: q }).map(key), exp.map(key), q);
  }
});
test('filter.region_intersect', () => {
  const r = A({ countries: ['poland', 'uk', 'japan'], region: 'europe' });
  const exp = CHANGES.filter(c => ['poland', 'uk', 'japan'].includes(c.country) && countryToRegion[c.country] === 'europe');
  assert.deepEqual(r.map(key), exp.map(key));
  assert.ok(!r.some(c => c.country === 'japan'));
  assert.equal(A({ countries: [], region: 'europe' }).length, CHANGES.filter(c => countryToRegion[c.country] === 'europe').length);
});
test('filter.legacy_equiv', () => {
  const legacy = (filter, country) => {
    let f = CHANGES;
    if (['payroll', 'reporting'].includes(filter)) f = f.filter(c => c.category === filter);
    if (filter === 'high-impact') f = f.filter(c => c.impact === 'high');
    if (country) f = f.filter(c => c.country === country);
    return f;
  };
  for (const filter of ['all', 'payroll', 'reporting', 'high-impact'])
    for (const country of [null, 'poland', 'uk', 'germany'])
      assert.deepEqual(A({ filter, countries: country ? [country] : [] }).map(key), legacy(filter, country).map(key), `${filter}/${country}`);
});

const HEADER = 'Country,Title,Effective,Status,Impact,Category,Source URL,Page URL';
test('csv.header', () => assert.equal(F.toCsv([], ''), '﻿' + HEADER + '\r\n'));
test('csv.quote', () => {
  assert.equal(F.csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(F.csvCell('plain'), 'plain');
  assert.equal(F.csvCell('x\ry'), '"x\ry"');
});
test('csv.injection', () => {
  for (const v of ['=1+1', '+x', '-x', '@x', '\tx', '\rx']) assert.equal(F.csvCell(v), `"'${v}"`, JSON.stringify(v));
  assert.equal(F.csvCell('=HYPERLINK("http://e","x")'), '"\'=HYPERLINK(""http://e"",""x"")"');
  for (const v of [' =HYPERLINK("http://evil","x")', '\n=1+1', '＝1+1', '|cmd', '  @SUM(1)'])
    assert.ok(F.csvCell(v).startsWith(`"'`), JSON.stringify(v));
  for (const v of ['Poland', 'Effective 1 Jan 2026', '2026-01-01']) assert.equal(F.csvCell(v), v);
});
test('csv.missing_name', () => {
  const row = { ...CHANGES[0], name: undefined };
  const cells = F.toCsv([row], 'https://example.org/').slice(1).split('\r\n')[1].split(',');
  assert.equal(cells[0], '');
  assert.equal(cells[cells.length - 1], '');
});
test('filter.search_lead_only', () => {
  const c = CHANGES.find(x => x.detail && x.detail.lead);
  const word = c.detail.lead.split(/[^A-Za-z]+/).filter(w => w.length > 4)
    .find(w => ![c.title, c.name].some(t => (t || '').toLowerCase().includes(w.toLowerCase())));
  assert.ok(word, 'found a lead-only word');
  assert.ok(A({ search: word }).map(key).includes(key(c)));
});
test('csv.null', () => { assert.equal(F.csvCell(null), ''); assert.equal(F.csvCell(undefined), ''); });
test('csv.accents', () => {
  const row = { ...CHANGES[0], name: 'Österreich – Lohnsteuer' };
  const out = F.toCsv([row], 'https://example.org/');
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.includes('Österreich – Lohnsteuer'));
});
test('csv.rows', () => {
  const site = 'https://example.org/';
  const items = A({ countries: ['poland'] });
  const out = F.toCsv(items, site);
  const lines = out.slice(1).split('\r\n');
  assert.equal(lines.pop(), '', 'ends with CRLF');
  assert.equal(lines.length, items.length + 1);
  assert.ok(!/(^|[^\r])\n/.test(out.replace(/"[^"]*"/g, '')), 'no bare LF outside quotes');
  assert.ok(lines[1].includes(`${site}countries/${F.slugify(items[0].name)}.html#${items[0].section}`));
  assert.ok(lines[1].includes(items[0].detail.sourceUrl));
});
test('csv.null_effective', () => {
  const row = { ...CHANGES[0], effective: null, name: 'Poland', title: 'T', badge: 'B' };
  const cells = F.toCsv([row], '').slice(1).split('\r\n')[1].split(',');
  assert.equal(cells[2], '');
});
test('slugify.matches_build', () => {
  const ref = n => n.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const nm of [...new Set(CHANGES.map(c => c.name)), 'Côte d’Ivoire', 'São Tomé & Príncipe']) assert.equal(F.slugify(nm), ref(nm), nm);
});
test('csv.filename', () => {
  assert.equal(F.csvFilename('2026-10-03'), 'intelligent-payroll-changes-2026-10-03.csv');
  assert.equal(F.csvFilename('2026-10-03T12:00:00Z'), 'intelligent-payroll-changes-2026-10-03.csv');
});

// ---------- P2-1: category labels + separate timing control (when=all|upcoming|inforce) ----------
// Contract: filters.js exports CATEGORY_LABELS (frozen; infrastructure -> 'Systems & e-filing'),
// WHEN_LABELS {all:'All dates', upcoming:'Upcoming', inforce:'In force'} and WHENS.
// readUrlState returns `when`; legacy ?filter=upcoming -> filter 'all' + when 'upcoming' (an explicit valid
// ?when= wins). 'upcoming' is no longer a category filter. applyFilters honours state.when:
// upcoming = c.upcoming (drafts are upcoming), inforce = !c.upcoming. CSV Category column uses the label.
test('p2_1.labels', () => {
  assert.deepEqual(plain(F.CATEGORY_LABELS), { payroll: 'Payroll', reporting: 'Reporting' }); // P2-4: infrastructure removed
  assert.deepEqual(plain(F.WHEN_LABELS), { all: 'All dates', upcoming: 'Upcoming', inforce: 'In force' });
  assert.deepEqual(plain(F.WHENS), ['all', 'upcoming', 'inforce']);
  for (const c of new Set(CHANGES.map(x => x.category))) assert.ok(F.CATEGORY_LABELS[c], `label for ${c}`);
  assert.ok(Object.isFrozen(F.CATEGORY_LABELS), 'CATEGORY_LABELS frozen (one shared map)');
});
const U = q => plain(F.readUrlState(q, countryToRegion));
test('p2_1.url_when', () => {
  assert.equal(U('').when, 'all');
  assert.equal(U('?when=upcoming').when, 'upcoming');
  assert.equal(U('?when=inforce&filter=payroll').when, 'inforce');
  assert.equal(U('?when=inforce&filter=payroll').filter, 'payroll');
  for (const bad of ['?when=<b>', '?when=UPCOMING', '?when=', '?when=__proto__', '?when=draft']) assert.equal(U(bad).when, 'all', bad);
});
test('p2_1.url_legacy_upcoming', () => {
  const st = U('?filter=upcoming&countries=poland');
  assert.equal(st.filter, 'all'); assert.equal(st.when, 'upcoming'); assert.deepEqual(st.countries, ['poland']);
  const both = U('?filter=upcoming&when=inforce');
  assert.equal(both.filter, 'all'); assert.equal(both.when, 'inforce', 'explicit valid when wins');
  assert.equal(U('?filter=upcoming&when=junk').when, 'upcoming', 'invalid when falls back to the legacy mapping');
  assert.equal(U('?filter=high-impact').filter, 'high-impact', 'high-impact stays a filter');
  assert.equal(U('?filter=infrastructure').filter, 'all', 'P2-4: removed category falls back to all');
});
test('p2_1.when_matrix', () => {
  const byWhen = { all: () => true, upcoming: c => !!c.upcoming, inforce: c => !c.upcoming };
  const byFilter = { all: () => true, payroll: c => c.category === 'payroll', reporting: c => c.category === 'reporting',
    'high-impact': c => c.impact === 'high' };
  let nonEmpty = 0;
  for (const when of Object.keys(byWhen)) for (const filter of Object.keys(byFilter)) for (const countries of [[], ['poland', 'germany']]) {
    const exp = CHANGES.filter(c => byWhen[when](c) && byFilter[filter](c) && (!countries.length || countries.includes(c.country)));
    assert.deepEqual(A({ filter, when, countries }).map(key), exp.map(key), `${when} x ${filter} x ${countries}`);
    if (exp.length) nonEmpty++;
  }
  assert.ok(nonEmpty > 10, 'matrix exercises real data');
  assert.equal(A({ when: 'upcoming' }).length + A({ when: 'inforce' }).length, CHANGES.length, 'upcoming + in force partition the list');
  assert.equal(A({ when: 'bogus' }).length, CHANGES.length, 'unknown when = all');
});
test('p2_1.csv_category_label', () => {
  // P2-4: infrastructure removed; synthetic reporting rows check the label mapping.
  const infra = CHANGES.slice(0, 3).map(c => ({ ...c, category: 'reporting' }));
  const lines = F.toCsv(infra, '').slice(1).split('\r\n').slice(1, -1);
  for (const [i, l] of lines.entries()) {
    // Category is the 3rd-from-last column (before Source URL, Page URL; URLs never contain commas here).
    const cells = l.split(','); assert.equal(cells.at(-3), 'Reporting', `row ${i}: ${l}`);
  }
  const pay = F.toCsv(CHANGES.filter(c => c.category === 'payroll').slice(0, 1), '').slice(1).split('\r\n')[1].split(',');
  assert.equal(pay.at(-3), 'Payroll');
  const row = infra[0];
  assert.ok(F.toCsv([row], '').includes(F.csvCell(row.badge)), 'Status column unchanged (badge)');
});

// ---------- P2-4: infrastructure category removed ----------
// Contract: CATEGORY_LABELS keys exactly payroll/reporting; FILTERS = all,payroll,reporting,high-impact;
// legacy ?filter=infrastructure -> filter 'all'; no CHANGES entry has category 'infrastructure'.
test('p2_4.categories', () => {
  assert.deepEqual(Object.keys(F.CATEGORY_LABELS).sort(), ['payroll', 'reporting']);
  assert.ok(!('infrastructure' in F.CATEGORY_LABELS));
  assert.ok(!/infrastructure|Systems & e-filing/.test(src), 'filters.js must not mention infrastructure (FILTERS/CATEGORIES)');
  assert.deepEqual(CHANGES.filter(c => c.category === 'infrastructure').map(key), []);
});
test('p2_4.legacy_url', () => {
  assert.equal(U('?filter=infrastructure').filter, 'all');
  const st = U('?filter=infrastructure&countries=poland&when=upcoming');
  assert.equal(st.filter, 'all'); assert.deepEqual(st.countries, ['poland']); assert.equal(st.when, 'upcoming');
  assert.equal(A({ filter: 'infrastructure' }).length, CHANGES.length, 'unknown category = all');
});

console.log(`${n} filter tests passed, ${failed} failed.`);
if (failed) process.exit(1);
