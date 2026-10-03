// CP1 behaviour tests for filters.js (pure helpers). Run: node scripts/test-filters.mjs
// Decisions (documented):
// - CSV header follows gates/plan.json: Country,Title,Effective,Status,Impact,Category,Source URL,Page URL
//   Country = display name, Status = status label + formatted date (P2-2; was badge text), Source URL = detail.sourceUrl,
//   Page URL = `${site}countries/<slugify(name)>.html#<section>`.
// - Selection order is preserved (serializeCountries joins in given order).
// - Both ?countries= and legacy ?country= present: merged, countries first (plan test params.both).
// - Search matches case-insensitively across title, name, detail.lead and (P2-6) detail.sourceLabel.
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
    // P2-6: search also covers the source label.
    const exp = CHANGES.filter(c => [c.title, c.name, c.detail && c.detail.lead, c.detail && c.detail.sourceLabel].some(t => (t || '').toLowerCase().includes(q.toLowerCase())));
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
  // P2-2: Status column is now status label + formatted date (see p2_2.csv_status), no longer the badge text.
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

// ---------- P2-2: status chip + formatted date ----------
// Contract (filters.js exports):
//   STATUS_LABELS (frozen) = {draft:'Draft — not yet law', upcoming:'Upcoming', inforce:'In force', ongoing:'Ongoing'}
//   statusOf(entry, verifiedIso?) -> 'draft' | 'upcoming' | 'inforce' | 'ongoing', first match wins:
//     draft:true -> draft; upcoming:true -> upcoming; effective null/undefined -> ongoing;
//     verifiedIso given and the effective period STARTS after verifiedIso -> upcoming (a start ON the
//     verified day is in force); otherwise inforce. Never throws; ignores malformed effective (flags decide).
//   formatEffective(effective) -> 'YYYY-MM-DD' -> 'D Mon YYYY' (no leading zero), 'YYYY-MM' -> 'Mon YYYY',
//     'YYYY' -> 'YYYY', null/undefined/invalid -> ''. en-GB short months (Jan..Dec, 'Sep' not 'Sept').
//     Formatted from the string, never via Date()/toLocale* (timezone off-by-one risk).
//   toCsv Status column = STATUS_LABELS[statusOf(c)] + (date ? ', ' + formatEffective(c.effective) : '').
//   `badge` stays the optional free-text field; it is no longer used for Status.
const ST = (e, v) => F.statusOf(e, v);
test('p2_2.labels', () => {
  assert.deepEqual(plain(F.STATUS_LABELS), { draft: 'Draft — not yet law', upcoming: 'Upcoming', inforce: 'In force', ongoing: 'Ongoing' });
  assert.ok(Object.isFrozen(F.STATUS_LABELS), 'STATUS_LABELS frozen');
});
test('p2_2.statusOf_flags', () => {
  assert.equal(ST({ draft: true, upcoming: true, effective: '2027-01-01' }), 'draft');
  assert.equal(ST({ draft: true, upcoming: true, effective: null }), 'draft', 'undated draft is still draft');
  assert.equal(ST({ upcoming: true, effective: '2027-01-01' }), 'upcoming');
  assert.equal(ST({ upcoming: true, effective: null }), 'upcoming', 'upcoming flag beats null date');
  assert.equal(ST({ upcoming: false, effective: null }), 'ongoing');
  assert.equal(ST({ upcoming: false }), 'ongoing', 'missing effective = ongoing');
  assert.equal(ST({ upcoming: false, effective: '2026-01-01' }), 'inforce');
  assert.equal(ST({ upcoming: false, effective: '2026' }), 'inforce');
  assert.equal(ST({ upcoming: false, effective: 'garbage' }), 'inforce', 'malformed date: flags decide');
});
test('p2_2.statusOf_verified_boundary', () => {
  const v = '2026-10-01';
  assert.equal(ST({ upcoming: false, effective: '2026-10-01' }, v), 'inforce', 'starts on the verified day = in force');
  assert.equal(ST({ upcoming: false, effective: '2026-10-02' }, v), 'upcoming', 'day after verified');
  assert.equal(ST({ upcoming: false, effective: '2026-09-30' }, v), 'inforce');
  assert.equal(ST({ upcoming: false, effective: '2026-10' }, v), 'inforce', 'month starting on verified day');
  assert.equal(ST({ upcoming: false, effective: '2026-11' }, v), 'upcoming');
  assert.equal(ST({ upcoming: false, effective: '2026' }, v), 'inforce');
  assert.equal(ST({ upcoming: false, effective: '2027' }, v), 'upcoming');
  assert.equal(ST({ upcoming: false, effective: null }, v), 'ongoing');
  assert.equal(ST({ upcoming: false, effective: '2027-01-01' }), 'inforce', 'without verifiedIso only flags count');
  assert.equal(ST({ draft: true, upcoming: true, effective: '2020-01-01' }, v), 'draft');
});
test('p2_2.statusOf_real_data', () => {
  const counts = {};
  for (const c of CHANGES) {
    const s = ST(c, '2026-10-01');
    assert.ok(['draft', 'upcoming', 'inforce', 'ongoing'].includes(s), `${key(c)}: ${s}`);
    assert.equal(s, ST(c), `${key(c)}: flags and verified date disagree`);
    counts[s] = (counts[s] || 0) + 1;
  }
  for (const k of ['draft', 'upcoming', 'inforce', 'ongoing']) assert.ok(counts[k] > 0, `real data has a ${k} entry`);
});
test('p2_2.formatEffective', () => {
  const cases = { '2026-01-01': '1 Jan 2026', '2026-09-09': '9 Sep 2026', '2026-12-31': '31 Dec 2026', '2024-02-29': '29 Feb 2024',
    '2027-04-06': '6 Apr 2027', '2026-06': 'Jun 2026', '2026-09': 'Sep 2026', '2026-12': 'Dec 2026', '2026': '2026', '1999': '1999' };
  for (const [k, v] of Object.entries(cases)) assert.equal(F.formatEffective(k), v, k);
  for (const bad of [null, undefined, '', '2026-13', '2026-00', '2026-02-30', '2025-02-29', '2026-1-1', '26', ' 2026', '2026-01-01T00:00:00Z',
    'Jan 2026', 2026, {}, '__proto__']) assert.equal(F.formatEffective(bad), '', `invalid ${JSON.stringify(bad)}`);
  for (const c of CHANGES) assert.equal(F.formatEffective(c.effective) === '', c.effective === null, `${key(c)}: ${c.effective}`);
});
test('p2_2.formatEffective_no_Date', () => {
  const fn = F.formatEffective.toString();
  assert.ok(!/new Date|toLocale|Date\.parse/.test(fn), 'format from the string, not via Date()');
});
const statusCell = c => F.STATUS_LABELS[F.statusOf(c)] + (F.formatEffective(c.effective) ? ', ' + F.formatEffective(c.effective) : '');
test('p2_2.csv_status', () => {
  assert.equal(statusCell({ upcoming: true, effective: '2026-07-01' }), 'Upcoming, 1 Jul 2026');
  for (const c of CHANGES) {
    const line = F.toCsv([c], '').slice(1).split('\r\n')[1];
    assert.ok(line.includes(F.csvCell(statusCell(c))), `${key(c)}: Status cell should be ${statusCell(c)}: ${line.slice(0, 160)}`);
  }
  const row = { ...CHANGES[0], effective: null, upcoming: false, draft: false, badge: 'XYZZY note' };
  const line = F.toCsv([row], '').slice(1).split('\r\n')[1];
  assert.ok(line.includes(',Ongoing,'), line);
  assert.ok(!line.includes('XYZZY'), 'badge text is not the Status column');
  const dr = F.toCsv([{ ...CHANGES[0], draft: true, upcoming: true, effective: '2027-01' }], '').slice(1).split('\r\n')[1];
  assert.ok(dr.includes('"Draft — not yet law, Jan 2027"'), dr);
});


