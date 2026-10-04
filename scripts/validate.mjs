// Fast integrity checks for index.html. Run: node scripts/validate.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadSite } from './load.mjs';

const { html, js, CHANGES, countryToRegion, selects } = loadSite();
const errors = [];
const err = (m) => errors.push(m);
const CATEGORIES = new Set(['payroll', 'reporting']);
const REGIONS = new Set(['europe', 'apac', 'menat', 'latam', 'africa']);
const seen = new Map();
const names = new Map();
// "Not in the future" means not after UTC today + 1 day, so authors up to UTC+14 can date work with their local day.
const TODAY = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const VERIFIED = (js.match(/new Date\('(\d{4}-\d{2}-\d{2})T/) || [])[1];
if (!VERIFIED) err('app.js: could not find the LAST_VERIFIED date');
const isIsoDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
// Text that is shown on pages must be plain: no control characters or line breaks, no zero-width or other invisible
// format characters, and no bidirectional overrides or isolates (they can make text read differently from what is stored).
const BAD_RANGES = [[0x00, 0x1F], [0x7F, 0x9F], [0x2028, 0x2029], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2060], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
const hasBadChar = s => { for (const ch of s) { const c = ch.codePointAt(0); if (BAD_RANGES.some(([a, b]) => c >= a && c <= b)) return true; } return false; };
const BAD_CHARS_MSG = 'must not contain control characters, line breaks or invisible/bidirectional formatting characters';
// Source URL for a link on a page: https, visible ASCII only (no quotes, angle brackets or backticks), no user name or password,
// and a public-looking host name (not localhost, not an IP address).
function urlProblem(u) {
  if (typeof u !== 'string' || !u.startsWith('https://')) return 'must be an https URL';
  for (const ch of u) { const c = ch.codePointAt(0); if (c < 0x21 || c > 0x7E || [0x22, 0x27, 0x3C, 0x3E, 0x60].includes(c)) return 'must use only visible ASCII characters and no quotes, angle brackets or backticks'; }
  let x; try { x = new URL(u); } catch { return 'must be a valid URL'; }
  if (x.protocol !== 'https:' || !x.hostname) return 'must be an https URL';
  if (x.username || x.password) return 'must not contain a user name or password';
  const h = x.hostname.toLowerCase();
  if (h.startsWith('[') || /^[0-9.]+$/.test(h)) return 'must use a host name, not an IP address';
  if (h === 'localhost' || h.endsWith('.localhost') || !h.includes('.')) return 'must use a public host name (not localhost or a single-label name)';
  return null;
}
// 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' -> { start, end } as YYYY-MM-DD strings, or null if malformed.
function periodOf(v) {
  if (typeof v !== 'string') return null;
  if (/^\d{4}$/.test(v)) return { start: `${v}-01-01`, end: `${v}-12-31` };
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) {
    const last = new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7), 0)).getUTCDate();
    return { start: `${v}-01`, end: `${v}-${last}` };
  }
  return isIsoDay(v) ? { start: v, end: v } : null;
}

// A badge "restates the date" when, after an optional leading Effective/In force/Confirmed for (day/month dates only)/Applies to/From,
// it equals the formatted effective date (short or long month), or when it is just a status label.
// Uses filters.js, the code the site renders with (required, as in build-pages.mjs).
const { formatEffective, STATUS_LABELS, statusOf, slugify } = createRequire(import.meta.url)('../filters.js');
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function restatesDate(badge, effective, entry) {
  const b = badge.trim().toLowerCase();
  // A bare status label duplicates the chip. With effective null, only the entry's own chip label counts
  // (e.g. 'In force' on an undated entry whose chip says Ongoing still adds information).
  const labels = effective === null ? [STATUS_LABELS[statusOf(entry)]] : Object.values(STATUS_LABELS);
  if (labels.some(l => l.toLowerCase() === b)) return true;
  const short = formatEffective(effective);
  if (!short) return false;
  const long = short.replace(/[A-Z][a-z]{2}/, m => LONG_MONTHS.find(x => x.startsWith(m)));
  // 'Confirmed for YYYY' on a year-only date is informative (rates confirmed/unchanged), so that prefix
  // only counts as restating for day/month precision.
  const prefix = effective.length === 4 ? /^(effective|in force|applies to|from)\s+/ : /^(effective|in force|confirmed for|applies to|from)\s+/;
  const rest = b.replace(prefix, '').trim();
  return rest === short.toLowerCase() || rest === long.toLowerCase();
}

