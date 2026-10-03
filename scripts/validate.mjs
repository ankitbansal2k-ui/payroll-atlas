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
const TODAY = new Date().toISOString().slice(0, 10);
const VERIFIED = (js.match(/new Date\('(\d{4}-\d{2}-\d{2})T/) || [])[1];
if (!VERIFIED) err('app.js: could not find the LAST_VERIFIED date');
const isIsoDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
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
const { formatEffective, STATUS_LABELS, statusOf } = createRequire(import.meta.url)('../filters.js');
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
  else if (c.added > TODAY) err(`${id}: added ${c.added} is in the future`);
  if ('updated' in c) {
    if (!isIsoDay(c.updated)) err(`${id}: updated must be YYYY-MM-DD`);
    else if (c.updated > TODAY) err(`${id}: updated ${c.updated} is in the future`);
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
  const RISKY = /\b(country|countryParam|search|query|term|param|params|countries|selection|state)\b/;
  const lines = js.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*\{country:/.test(line)) return; // data rows
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
      // Drop the parts that are properly escaped, and plain truthiness tests such as `search ? ...`.
      const rest = m[1]
        .replace(/escapeHtml\((?:[^()]|\([^()]*\))*\)?/g, '')
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

const perRegion = {};
for (const r of Object.values(countryToRegion)) perRegion[r] = (perRegion[r] || 0) + 1;
console.log(`${CHANGES.length} entries, ${codes.size} countries`, perRegion);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('All checks passed.');