// ---------- P2-3: coverage depth (pure) ----------
// Contract: coverageDepth(changes) -> plain {code: count}; depthBucket(n) -> 0 (n<1 / invalid), 1, 2, 3, 4 (n>=4).
test('p2_3.exports', () => {
  for (const k of ['coverageDepth', 'depthBucket', 'depthClass']) assert.equal(typeof F[k], 'function', k);
});
test('p2_3.coverageDepth_matches_CHANGES', () => {
  const want = {};
  for (const c of CHANGES) want[c.country] = (want[c.country] || 0) + 1;
  const got = plain(F.coverageDepth(CHANGES));
  assert.deepEqual(got, want);
  assert.equal(Object.values(got).reduce((a, b) => a + b, 0), CHANGES.length);
  for (const code of Object.keys(countryToRegion)) assert.ok(got[code] >= 1, `${code}: no entries counted`);
});
test('p2_3.coverageDepth_edge', () => {
  assert.deepEqual(plain(F.coverageDepth([])), {});
  assert.deepEqual(plain(F.coverageDepth([{ country: 'uk' }, { country: 'uk' }, { country: 'poland' }])), { uk: 2, poland: 1 });
  const r = F.coverageDepth([{ country: '__proto__' }, { country: 'constructor' }, { country: 'uk' }]);
  assert.equal(r.uk, 1);
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
  assert.deepEqual(plain(F.coverageDepth([{ country: 'toString' }])), { toString: 1 }, 'inherited names must not leak into counts');
  // Input not mutated.
  const input = [{ country: 'uk' }]; const copy = plain(input); F.coverageDepth(input); assert.deepEqual(input, copy);
});
test('p2_3.depthBucket_boundaries', () => {
  const cases = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 4], [20, 4], [1000, 4]];
  for (const [n, b] of cases) assert.equal(F.depthBucket(n), b, `n=${n}`);
  for (const bad of [0, -1, undefined, null, NaN, '', 'x', {}]) assert.equal(F.depthBucket(bad), 0, `n=${JSON.stringify(bad)}`);
});
test('p2_3.depthClass_assignment', () => {
  const cases = [[1, 'depth-1'], [2, 'depth-2'], [3, 'depth-3'], [4, 'depth-4'], [9, 'depth-4'], [0, 'depth-0'], [undefined, 'depth-0']];
  for (const [n, c] of cases) assert.equal(F.depthClass(n), c, `n=${n}`);
  const d = plain(F.coverageDepth(CHANGES));
  for (const code of Object.keys(countryToRegion)) assert.match(F.depthClass(d[code]), /^depth-[1-4]$/, code);
});
test('p2_3.every_country_one_bucket', () => {
  const d = plain(F.coverageDepth(CHANGES));
  const buckets = { 1: [], 2: [], 3: [], 4: [] };
  for (const code of Object.keys(countryToRegion)) {
    const b = F.depthBucket(d[code] || 0);
    assert.ok(b >= 1 && b <= 4, `${code}: bucket ${b}`);
    buckets[b].push(code);
  }
  assert.equal(Object.values(buckets).flat().length, Object.keys(countryToRegion).length);
  assert.equal(F.depthBucket(d.nowhere || 0), 0, 'country without entries is not shaded');
});