for (const [i, c] of CHANGES.entries()) {
  const id = `${c.country}/${c.section}`;
  for (const f of ['country', 'flag', 'name', 'section', 'title']) if (!c[f] || typeof c[f] !== 'string') err(`${id}: missing ${f}`);
  // badge is an optional free-text note; it must add something the status chip + formatted date cannot.
  if ('badge' in c && (typeof c.badge !== 'string' || !c.badge.trim())) err(`${id}: badge, if present, must be a non-empty string`);
  else if (typeof c.badge === 'string' && restatesDate(c.badge, c.effective, c)) err(`${id}: badge "${c.badge}" restates the date/status; remove it (the status chip and formatted date already show this)`);
  if (!CATEGORIES.has(c.category)) err(`${id}: bad category ${c.category}`);
  if (typeof c.upcoming !== 'boolean') err(`${id}: upcoming must be boolean`);
  if (!['high', 'medium', 'low'].includes(c.impact)) err(`${id}: impact must be high, medium or low`);
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

  // Structured dates. effective: start of the change as precisely as the source states it
  // ('YYYY-MM-DD', 'YYYY-MM' or 'YYYY'), or null when no single start date applies (current rates,
  // drafts without a date). added: the day the entry was first published.
  if (!isIsoDay(c.added)) err(`${id}: added must be YYYY-MM-DD`);
  else if (c.added > TODAY) err(`${id}: added ${c.added} is in the future (later than ${TODAY})`);
  if ('updated' in c) {
    if (!isIsoDay(c.updated)) err(`${id}: updated must be YYYY-MM-DD`);
    else if (c.updated > TODAY) err(`${id}: updated ${c.updated} is in the future (later than ${TODAY})`);
    else if (isIsoDay(c.added) && c.updated <= c.added) err(`${id}: updated must be after added`);
  }
  if (c.effective !== null) {
    const span = periodOf(c.effective);
    if (!span) { err(`${id}: effective must be YYYY, YYYY-MM, YYYY-MM-DD or null`); continue; }
    const year = c.effective.slice(0, 4);
    // The year must appear in the free text (badge, title, lead or detail text) so it cannot contradict the date silently.
    const text = [c.badge || '', c.title, d.lead, ...(d.employer || []), ...(d.employee || []), d.note, d.example].join(' ');
    if (!text.includes(year)) err(`${id}: effective year ${year} appears in none of badge, title, lead or detail text`);
    // The upcoming flag must agree with the date, relative to the last verification date.
    if (span.start > VERIFIED && !c.upcoming) err(`${id}: starts ${c.effective}, after ${VERIFIED}, so upcoming must be true`);
    if (span.end < VERIFIED && c.upcoming && !c.draft) err(`${id}: started ${c.effective}, before ${VERIFIED}, so upcoming must be false`);
  }
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

// XSS guard: values that can come from the address bar or the search box must be escaped
// wherever they are interpolated into a template string that ends up in innerHTML.
{
  const RISKY = /\b(country|countryParam|search|query|term|param|params|countries|selection|state|hlNeedle)\b/; // no aliases: pass state.search to wrappers directly
  const lines = js.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*\{country:/.test(line)) return; // data rows
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
      // Drop the parts that are properly escaped, and plain truthiness tests such as `search ? ...`.
      const rest = m[1]
        .replace(/(?:escapeHtml|PayrollFilters\.highlight)\((?:[^()]|\([^()]*\))*\)?/g, '') // escaping wrappers
        .replace(/\b(?:state\.)?(country|countryParam|search|query|term|param|params|countries|selection|state)\s*(\?|&&)/g, '');
      if (RISKY.test(rest)) err(`app.js:${i + 1}: unescaped user-controlled value in template: ${m[1].trim()}`);
    }
  });
}

