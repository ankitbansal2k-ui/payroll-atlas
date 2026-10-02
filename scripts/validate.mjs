// Fast integrity checks for index.html. Run: node scripts/validate.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadSite } from './load.mjs';

const { html, js, CHANGES, countryToRegion, selects } = loadSite();
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

// XSS guard: values that can come from the address bar or the search box must be escaped
// wherever they are interpolated into a template string that ends up in innerHTML.
{
  const RISKY = /\b(country|countryParam|search|query|term|param|params)\b/;
  const lines = js.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*\{country:/.test(line)) return; // data rows
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
      // Drop the parts that are properly escaped, and plain truthiness tests such as `search ? ...`.
      const rest = m[1]
        .replace(/escapeHtml\((?:[^()]|\([^()]*\))*\)?/g, '')
        .replace(/\b(country|countryParam|search|query|term|param|params)\s*(\?|&&)/g, '');
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