// ---------- P2-6: search also matches detail.sourceLabel; highlight(text, query) ----------
// Contract (P2-6): F.highlight(text, query) -> HTML string. Escapes the WHOLE text with app.js escapeHtml rules
// (& < > " ' -> &amp; &lt; &gt; &quot; &#39;), then wraps each case-insensitive, non-overlapping occurrence of the
// query (matched against the raw text, never inside an entity) in <mark class="search-hit">...</mark>, keeping the
// original casing. The query is a phrase (not split into words), matched "as typed": no accent folding ("zl" does
// not match "zł"). Empty/whitespace/non-string query -> plain escaped text. Queries longer than
// F.SEARCH_MAX_LENGTH (200) are not highlighted (plain escaped text). Never throws on regex metacharacters.
const BS = String.fromCharCode(92); // backslash (avoids shell escaping issues)
const M = s => `<mark class="search-hit">${s}</mark>`;
const H = (t, q) => F.highlight(t, q);
test('p2_6.exports', () => { assert.equal(typeof F.highlight, 'function'); assert.equal(F.SEARCH_MAX_LENGTH, 200); });
test('p2_6.sourceLabel_only_match', () => {
  const hit = plain(F.applyFilters(CHANGES, { search: 'mindestlohnes' }, countryToRegion));
  assert.ok(hit.length >= 1, 'word only in detail.sourceLabel must match');
  for (const c of hit) assert.ok(/mindestlohnes/i.test(c.detail.sourceLabel));
  assert.ok(!hit.some(c => [c.title, c.name, c.detail.lead].some(t => /mindestlohnes/i.test(t || ''))), 'fixture: word must be sourceLabel-only');
  const syn = [{ country: 'uk', title: 'T', name: 'United Kingdom', detail: { lead: 'L', sourceLabel: 'HMRC guidance' } }];
  assert.equal(F.applyFilters(syn, { search: 'hmrc' }, countryToRegion).length, 1);
  assert.equal(F.applyFilters(syn, { search: 'zzz' }, countryToRegion).length, 0);
  assert.equal(F.applyFilters([{ country: 'uk', title: 'T', name: 'N' }], { search: 'x' }, countryToRegion).length, 0, 'missing detail must not throw');
});
test('p2_6.highlight_basic_case', () => {
  assert.equal(H('Minimum wage rises', 'minimum'), M('Minimum') + ' wage rises');
  assert.equal(H('minimum wage', 'MINIMUM'), M('minimum') + ' wage');
  assert.equal(H('Social minimum wage', 'minimum wage'), 'Social ' + M('minimum wage'), 'phrase, not split into words');
  assert.equal(H('no hit here', 'wage'), 'no hit here');
});
test('p2_6.highlight_multiple_nonoverlapping', () => {
  assert.equal(H('Wage, wage and WAGE', 'wage'), `${M('Wage')}, ${M('wage')} and ${M('WAGE')}`);
  assert.equal(H('aaa', 'aa'), M('aa') + 'a');
  assert.equal(H('aaaa', 'aa'), M('aa') + M('aa'));
});
test('p2_6.highlight_regex_metachars', () => {
  for (const q of ['(', '[', '.*', BS, '(.*', '$', '^', '|', '+', '?', '{2}', ')', ']', '*']) {
    assert.doesNotThrow(() => H('plain text', q), q);
    assert.equal(H('plain text', q), 'plain text', `"${q}" must be literal`);
  }
  assert.equal(H('a (.* b', '(.*'), 'a ' + M('(.*') + ' b');
  assert.equal(H('x [y] z', '[y]'), 'x ' + M('[y]') + ' z');
  assert.equal(H('C:' + BS + 'path', BS), 'C:' + M(BS) + 'path');
  assert.equal(H('1.5% or 105%', '1.5'), M('1.5') + '% or 105%', '"." is not a wildcard');
});
test('p2_6.highlight_entity_safety', () => {
  assert.equal(H('a&b', '&'), 'a' + M('&amp;') + 'b');
  assert.equal(H('a&b', 'amp'), 'a&amp;b', '"amp" must not match inside &amp;');
  assert.equal(H('x < y', 'lt'), 'x &lt; y', '"lt" must not match inside &lt;');
  assert.equal(H('x > y', 'gt'), 'x &gt; y');
  assert.equal(H('"q"', 'quot'), '&quot;q&quot;');
  assert.equal(H("it's", '39'), 'it&#39;s');
  assert.equal(H("it's", "'"), 'it' + M('&#39;') + 's');
  assert.equal(H('A&B Ltd', 'a&b'), M('A&amp;B') + ' Ltd');
  assert.equal(H('a <script> b', '<script>'), 'a ' + M('&lt;script&gt;') + ' b');
  assert.equal(H('<b>x</b>', 'b'), '&lt;' + M('b') + '&gt;x&lt;/' + M('b') + '&gt;');
  assert.equal(H('a; b', ';'), 'a' + M(';') + ' b');
  assert.equal(H('&amp;', '&amp;'), M('&amp;amp;'), 'literal "&amp;" in data is escaped once, matched as typed');
  assert.equal(H('&amp;', 'amp'), '&amp;' + M('amp') + ';', 'no double-escaping, no broken entity');
  assert.equal(H('<img src=x onerror=1>', '<img src=x onerror=1>'), M('&lt;img src=x onerror=1&gt;'));
  assert.equal(H('a < b & c', '<script>'), 'a &lt; b &amp; c');
});
test('p2_6.highlight_empty_and_long', () => {
  for (const q of ['', '   ', '\t\n', null, undefined, 42, {}, []]) assert.equal(H('a & <b>', q), 'a &amp; &lt;b&gt;', JSON.stringify(q));
  assert.equal(H('short', 'short but longer query'), 'short');
  assert.equal(H(null, 'x'), ''); assert.equal(H(undefined, 'x'), '');
  assert.equal(H(12345, '23'), '1' + M('23') + '45');
  const long = 'w'.repeat(201);
  assert.equal(H(long + ' tail', long), long + ' tail', 'over SEARCH_MAX_LENGTH: not highlighted');
  const ok = 'w'.repeat(200);
  assert.equal(H(ok, ok), M(ok));
  const t0 = Date.now(); H('ab'.repeat(50000), 'a'.repeat(100000)); H('a'.repeat(100000), 'a'); assert.ok(Date.now() - t0 < 2000, 'fast on big input');
});
test('p2_6.highlight_diacritics_as_typed', () => {
  assert.equal(H('Płaca minimalna 4 806 zł', 'zl'), 'Płaca minimalna 4 806 zł', 'no accent folding');
  assert.equal(H('Płaca minimalna 4 806 zł', 'zł'), 'Płaca minimalna 4 806 ' + M('zł'));
  assert.equal(H('ÉLECTION', 'élection'), M('ÉLECTION'));
  assert.equal(H('İstanbul wage', 'wage'), 'İstanbul ' + M('wage'), 'lower-casing that changes length must not shift offsets');
  assert.equal(H('Straße wage', 'wage'), 'Straße ' + M('wage'));
  assert.equal(H('€1,153 a month', '€1,153'), M('€1,153') + ' a month');
});