// CSP guard: the page's content security policy forbids inline code, so the markup and the strings
// that app.js turns into markup must not contain any, and the policy itself must stay strict.
{
  const scan = (name, text) => {
    if (/\son[a-z]+\s*=\s*["']/i.test(text.replace(/\{country:[^\n]*/g, ''))) err(`${name}: inline event handler attribute (use data-* attributes and the delegated listeners in app.js)`);
    if (/\sstyle\s*=\s*["']/i.test(text.replace(/\{country:[^\n]*/g, ''))) err(`${name}: inline style attribute (use a CSS class in styles.css)`);
    if (/javascript:/i.test(text.replace(/\{country:[^\n]*/g, ''))) err(`${name}: javascript: URL`);
  };
  scan('index.html', html);
  scan('app.js', js);
  if (/<style[\s>]/i.test(html)) err('index.html: inline <style> block (use styles.css)');
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) err('index.html: inline <script> block (use a script file)');
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
  if (!csp) err('index.html: Content-Security-Policy meta tag is missing');
  if (/unsafe-inline|unsafe-eval/.test(csp)) err('index.html: CSP must not allow unsafe-inline or unsafe-eval');
  if (!/script-src 'self'(;|$)/.test(csp)) err("index.html: CSP script-src must be exactly 'self'");
}

// security.txt must exist and must not expire silently (RFC 9116 requires an Expires date).
{
  let txt = '';
  try { txt = fs.readFileSync(new URL('../.well-known/security.txt', import.meta.url), 'utf8'); } catch { err('.well-known/security.txt is missing'); }
  if (txt) {
    const exp = (txt.match(/^Expires:\s*(\S+)/m) || [])[1];
    const when = exp && new Date(exp);
    if (!when || Number.isNaN(+when)) err('.well-known/security.txt: missing or invalid Expires date');
    else {
      const days = Math.floor((when - Date.now()) / 86400000);
      if (days < 0) err(`.well-known/security.txt expired on ${exp}: renew the Expires date (and read SECURITY.md again)`);
      else if (days < 60) console.warn(`WARNING: .well-known/security.txt expires in ${days} days (${exp}); renew it soon.`);
    }
    if (!/^Contact:\s*\S+/m.test(txt)) err('.well-known/security.txt: missing Contact');
  }
}

// Guard against scratch files (downloads, PDFs, archives) being committed by accident.
const root = new URL('../', import.meta.url);
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').map(f => f.trim()).filter(Boolean);
} catch { /* not a git checkout: skip */ }
for (const f of tracked) {
  if (/\.(pdf|zip|gz|tgz|7z|rar|mp4|mov)$/i.test(f)) { err(`tracked file type not allowed: ${f}`); continue; }
  let size = 0;
  try { size = fs.statSync(new URL(f, root)).size; } catch { continue; /* staged for deletion */ }
  if (size > 1024 * 1024) err(`tracked file over 1 MB: ${f}`);
}

// Cloudflare (_headers) and Vercel (vercel.json) must send the same Content-Security-Policy.
try {
  const vercelCsp = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    .headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy')?.value;
  const cfCsp = (fs.readFileSync(new URL('../_headers', import.meta.url), 'utf8').match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1]?.trim();
  if (!cfCsp || cfCsp !== vercelCsp) err('_headers Content-Security-Policy differs from vercel.json');
} catch (e) { err('_headers / vercel.json: ' + e.message); }

// Visitor requests list: reviewed entries only, no personal data.
try {
  const reqs = JSON.parse(fs.readFileSync(new URL('../data/requests.json', import.meta.url), 'utf8'));
  if (!Array.isArray(reqs)) err('data/requests.json: must be an array');
  else reqs.forEach((r, i) => {
    const at = `data/requests.json[${i}]`;
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'country,label,requests,since,status,type') err(`${at}: fields must be exactly type, country, label, requests, status, since`);
    if (!['country', 'rule', 'feature'].includes(r.type)) err(`${at}: bad type`);
    if (r.country !== null && !Object.prototype.hasOwnProperty.call(countryToRegion, r.country)) err(`${at}: country must be a known code or null`);
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 80) err(`${at}: label must be 1-80 characters`);
    if (/@|https?:/i.test(String(r.label))) err(`${at}: label must not contain emails or links`);
    if (!Number.isInteger(r.requests) || r.requests < 1) err(`${at}: requests must be a positive integer`);
    if (!['requested', 'researching', 'added'].includes(r.status)) err(`${at}: bad status`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.since))) err(`${at}: since must be YYYY-MM-DD`);
  });
} catch (e) { err('data/requests.json: ' + e.message); }

