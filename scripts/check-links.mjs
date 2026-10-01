// Checks every entry's sourceUrl. Run: node scripts/check-links.mjs
// BROKEN (404/410/5xx/network) fails the run. BLOCKED (403/429/999, usually bot protection)
// is listed for manual review but does not fail the run. Links that redirect to a bare homepage are
// listed as suspect (the page has probably moved).
import { loadSite } from './load.mjs';

const { CHANGES } = loadSite();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const urls = new Map();
for (const c of CHANGES) {
  const u = c.detail.sourceUrl;
  if (!urls.has(u)) urls.set(u, []);
  urls.get(u).push(`${c.country}/${c.section}`);
}

async function probe(url, method) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { method, redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA, accept: 'text/html,application/pdf,*/*' } });
    return { status: r.status, final: r.url };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.name };
  } finally {
    clearTimeout(t);
  }
}

async function check(url) {
  let r = await probe(url, 'HEAD');
  if (r.status === 0 || r.status === 405 || r.status >= 400) r = await probe(url, 'GET');
  if (r.status === 0) { await new Promise(s => setTimeout(s, 1500)); r = await probe(url, 'GET'); }
  return r;
}

const results = [];
const queue = [...urls.keys()];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const url = queue.shift();
    results.push({ url, ...(await check(url)) });
  }
}));

const toHomepage = r => { try { return r.final && new URL(r.final).pathname.length <= 1 && new URL(r.url).pathname.length > 1; } catch { return false; } };
const bucket = r => (r.status >= 200 && r.status < 400 ? (toHomepage(r) ? 'suspect' : 'ok') : [403, 429, 999].includes(r.status) ? 'blocked' : 'broken');
const groups = { ok: [], suspect: [], blocked: [], broken: [] };
for (const r of results) groups[bucket(r)].push(r);
const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  for (const r of list) console.log(` ${r.status || r.error}  ${r.url}\n      used by: ${urls.get(r.url).join(', ')}`);
};
console.log(`${urls.size} unique source URLs: ${groups.ok.length} ok, ${groups.suspect.length} redirect to a homepage, ${groups.blocked.length} blocked, ${groups.broken.length} broken`);
show('BROKEN', groups.broken);
show('REDIRECTS TO A HOMEPAGE (page may have moved)', groups.suspect);
 show('BLOCKED (check manually)', groups.blocked);
process.exit(groups.broken.length ? 1 : 0);
