// Fast integrity checks for index.html. Run: node scripts/validate.mjs
import { loadSite } from './load.mjs';

const { CHANGES, countryToRegion, selects } = loadSite();
const errors = [];
const err = (m) => errors.push(m);
const CATEGORIES = new Set(['payroll', 'reporting', 'infrastructure']);
const REGIONS = new Set(['europe', 'apac', 'menat', 'latam', 'africa']);
const seen = new Map();
const names = new Map();

for (const [i, c] of CHANGES.entries()) {
  const id = `${c.country}/${c.section}`;
  for (const f of ['country', 'flag', 'name', 'section', 'title', 'badge']) if (!c[f] || typeof c[f] !== 'string') err(`${id}: missing ${f}`);
  if (!CATEGORIES.has(c.category)) err(`${id}: bad category ${c.category}`);
  if (typeof c.upcoming !== 'boolean') err(`${id}: upcoming must be boolean`);
  if (c.draft && !c.upcoming) err(`${id}: draft entries must be upcoming:true`);
  const d = c.detail;
  if (!d) { err(`${id}: missing detail`); continue; }
  if (!d.lead) err(`${id}: empty lead`);
  if (!Array.isArray(d.employer) || !Array.isArray(d.employee)) err(`${id}: employer/employee must be arrays`);
  if (typeof d.note !== 'string' || typeof d.example !== 'string') err(`${id}: note/example must be strings`);
  if (!/^https:\/\//.test(d.sourceUrl || '')) err(`${id}: sourceUrl must be https`);
  if (!d.sourceLabel) err(`${id}: missing sourceLabel`);
  if (seen.has(id)) err(`${id}: duplicate (country, section), also entry ${seen.get(id)}`);
  seen.set(id, i);
  const key = c.country;
  const nf = `${c.flag} ${c.name}`;
  if (names.has(key) && names.get(key) !== nf) err(`${key}: inconsistent name/flag`);
  names.set(key, nf);
  if (!countryToRegion[c.country]) err(`${id}: country not in countryToRegion`);
}

for (const [code, region] of Object.entries(countryToRegion)) {
  if (!REGIONS.has(region)) err(`${code}: unknown region ${region}`);
  if (!names.has(code)) err(`${code}: in countryToRegion but has no entries`);
}
if (selects.length !== 2) err(`expected 2 country selectors, found ${selects.length}`);
const codes = new Set(Object.keys(countryToRegion));
for (const [n, opts] of selects.entries()) {
  for (const o of opts) if (!codes.has(o)) err(`selector ${n + 1}: option ${o} not in countryToRegion`);
  for (const c of codes) if (!opts.includes(c)) err(`selector ${n + 1}: missing option for ${c}`);
}

const perRegion = {};
for (const r of Object.values(countryToRegion)) perRegion[r] = (perRegion[r] || 0) + 1;
console.log(`${CHANGES.length} entries, ${codes.size} countries`, perRegion);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('All checks passed.');