// Glossary (data/glossary.json): fact-checked abbreviations that the generated country pages link to.
// Rules are documented in README.md ("The glossary").
{
  const isWordChar = ch => ch !== undefined && /^[\p{L}\p{N}]$/u.test(ch);
  // Whole word, case-sensitive, literal: no Unicode letter or digit directly before or after (no regex from the term).
  const hasWord = (text, word) => {
    for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
      const before = Array.from(text.slice(Math.max(0, i - 2), i)).pop();
      const after = text.codePointAt(i + word.length);
      if (!isWordChar(before) && !isWordChar(after === undefined ? undefined : String.fromCodePoint(after))) return true;
    }
    return false;
  };
  // Only the fields build-pages.mjs links on country pages count: lead, employer and employee bullets, note (not title, not example).
  const entryText = e => [e.detail && e.detail.lead, ...((e.detail && e.detail.employer) || []), ...((e.detail && e.detail.employee) || []), e.detail && e.detail.note].filter(x => typeof x === 'string').join(' \n ');
  let gl = null;
  try { gl = JSON.parse(fs.readFileSync(new URL('../data/glossary.json', import.meta.url), 'utf8')); } catch (e) { err('data/glossary.json: glossary file missing or not valid JSON (' + e.message + ')'); }
  if (gl !== null && !Array.isArray(gl)) err('data/glossary.json: glossary must be an array');
  else if (gl !== null) {
    const seenNames = [];
    const seenSlugs = new Map();
    const KEYS = new Set(['term', 'aliases', 'countries', 'expansion', 'definition', 'sourceUrl', 'sourceLabel', 'checked']);
    gl.forEach((t, i) => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) { err(`data/glossary.json[${i}]: glossary entry must be an object`); return; }
      const at = `data/glossary.json[${i}] (${typeof t.term === 'string' ? t.term : '?'}): glossary`;
      for (const k of Object.keys(t)) if (!KEYS.has(k)) err(`${at} unknown field "${k}" (allowed: ${[...KEYS].join(', ')})`);
      if (typeof t.term !== 'string' || !t.term || t.term.trim() !== t.term) { err(`${at} term must be a non-empty trimmed string`); return; }
      // Plain text: no markup characters and no control characters (including line breaks) in any text field.
      const plain = (label, v) => {
        if (/[<>]/.test(v)) err(`${at} ${label} must be plain text (no < or >)`);
        if (hasBadChar(v)) err(`${at} ${label} ${BAD_CHARS_MSG}`);
      };
      plain('term', t.term);
      for (const k of ['expansion', 'definition', 'sourceLabel']) {
        if (typeof t[k] !== 'string' || !t[k].trim()) err(`${at} ${k} must be a non-empty string`);
        else plain(k, t[k]);
      }
      if (typeof t.definition === 'string') {
        if (t.definition.length > 300) err(`${at} definition is ${t.definition.length} characters (max 300)`);
        const words = t.definition.trim() ? t.definition.trim().split(/\s+/).length : 0;
        if (words > 40) err(`${at} definition is ${words} words (max 40)`);
        if (words < 3) err(`${at} definition is ${words} word(s) (min 3)`);
      }
      const countriesOk = Array.isArray(t.countries) && t.countries.every(c => typeof c === 'string' && Object.prototype.hasOwnProperty.call(countryToRegion, c));
      if (!countriesOk) err(`${at} countries must be an array of known country codes ([] = general)`);
      else if (new Set(t.countries).size !== t.countries.length) err(`${at} countries must not list a country twice`);
      if (t.aliases !== undefined) {
        if (!Array.isArray(t.aliases) || !t.aliases.every(a => typeof a === 'string' && a && a.trim() === a)) err(`${at} aliases must be an array of trimmed, non-empty strings`);
        else t.aliases.forEach(a => plain('alias "' + a + '"', a));
      }
      const tUrl = urlProblem(t.sourceUrl);
      if (tUrl) err(`${at} sourceUrl ${tUrl}`);
      if (typeof t.sourceLabel === 'string' && !/^Source: .+ - .+/.test(t.sourceLabel)) err(`${at} sourceLabel must look like "Source: <Publisher> - <page title>"`);
      if (!isIsoDay(t.checked)) err(`${at} checked must be a real YYYY-MM-DD date`);
      else if (t.checked > TODAY) err(`${at} checked ${t.checked} is in the future (later than ${TODAY})`);
      // Each term is a page anchor (term-<slug>): the slug must exist and be unique across the whole glossary.
      const slug = slugify(t.term);
      if (!slug) err(`${at} term "${t.term}" has an empty slug (it needs ASCII letters or digits for its page anchor)`);
      else if (seenSlugs.has(slug)) err(`${at} duplicate slug "${slug}" (terms "${seenSlugs.get(slug)}" and "${t.term}" would share one anchor)`);
      else seenSlugs.set(slug, t.term);
      const names = [t.term, ...(Array.isArray(t.aliases) ? t.aliases.filter(a => typeof a === 'string') : [])];
      // Unique term/alias wherever country scopes overlap ([] = general = overlaps everything).
      for (const name of names) {
        const clash = seenNames.find(s => s.name === name && (!s.c.length || !countriesOk || !t.countries.length || s.c.some(c => t.countries.includes(c))));
        if (clash) err(`${at} duplicate term or alias "${name}" (also used by "${clash.term}" in an overlapping country scope)`);
        seenNames.push({ name, term: t.term, c: countriesOk ? t.countries : [] });
      }
      // No orphans: every term must be used (whole word) in a linkable field (lead, employer, employee, note) of some entry in its country scope.
      if (countriesOk && !CHANGES.some(e => (!t.countries.length || t.countries.includes(e.country)) && names.some(n => hasWord(entryText(e), n)))) {
        err(`${at} orphan term: neither "${t.term}" nor an alias appears in the lead, employer, employee or note text of any entry for its countries`);
      }
    });
  }
}