// Fold agreement (P2-6 fix): applyFilters and highlight share F.foldForSearch (per code point, length-preserving).
// Documented choice: Turkish capital dotted I (U+0130) lowercases to two code units, so it is kept as is:
// query 'i' does NOT match 'İstanbul' (neither filter nor mark); query 'İ' does. Final sigma folds to sigma.
test('p2_6.fold_filter_highlight_agree', () => {
  const card = t => [{ country: 'uk', title: t, name: 'N', detail: { lead: '' } }];
  const agree = (title, q, expected) => {
    const shown = F.applyFilters(card(title), { search: q }, countryToRegion).length === 1;
    const marked = /<mark class="search-hit">/.test(H(title, q));
    assert.equal(shown, expected, `filter ${title} / ${q}`);
    assert.equal(marked, shown, `highlight disagrees with filter for ${title} / ${q}`);
  };
  agree('İstanbul', 'i', false);
  agree('İstanbul', 'İ', true);
  agree('İstanbul', 'stanbul', true);
  agree('ΟΔΟΣ', 'οδος', true);
  assert.equal(H('ΟΔΟΣ', 'οδος'), '<mark class="search-hit">ΟΔΟΣ</mark>');
  agree('\u{10400}x', '\u{10428}', true);
  assert.equal(H('\u{10400}x', '\u{10428}'), '<mark class="search-hit">\u{10400}</mark>x');
  assert.equal(F.foldForSearch('İA\u{10400}').length, 'İA\u{10400}'.length, 'fold must preserve length');
});

console.log(`${n} filter tests passed, ${failed} failed.`);
if (failed) process.exit(1);
