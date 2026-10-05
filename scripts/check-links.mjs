// Checks every entry's, glossary term's, country fact's and payroll deadline's sourceUrl. Run: node scripts/check-links.mjs
// BROKEN (404/410/5xx/network) fails the run. BLOCKED (403/429/999, usually bot protection)
// is listed for manual review but does not fail the run. Links that redirect to a bare homepage are
// listed as suspect (the page has probably moved).
import { readFileSync } from 'node:fs';
import { loadSite } from './load.mjs';

const { CHANGES } = loadSite();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const urls = new Map();
for (const c of CHANGES) {
  const u = c.detail.sourceUrl;
  if (!urls.has(u)) urls.set(u, []);
  urls.get(u).push(`${c.country}/${c.section}`);
}

// Glossary sources (data/glossary.json) are checked too.
for (const t of JSON.parse(readFileSync(new URL('../data/glossary.json', import.meta.url), 'utf8'))) {
  if (!urls.has(t.sourceUrl)) urls.set(t.sourceUrl, []);
  urls.get(t.sourceUrl).push(`glossary/${t.term}`);
}

// Country key facts sources (data/facts.json) are checked too, labelled facts/<code>/<key>.
for (const c of JSON.parse(readFileSync(new URL('../data/facts.json', import.meta.url), 'utf8'))) {
  for (const f of c.facts) {
    if (!urls.has(f.sourceUrl)) urls.set(f.sourceUrl, []);
    urls.get(f.sourceUrl).push(`facts/${c.code}/${f.key}`);
  }
}

// Payroll deadline sources (data/deadlines.json) are checked too, labelled deadlines/<id>.
for (const d of JSON.parse(readFileSync(new URL('../data/deadlines.json', import.meta.url), 'utf8'))) {
  if (!urls.has(d.sourceUrl)) urls.set(d.sourceUrl, []);
  urls.get(d.sourceUrl).push(`deadlines/${d.id}`);
}

// Each URL gets one overall time budget (HEAD, GET and the retry together). A server that does not answer in time is listed as
// SLOW under BLOCKED (check manually) and does not fail the run; every other failure keeps its normal handling.
const BUDGET_MS = 30000;
async function probe(url, method, signal) {
  try {
    const r = await fetch(url, { method, redirect: 'follow', signal, headers: { 'user-agent': UA, accept: 'text/html,application/pdf,*/*' } });
    r.body?.cancel().catch(() => {}); // only the status is needed: do not download large PDFs or pages
    return { status: r.status, final: r.url };
  } catch (e) {
    return { status: 0, error: signal.aborted ? 'SLOW' : (e.cause?.code || e.name) };
  }
}

async function check(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), BUDGET_MS);
  const started = Date.now();
  try {
    let r = await probe(url, 'HEAD', ctl.signal);
    if (r.error !== 'SLOW' && (r.status === 0 || r.status === 405 || r.status >= 400)) r = await probe(url, 'GET', ctl.signal);
    if (r.status === 0 && r.error !== 'SLOW') { await new Promise(s => setTimeout(s, 1500)); r = await probe(url, 'GET', ctl.signal); }
    return { ...r, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

const results = [];
// Optional filter: node scripts/check-links.mjs facts/   (only URLs used by labels starting with that text)
const only = process.argv[2];
const queue = [...urls.keys()].filter(u => !only || urls.get(u).some(l => l.startsWith(only)));
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const url = queue.shift();
    results.push({ url, ...(await check(url)) });
  }
}));

const toHomepage = r => { try { return r.final && new URL(r.final).pathname.length <= 1 && new URL(r.url).pathname.length > 1; } catch { return false; } };
// Hosts known to omit an intermediate certificate: browsers repair that, Node cannot, so a certificate-chain error from
// exactly these hosts is listed for manual review (labelled TLS). Any other host with such an error stays BROKEN.
// Add a host only after opening the page in a browser and confirming it loads.
const TLS_CHAIN = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'];
const TLS_HOSTS = new Set(['www.qcb.gov.qa']); // Qatar Central Bank: glossary source for "WPS (Qatar)"
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const isTlsAllowed = r => TLS_CHAIN.includes(r.error) && TLS_HOSTS.has(hostOf(r.url));
const bucket = r => (r.status >= 200 && r.status < 400 ? (toHomepage(r) ? 'suspect' : 'ok') : [403, 429, 999].includes(r.status) || r.error === 'SLOW' || isTlsAllowed(r) ? 'blocked' : 'broken');
const groups = { ok: [], suspect: [], blocked: [], broken: [] };
for (const r of results) groups[bucket(r)].push(r);
const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  for (const r of list) console.log(` ${isTlsAllowed(r) ? 'TLS (certificate chain; open in a browser)' : r.error === 'SLOW' ? `SLOW (no answer within ${BUDGET_MS / 1000} s)` : r.status || r.error}  ${r.url}\n      used by: ${urls.get(r.url).join(', ')}`);
};
console.log(`${results.length} unique source URLs: ${groups.ok.length} ok, ${groups.suspect.length} redirect to a homepage, ${groups.blocked.length} blocked, ${groups.broken.length} broken`);
show('BROKEN', groups.broken);
show('REDIRECTS TO A HOMEPAGE (page may have moved)', groups.suspect);
 show('BLOCKED (check manually)', groups.blocked);
if (process.env.LINKS_TIMING) for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 8)) console.log(`${r.ms} ms  ${r.status || r.error}  ${r.url}`);
process.exit(groups.broken.length ? 1 : 0);