// Country key facts (data/facts.json): rendered as the "Key facts" box on the generated country pages.
// Rules are documented in README.md ("Country key facts").
{
  const FACT_KEYS = ['minimumWage', 'ssEmployer', 'ssEmployee', 'ssCeiling', 'taxBands', 'payFrequency', 'other'];
  const COUNTRY_FIELDS = new Set(['code', 'asOf', 'currency', 'facts']);
  const FACT_FIELDS = new Set(['key', 'label', 'value', 'validFrom', 'note', 'bands', 'sourceUrl', 'sourceLabel', 'checked']);
  const BAND_FIELDS = new Set(['from', 'to', 'rate']);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  // Non-empty, trimmed, plain text (no markup characters, no control characters or line breaks), optionally length-limited.
  const textProblem = (label, v, max) => {
    if (typeof v !== 'string' || !v.trim() || v.trim() !== v) return `${label} must be a non-empty trimmed string`;
    if (/[<>]/.test(v)) return `${label} must be plain text (no < or >)`;
    if (hasBadChar(v)) return `${label} ${BAD_CHARS_MSG}`;
    if (max && v.length > max) return `${label} is ${v.length} characters (max ${max})`;
    return null;
  };
  const utcToday = new Date().toISOString().slice(0, 10);
  const ageDays = iso => Math.floor((Date.parse(utcToday + 'T00:00:00Z') - Date.parse(iso + 'T00:00:00Z')) / 864e5);
  let facts = null;
  try { facts = JSON.parse(fs.readFileSync(new URL('../data/facts.json', import.meta.url), 'utf8')); } catch (e) { err('data/facts.json: facts file missing or not valid JSON (' + e.message + ')'); }
  if (facts !== null && !Array.isArray(facts)) err('data/facts.json: facts must be an array of countries');
  else if (facts !== null) {
    const seenCodes = new Set();
    facts.forEach((c, i) => {
      if (!isObj(c)) { err(`data/facts.json[${i}]: facts entry must be an object`); return; }
      const at = `data/facts.json[${i}] (${typeof c.code === 'string' ? c.code : '?'})`;
      for (const k of Object.keys(c)) if (!COUNTRY_FIELDS.has(k)) err(`${at}: unknown field "${k}" (allowed: ${[...COUNTRY_FIELDS].join(', ')})`);
      if (typeof c.code !== 'string' || !has(countryToRegion, c.code)) err(`${at}: code must be a known country code (as in countryToRegion)`);
      else if (seenCodes.has(c.code)) err(`${at}: duplicate code "${c.code}"`);
      else seenCodes.add(c.code);
      if (!isIsoDay(c.asOf)) err(`${at}: asOf must be a real YYYY-MM-DD date`);
      else if (c.asOf > TODAY) err(`${at}: asOf ${c.asOf} is in the future (later than ${TODAY})`);
      if (typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency)) err(`${at}: currency must be a 3-letter upper-case ISO 4217 code`);
      if (!Array.isArray(c.facts) || !c.facts.length) { err(`${at}: facts must be a non-empty array`); return; }
      const keys = new Set();
      c.facts.forEach((f, j) => {
        if (!isObj(f)) { err(`${at}: fact[${j}] must be an object`); return; }
        const fat = `${at}: fact[${j}] (${typeof f.key === 'string' ? f.key : '?'}):`;
        for (const k of Object.keys(f)) if (!FACT_FIELDS.has(k)) err(`${fat} unknown field "${k}" (allowed: ${[...FACT_FIELDS].join(', ')})`);
        if (typeof f.key !== 'string' || !FACT_KEYS.includes(f.key)) err(`${fat} key must be one of ${FACT_KEYS.join(', ')}`);
        else if (f.key !== 'other') {
          if (keys.has(f.key)) err(`${fat} duplicate key "${f.key}" (only "other" may repeat within a country)`);
          keys.add(f.key);
        }
        for (const [k, max] of [['label', 200], ['value', 300]]) { const p = textProblem(k, f[k], max); if (p) err(`${fat} ${p}`); }
        if (has(f, 'note')) { const p = textProblem('note', f.note, 300); if (p) err(`${fat} ${p}`); }
        if (has(f, 'validFrom') && !isIsoDay(f.validFrom)) err(`${fat} validFrom must be a real YYYY-MM-DD date`);
        // Rates reset every year: a validFrom more than 400 days back suggests a newer figure may exist (warning only).
        else if (has(f, 'validFrom') && ageDays(f.validFrom) > 400) console.warn(`WARNING: ${fat} facts validFrom ${f.validFrom} is more than 400 days ago (key ${f.key}); rates reset annually, so re-check the source.`);
        const fUrl = urlProblem(f.sourceUrl);
        if (fUrl) err(`${fat} sourceUrl ${fUrl}`);
        const sl = textProblem('sourceLabel', f.sourceLabel, 200);
        if (sl) err(`${fat} ${sl}`);
        else if (!/^Source: .+ - .+/.test(f.sourceLabel)) err(`${fat} sourceLabel must look like "Source: <Publisher> - <page title>"`);
        if (!isIsoDay(f.checked)) err(`${fat} checked must be a real YYYY-MM-DD date`);
        else if (f.checked > TODAY) err(`${fat} checked ${f.checked} is in the future (later than ${TODAY})`);
        else if (ageDays(f.checked) > 365) console.warn(`WARNING: ${fat} facts checked ${f.checked} is more than 365 days ago; re-check it against the source.`);
        if (has(f, 'bands')) {
          if (f.key !== 'taxBands') err(`${fat} bands are only allowed on a taxBands fact`);
          else if (!Array.isArray(f.bands) || !f.bands.length) err(`${fat} bands must be a non-empty array`);
          else if (f.bands.length > 20) err(`${fat} bands has ${f.bands.length} rows (max 20)`);
          else f.bands.forEach((b, k) => {
            const bat = `${fat} band[${k}]`;
            if (!isObj(b)) { err(`${bat} must be an object`); return; }
            for (const key of Object.keys(b)) if (!BAND_FIELDS.has(key)) err(`${bat} unknown field "${key}" (allowed: from, to, rate)`);
            for (const key of ['from', 'to', 'rate']) {
              if (key === 'to' && b.to === null) { // null = no upper limit, shown as "No limit"; only the last band can have none
                if (k !== f.bands.length - 1) err(`${bat} to is null (no limit) but only the last band may have no upper limit`);
                continue;
              }
              if (!has(b, key)) { err(`${bat} ${key} is missing`); continue; }
              const p = textProblem(key, b[key], 60);
              if (p) err(`${bat} ${p}`);
            }
          });
        }
      });
    });
  }
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
