// Generates the static, crawlable pages from the CHANGES data in index.html:
//   countries.html, countries/<slug>.html (with the Key facts box from data/facts.json), glossary.html, sitemap.xml, robots.txt, and the canonical links
//   and privacy.html / terms.html (rendered from scripts/templates using scripts/operator.json).
// Run: node scripts/build-pages.mjs          (write files)
//      node scripts/build-pages.mjs --check  (fail if generated files are out of date; used in CI)
// The site's public address is read from <link rel="canonical"> in index.html, so changing
// domain means editing that one tag (and the og/twitter URLs, which --check verifies), then re-running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from './load.mjs';
import { createRequire } from 'node:module';

// Shared status/date helpers (same code the browser uses).
const { statusOf, formatEffective, STATUS_LABELS, linkTerms } = createRequire(import.meta.url)('../filters.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const { html, js, CHANGES, countryToRegion } = loadSite();

const SITE = html.match(/<link rel="canonical" href="([^"]+)"/)[1].replace(/\/?$/, '/');
const VERIFIED_ISO = js.match(/new Date\('(\d{4}-\d{2}-\d{2})T/)[1];
const VERIFIED = new Date(VERIFIED_ISO + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtDay = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// Same rule as freshnessOf() in app.js: labels only for entries added/updated in the FRESH_DAYS up to and
// including the last-verified date (never after it), and never for entries already on the site at launch.
const FRESH_AFTER = js.match(/const FRESH_LABELS_AFTER = '(\d{4}-\d{2}-\d{2})'/)[1];
const FRESH_DAYS = Number(js.match(/const FRESH_DAYS = (\d+);/)[1]);
const FRESH_FROM = new Date(Date.parse(VERIFIED_ISO + 'T00:00:00Z') - (FRESH_DAYS - 1) * 864e5).toISOString().slice(0, 10);
const recent = d => typeof d === 'string' && d > FRESH_AFTER && d >= FRESH_FROM && d <= VERIFIED_ISO;
const freshness = e => recent(e.added) ? 'new' : recent(e.updated) ? 'updated' : null;
const lastChanged = e => (e.updated && e.updated > e.added ? e.updated : e.added);

const IMPACT = {
  high: 'High: a new process, system, filing or calculation method',
  medium: 'Medium: new rates, thresholds or bands to load and check',
  low: 'Low: little or no payroll configuration needed',
};

const REGIONS = { europe: 'Europe', apac: 'APAC', menat: 'MENAT', latam: 'LATAM', africa: 'Africa' };
const ISSUES = 'https://github.com/ankitbansal2k-ui/payroll-atlas/issues';
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'">`;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const statusLabel = e => STATUS_LABELS[statusOf(e, VERIFIED_ISO)];
// Status chip, then the date formatted from `effective` (if any).
const statusChip = e => {
  const k = statusOf(e, VERIFIED_ISO), date = formatEffective(e.effective);
  return `<span class="status-chip status-${k}"><span class="visually-hidden">Status: </span>${esc(STATUS_LABELS[k])}</span>` +
    (date ? ` <span class="status-date">${esc(date)}</span>` : '');
};
const slugify = n => n.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

// ---- group data ----
const countries = new Map();
for (const c of CHANGES) {
  if (!countries.has(c.country)) countries.set(c.country, { code: c.country, name: c.name, flag: c.flag, region: countryToRegion[c.country], slug: slugify(c.name), entries: [] });
  countries.get(c.country).entries.push(c);
}
const slugs = new Set();
for (const c of countries.values()) { if (slugs.has(c.slug)) throw new Error(`duplicate slug ${c.slug}`); slugs.add(c.slug); }
const list = [...countries.values()].sort((a, b) => a.name.localeCompare(b.name));
// Newest first by last change, then by country and section so the order is stable between builds.
const latest = n => [...CHANGES].sort((a, b) => lastChanged(b).localeCompare(lastChanged(a)) || a.name.localeCompare(b.name) || a.section.localeCompare(b.section)).slice(0, n);

// Visitor requests (data/requests.json), reviewed by hand before they are listed. Schema checked in validate.mjs.
const REQUESTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/requests.json'), 'utf8'));
// Glossary terms (data/glossary.json): linked from country page lead paragraphs and listed on glossary.html. Schema checked in validate.mjs.
const GLOSSARY = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/glossary.json'), 'utf8'));
// Country key facts (data/facts.json): the "Key facts" box on a country page, only for countries listed there. Schema checked in validate.mjs.
const FACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/facts.json'), 'utf8'));
if (!Array.isArray(FACTS)) throw new Error('data/facts.json: must be an array');
const FACTS_BY_CODE = new Map();
for (const f of FACTS) {
  if (!countries.has(f.code)) throw new Error(`data/facts.json: unknown country code "${f.code}"`);
  if (FACTS_BY_CODE.has(f.code)) throw new Error(`data/facts.json: duplicate code "${f.code}"`);
  for (const x of f.facts || []) if (typeof x.sourceUrl !== 'string' || !/^https:\/\//.test(x.sourceUrl)) throw new Error(`data/facts.json: ${f.code}/${x.key}: sourceUrl must start with https://`);
  FACTS_BY_CODE.set(f.code, f);
}
// Each term is a page anchor (term-<slug>), so slugs must exist and be unique (validate.mjs reports this too).
for (const t of GLOSSARY) if (!slugify(t.term)) throw new Error(`glossary term "${t.term}" has an empty slug`);
if (new Set(GLOSSARY.map(t => slugify(t.term))).size !== GLOSSARY.length) throw new Error('glossary: duplicate slug');
// The glossary page and its sitemap entry are dated by the newest 'checked' date, not by the changelog's last-verified date.
const GLOSS_CHECKED = GLOSSARY.reduce((m, t) => (t.checked > m ? t.checked : m), '0000-00-00');
const REQ_TYPES = { country: 'New country', rule: 'Missing rule', feature: 'Feature idea' };
const REQ_STATUS = { requested: 'Requested', researching: 'Researching', added: 'Added' };
function requestsSection() {
  const rows = [...REQUESTS].sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
  const body = rows.length
    ? `    <ul class="requests">
${rows.map(r => `      <li><strong>${esc(r.label)}</strong> <span class="count">${REQ_TYPES[r.type]} &middot; ${r.requests} ${r.requests === 1 ? 'request' : 'requests'} &middot; ${REQ_STATUS[r.status]}</span></li>`).join('\n')}
    </ul>`
    : '    <p class="partial">No visitor requests listed yet.</p>';
  return `    <h2 id="requested">Requested by visitors</h2>
    <p>Countries, rules and features visitors have asked for, after review. Contact details are never shown. Want something added? <a href="suggest.html">Suggest it</a>.</p>
${body}`;
}

// ---- templates ----
// ---- on-page SEO helpers ----
// Titles: at most TITLE_MAX characters; descriptions DESC_MIN..DESC_MAX. Enforced by seoProblems() below (--check, warnings when writing).
const TITLE_MAX = 70, DESC_MIN = 70, DESC_MAX = 158, BRAND = 'Intelligent Payroll';
const YEAR = VERIFIED_ISO.slice(0, 4);
const trimTail = s => s.replace(/[\s.,;:–—-]+$/, '');
// Cut at a word boundary so the result is at most `max` characters; no ellipsis.
const clipWords = (s, max) => { if (s.length <= max) return s; let cut = s.slice(0, Math.max(0, max)); if (!/\s/.test(s[max])) cut = cut.replace(/\s*\S*$/, ''); return trimTail(cut); };
// Country description: "<n> tracked payroll change(s) in <Name>: <T><F>. Sources linked, checked <D>."
// T = first entry title, clipped at a word boundary to fit DESC_MAX (budget computed with the longer F), then trailing stopwords/connectors
// are dropped ("rises to", "indexed by"). If clipping removed more than 40% of the title or less than 12 characters remain, T is omitted
// ("<n> tracked ... in <Name><F>. [Payroll law changes, updated every two weeks.] Sources linked ..."). F names the Key facts box, without repeating
// "minimum wage" when T already says it.
const STOP = new Set('to by from for with of in on at and or new the a an up as than into per under over earning who that is are be will between after before when'.split(' '));
function countryDescription(n, nm, hasFacts, firstTitle) {
  const lead = `${n} tracked payroll ${n === 1 ? 'change' : 'changes'} in ${nm}`;
  const FULL = ', plus minimum wage, contributions and tax bands', SHORT = ', plus contributions and tax bands';
  const end = `. Sources linked, checked ${VERIFIED}.`;
  const title = trimTail(firstTitle);
  let t = clipWords(title, DESC_MAX - (lead.length + 2) - ((hasFacts ? FULL.length : 0) + end.length));
  if (t.length < title.length) {
    let w = t.split(' ');
    while (w.length && STOP.has(w.at(-1).toLowerCase().replace(/[^a-z]/g, ''))) w.pop();
    t = trimTail(w.join(' '));
    if (t.length < 12 || t.length < 0.6 * title.length) t = '';
  }
  const f = hasFacts ? (/minimum wage/i.test(t) ? SHORT : FULL) : '';
  let d = t ? `${lead}: ${t}${f}${end}` : `${lead}${f}${end}`;
  if (d.length < DESC_MIN) d = `${lead}${f}. Payroll law changes, updated every two weeks. Sources linked, checked ${VERIFIED}.`;
  return d;
}
// Title with the brand suffix, or without it when the suffix would push it over TITLE_MAX.
const withBrand = base => { const full = `${base} | ${BRAND}`; return full.length <= TITLE_MAX ? full : base; };
// JSON-LD: compact JSON in a data block; < > & and the JS line separators are written as \uXXXX so no data can close the script element.
const ldJson = nodes => JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const ldScript = nodes => `<script type="application/ld+json">${ldJson(nodes)}</script>`;
// Breadcrumb trail: Home first, then [name, absolute url] pairs; the last one is the page itself.
const breadcrumbs = trail => ({ '@type': 'BreadcrumbList', itemListElement: [['Home', SITE], ...trail].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) });

const head = ({ title, desc, url, depth, noindex, graph }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(url)}">
  ${CSP}
  <meta name="theme-color" content="#0B1220">
  ${noindex ? '<meta name="robots" content="noindex">\n  ' : ''}<meta property="og:type" content="website">
  <meta property="og:site_name" content="Intelligent Payroll">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${SITE}og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  ${ldScript(graph)}
  <link rel="icon" type="image/svg+xml" href="${depth}design/assets/favicons/favicon.svg">
  <link rel="alternate" type="application/atom+xml" title="Intelligent Payroll: latest payroll changes" href="${depth}feed.xml">
  <link rel="stylesheet" href="${depth}legal.css">
</head>`;

const header = depth => `  <header><a href="${depth || './'}">Intelligent Payroll</a> <a class="nav" href="${depth}countries.html">All countries</a> <a class="nav" href="${depth}keyfacts.html">Key facts</a> <a class="nav" href="${depth}glossary.html">Glossary</a></header>`;
const footer = depth => `  <footer>
    <p>For information only, not legal or tax advice. Sources last checked ${VERIFIED}. Found an error? <a href="${ISSUES}" rel="noopener">Tell us</a>.</p>
    <p><a href="${depth || './'}">Home</a> &middot; <a href="${depth}countries.html">All countries</a> &middot; <a href="${depth}upcoming.html">What's coming</a> &middot; <a href="${depth}keyfacts.html">Key facts</a> &middot; <a href="${depth}minimum-wage-europe.html">Minimum wage</a> &middot; <a href="${depth}glossary.html">Glossary</a> &middot; <a href="${depth}suggest.html">Suggest a change</a> &middot; <a href="${depth}feed.xml">RSS feed</a> &middot; <a href="${depth}privacy.html">Privacy</a> &middot; <a href="${depth}terms.html">Terms and disclaimer</a></p>
  </footer>`;

// items are HTML (already escaped, possibly with glossary links).
const list2 = (label, items) => items && items.length
  ? `      <div class="who"><h3>${label}</h3><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></div>\n`
  : '';

function entryHtml(e) {
  const d = e.detail;
  // Link each glossary term once per card: the lead first, then employer, employee and note. A term already linked is not linked again.
  let remaining = GLOSSARY;
  const linked = text => {
    const html = linkTerms(text, remaining, e.country);
    const used = new Set([...html.matchAll(/#term-([a-z0-9-]+)"/g)].map(m => m[1]));
    if (used.size) remaining = remaining.filter(t => !used.has(slugify(t.term)));
    return html;
  };
  const leadHtml = linked(d.lead);
  const employerHtml = (d.employer || []).map(linked), employeeHtml = (d.employee || []).map(linked);
  const noteHtml = d.note ? linked(d.note) : '';
  const badges = [statusChip(e)];
  if (e.badge) badges.push(`<span class="badge-note">${esc(e.badge)}</span>`);
  const fresh = freshness(e);
  if (fresh) badges.unshift(`<span class="badge fresh">${fresh === 'new' ? 'New' : 'Updated'}</span>`);
  if (e.impact === 'high') badges.push('<span class="badge impact-high">High impact</span>');
  return `    <article class="entry" id="${esc(e.section)}">
      <h2>${esc(e.title)}</h2>
      <p class="badges">${badges.join(' ')}</p>
      <p>${leadHtml}</p>
${list2('For the employer', employerHtml)}${list2('For the employee', employeeHtml)}${d.example ? `      <p class="example"><strong>In practice:</strong> ${esc(d.example)}</p>\n` : ''}${d.note ? `      <p class="note">${noteHtml}</p>\n` : ''}      <p class="source"><a href="${esc(d.sourceUrl)}" rel="noopener">${esc(d.sourceLabel)}</a> &middot; Payroll impact: ${IMPACT[e.impact]} &middot; Last verified ${VERIFIED} &middot; Added ${fmtDay(e.added)}${e.updated ? ` &middot; Updated ${fmtDay(e.updated)}` : ''}</p>
    </article>`;
}

// Escapes & < > " ' (the facts text and URLs come from a data file, so every value is escaped).
const escF = s => esc(s).replace(/'/g, '&#39;');
// "Key facts" box: label, value, optional valid-from date and note, optional tax-band table, source link with as-of and checked dates.
function factsHtml(c) {
  const data = FACTS_BY_CODE.get(c.code);
  if (!data) return '';
  const fact = f => `      <div class="fact" data-key="${escF(f.key)}">
        <dt class="fact-label">${escF(f.label)}</dt>
        <dd class="fact-body">
          <p class="fact-value">${escF(f.value)}</p>${f.validFrom ? `
          <p class="fact-from">Valid from ${fmtDay(f.validFrom)}</p>` : ''}${f.note ? `
          <p class="fact-note">${escF(f.note)}</p>` : ''}${f.bands ? `
          <div class="table-scroll" tabindex="0" role="region" aria-label="${escF(f.label)} table"><table class="tax-bands"><caption>${escF(f.label)} (${escF(data.currency)})</caption>
            <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Rate</th></tr></thead>
            <tbody>
${f.bands.map(b => `              <tr><td>${escF(b.from)}</td><td>${b.to === null ? 'No limit' : escF(b.to)}</td><td>${escF(b.rate)}</td></tr>`).join('\n')}
            </tbody>
          </table></div>` : ''}
          <p class="fact-source"><a href="${escF(f.sourceUrl)}" rel="noopener">${escF(f.sourceLabel)}</a> &middot; As of ${fmtDay(data.asOf)} &middot; Checked ${fmtDay(f.checked)}</p>
        </dd>
      </div>`;
  return `    <section class="key-facts" aria-labelledby="key-facts">
      <h2 id="key-facts">Key facts</h2>
      <p class="meta">Currency: ${escF(data.currency)}</p>
      <p class="fact-disclaimer">Check the source before use. For information only, not legal or tax advice.</p>
      <dl class="facts">
${data.facts.map(fact).join('\n')}
      </dl>
    </section>
`;
}

function countryPage(c) {
  const ordered = [...c.entries.filter(e => !e.upcoming), ...c.entries.filter(e => e.upcoming)];
  const url = `${SITE}countries/${c.slug}.html`;
  const n = c.entries.length;
  const hasFacts = FACTS_BY_CODE.has(c.code);
  // Title: "<Name> payroll <YEAR>: key facts and law changes" with a Key facts box, else "<Name> payroll law changes <YEAR>"; brand suffix only if it fits.
  // the clipped name only differs from the real name for abnormal names (markup characters, runs of spaces, names too long for a title); real country names pass through unchanged.
  const nm = clipWords(c.name.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim(), TITLE_MAX - (hasFacts ? 39 : 25) - YEAR.length);
  const title = withBrand(hasFacts ? `${nm} payroll ${YEAR}: key facts and law changes` : `${nm} payroll law changes ${YEAR}`);
  // Description: count, first entry title (clipped at a word boundary to fit DESC_MAX), what the page adds, last-verified date.
  const desc = countryDescription(n, nm, hasFacts, ordered[0].title);
  const graph = [breadcrumbs([['All countries', `${SITE}countries.html`], [c.name, url]])];
  const introLinks = hasFacts
    ? ` <a href="#key-facts">Key facts</a> for ${esc(c.name)} are below; <a href="../keyfacts.html">key facts for other countries</a>. See the <a href="../glossary.html">Glossary</a> for abbreviations.`
    : ` See the <a href="../glossary.html">Glossary</a> for abbreviations.`;
  const region = REGIONS[c.region];
  const siblings = list.filter(x => x.region === c.region && x.code !== c.code);
  const partial = n < 2 ? `    <p class="partial">Partial coverage: we currently track ${n} change for this country. Know of another? <a href="../suggest.html">Tell us</a>.</p>\n` : '';
  return `${head({ title, desc, url, depth: '../', graph })}
<body>
${header('../')}
  <main>
    <p class="crumbs"><a href="../">Home</a> &rsaquo; <a href="../countries.html">All countries</a> &rsaquo; ${esc(c.name)}</p>
    <h1>${c.flag} ${esc(c.name)}: payroll law changes</h1>
    <p class="meta">${n} tracked ${n === 1 ? 'change' : 'changes'} &middot; ${region} &middot; sources last checked ${VERIFIED}</p>
    <p>Statutory and legislative payroll changes in ${esc(c.name)}, each linked to the page it was checked against. For information only, not legal or tax advice: confirm details with the source before acting. See the <a href="../terms.html">terms</a>.${introLinks}</p>
    <p><a class="cta" href="../?country=${encodeURIComponent(c.code)}">Open in the interactive changelog</a>${icsCountries.includes(c) ? ` <a class="cta secondary" href="${SITE.replace(/^https:/, 'webcal:')}countries/${c.slug}.ics">Subscribe to ${esc(c.name)} calendar</a> <a href="${c.slug}.ics">Download (.ics)</a>` : ''}</p>
${factsHtml(c)}${partial}
${ordered.map(entryHtml).join('\n\n')}

    <h2 class="more">Related countries in ${region}</h2>
    <p>Missing a rule for ${esc(c.name)}? <a href="../suggest.html">Suggest a change</a>.</p>

    <p class="chips">${siblings.map(s => `<a href="${s.slug}.html">${s.flag} ${esc(s.name)}</a>`).join(' ')}</p>
  </main>
${footer('../')}
</body>
</html>
`;
}

function indexPage() {
  const url = `${SITE}countries.html`;
  const desc = clip(`Payroll law changes for ${list.length} countries across Europe, APAC, MENAT, LATAM and Africa, each entry linked to its source.`, 158);
  const sections = Object.entries(REGIONS).map(([key, label]) => {
    const cs = list.filter(c => c.region === key);
    return `    <h2>${label} <span class="count">(${cs.length})</span></h2>
    <ul class="countries">
${cs.map(c => `      <li><a href="countries/${c.slug}.html">${c.flag} ${esc(c.name)}</a> <span class="count">${c.entries.length} ${c.entries.length === 1 ? 'change' : 'changes'}</span></li>`).join('\n')}
    </ul>`;
  }).join('\n\n');
  // Countries with a single tracked change, generated from CHANGES; omitted entirely when there are none.
  const thin = list.filter(c => c.entries.length === 1).sort((a, b) => a.name.localeCompare(b.name));
  const thinSection = thin.length ? `

    <section id="thin-coverage">
      <h2>Thin coverage</h2>
      <p>These countries have only one tracked change so far. Know a rule we are missing? <a href="suggest.html">Suggest a change</a>.</p>
      <ul class="countries">
${thin.map(c => `        <li><a href="countries/${c.slug}.html">${c.flag} ${esc(c.name)}</a> <span class="count">1 entry</span></li>`).join('\n')}
      </ul>
    </section>` : '';
  return `${head({ title: 'All countries | Intelligent Payroll', desc, url, depth: '', graph: [breadcrumbs([['All countries', url]])] })}
<body>
${header('')}
  <main>
    <h1>All countries</h1>
    <p class="meta">${list.length} countries &middot; ${CHANGES.length} tracked changes &middot; sources last checked ${VERIFIED}</p>
    <p>Pick a country to read its payroll changes with links to the official or professional source for each. Prefer filters and search? <a href="./">Use the interactive changelog</a>.</p>

    <p>Looking ahead? See <a href="upcoming.html">what's coming</a>, in date order, with calendar downloads.</p>

    <h2 id="latest">Latest changes</h2>
    <p>The most recently added or updated entries. Follow them with the <a href="feed.xml">RSS feed</a>.</p>
    <ul class="latest">
${latest(10).map(e => `      <li><a href="countries/${countries.get(e.country).slug}.html#${esc(e.section)}">${e.flag} ${esc(e.name)}: ${esc(e.title)}</a> <span class="when">${e.updated && e.updated > e.added ? 'Updated' : 'Added'} ${fmtDay(lastChanged(e))}</span></li>`).join('\n')}
    </ul>

${sections}${thinSection}

${requestsSection()}
  </main>
${footer('')}
</body>
</html>
`;
}

// Key facts index: every country in data/facts.json, grouped by region (same labels and order as countries.html).
function keyfactsPage() {
  const url = `${SITE}keyfacts.html`;
  const withFacts = list.filter(c => FACTS_BY_CODE.has(c.code));
  const desc = clip(`Minimum wage, tax rates and other payroll key facts for ${withFacts.length} countries, each with its official source and as-of date.`, 158);
  const sections = Object.entries(REGIONS).map(([key, label]) => {
    const cs = withFacts.filter(c => c.region === key);
    if (!cs.length) return '';
    return `    <h2>${label} <span class="count">(${cs.length})</span></h2>
    <ul class="countries">
${cs.map(c => `      <li><a href="countries/${c.slug}.html#key-facts">${c.flag} ${esc(c.name)}</a> <span class="count">${esc(FACTS_BY_CODE.get(c.code).currency)}</span></li>`).join('\n')}
    </ul>`;
  }).filter(Boolean).join('\n\n');
  return `${head({ title: 'Key facts by country | Intelligent Payroll', desc, url, depth: '', graph: [breadcrumbs([['Key facts', url]])] })}
<body>
${header('')}
  <main>
    <h1>Key facts by country</h1>
    <p>Pick a country to see its key payroll facts, such as minimum wage and tax rates. Each fact links to its official or professional source and shows the as of date it is valid from or was last checked. Rules change, so always confirm with the source. Looking for another country? See <a href="countries.html">all countries</a>. To compare countries, see the <a href="minimum-wage-europe.html">minimum wage in Europe</a> table.</p>

${sections}
  </main>
${footer('')}
</body>
</html>
`;
}

// Minimum wage in Europe: one comparison table built only from the `headline` of each country's minimumWage fact in data/facts.json
// (see README "Country key facts"). Countries with headline {statutory:false} are listed below the table instead.
function minWagePage() {
  const url = `${SITE}minimum-wage-europe.html`;
  const items = [];
  for (const d of FACTS) {
    const f = (d.facts || []).find(x => x.key === 'minimumWage' && x.headline);
    if (f) items.push({ d, f, h: f.headline, c: countries.get(d.code) });
  }
  items.sort((a, b) => a.c.name.localeCompare(b.c.name));
  const link = i => `<a href="countries/${i.c.slug}.html#key-facts">${i.c.flag} ${escF(i.c.name)}${i.h.region ? ` (${escF(i.h.region)})` : ''}</a>`;
  const src = i => `<a href="${escF(i.f.sourceUrl)}" rel="noopener">${escF(i.f.sourceLabel)}</a>`;
  const cell = (i, p) => (i.h.period === p ? `${escF(i.d.currency)} ${escF(i.h.amount)}` : '—');
  const rows = items.filter(i => i.h.statutory !== false);
  const none = items.filter(i => i.h.statutory === false);
  const title = withBrand(`Minimum wage in Europe ${YEAR}: statutory rates by country`);
  const desc = `Statutory minimum wage in ${rows.length} European ${rows.length === 1 ? 'country' : 'countries'}, in local currency and not converted, each linked to its source. Checked ${VERIFIED}.`;
  const table = rows.length ? `    <div class="table-scroll" tabindex="0" role="region" aria-label="Minimum wage by country table"><table class="min-wage"><caption>Statutory minimum wage by country, ${YEAR}: monthly and hourly rates as stated by each source</caption>
      <thead><tr><th scope="col">Country</th><th scope="col">Currency</th><th scope="col">Monthly</th><th scope="col">Hourly</th><th scope="col">Applies to</th><th scope="col">Valid from</th><th scope="col">Source</th></tr></thead>
      <tbody>
${rows.map(i => `        <tr><th scope="row">${link(i)}</th><td>${escF(i.d.currency)}</td><td>${cell(i, 'month')}</td><td>${cell(i, 'hour')}</td><td>${escF(i.h.scope)}</td><td>${i.f.validFrom ? fmtDay(i.f.validFrom) : '—'}</td><td>${src(i)}</td></tr>`).join('\n')}
      </tbody>
    </table></div>
` : '';
  const noneSection = none.length ? `
    <h2 id="no-statutory-minimum">No statutory national minimum wage</h2>
    <ul class="no-min-wage">
${none.map(i => `      <li>${link(i)}: ${escF(i.f.value)}${i.f.note ? ` <span class="note">${escF(i.f.note)}</span>` : ''} &middot; ${src(i)}</li>`).join('\n')}
    </ul>
` : '';
  return `${head({ title, desc, url, depth: '', graph: [breadcrumbs([['Minimum wage in Europe', url]])] })}
<body>
${header('')}
  <main>
    <h1>Minimum wage in Europe ${YEAR}</h1>
    <p>The statutory minimum wage of each country, side by side, as stated by its official or professional source. Amounts are in each country's own currency and are not converted. Each country defines the minimum differently, by hours worked or by the month, and many have age bands or other lower or higher rates, so the "Applies to" column names the rate shown; check the source and the <a href="keyfacts.html">key facts</a> page of the country for the full rules. Looking for another country? See <a href="countries.html">all countries</a>. Monthly figures are not comparable across countries: the number of salary payments per year (12, 13 or 14), working hours and the gross/net basis differ, and the monthly and hourly columns measure different things. Some figures are set by collective agreement or apply to one region; the Applies to column says which. For information only, not legal or tax advice.</p>
${table}${noneSection}  </main>
${footer('')}
</body>
</html>
`;
}

// Glossary: abbreviations used in entries, A-Z. Each term has an anchor (term-<slug>) that country pages link to.
const escAttr = s => esc(s).replace(/'/g, '&#39;');
const glossaryGraph = (terms, url) => ({ '@type': 'DefinedTermSet', name: 'Payroll terms and abbreviations', url, hasDefinedTerm: terms.map(t => ({ '@type': 'DefinedTerm', name: t.term, description: t.definition, inDefinedTermSet: url, url: `${url}#term-${slugify(t.term)}` })) });
function glossaryPage() {
  const url = `${SITE}glossary.html`;
  const terms = [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  const desc = clip(`${terms.length} payroll abbreviations and terms explained in plain English, each with a checked official source.`, 158);
  const body = terms.map(t => {
    const where = (t.countries || []).map(code => countries.get(code)).filter(Boolean)
      .map(c => `<a href="countries/${c.slug}.html">${c.flag} ${esc(c.name)}</a>`).join(', ');
    const aliases = t.aliases && t.aliases.length ? `      <p class="aliases">Also written: ${t.aliases.map(escAttr).join(', ')}</p>\n` : '';
    return `    <article class="entry gloss" id="term-${slugify(t.term)}">
      <h2>${escAttr(t.term)}</h2>
      <p class="expansion">${escAttr(t.expansion)}</p>
${aliases}      <p>${escAttr(t.definition)}</p>
      <p class="source">${where ? `Used in: ${where} &middot; ` : ''}<a href="${escAttr(t.sourceUrl)}" rel="noopener">${escAttr(t.sourceLabel)}</a> &middot; Checked ${fmtDay(t.checked)}</p>
    </article>`;
  }).join('\n\n');
  return `${head({ title: 'Glossary: payroll terms and abbreviations | Intelligent Payroll', desc, url, depth: '', graph: [breadcrumbs([['Glossary', url]]), glossaryGraph(terms, url)] })}
<body>
${header('')}
  <main>
    <h1>Glossary</h1>
    <p class="meta">${terms.length} terms &middot; definitions last checked ${fmtDay(GLOSS_CHECKED)}</p>
    <p>Abbreviations and local terms used in the payroll changes we track, in plain English. Each definition links to the page it was checked against. A term that looks the same in another country may mean something different there, so each one lists the countries it applies to. Browse <a href="countries.html">all countries</a> to see the terms in context. For information only, not legal or tax advice.</p>
    <nav class="az" aria-label="Jump to a term">
      <ul>
${terms.map(t => `        <li><a href="#term-${slugify(t.term)}">${escAttr(t.term)}</a></li>`).join('\n')}
      </ul>
    </nav>

${body}
  </main>
${footer('')}
</body>
</html>
`;
}

// Suggestion form: posts to the Cloudflare Worker (worker/index.js), which emails it to the operator.
function suggestPage() {
  const url = `${SITE}suggest.html`;
  const options = Object.entries(REGIONS).map(([key, label]) =>
    `          <optgroup label="${label}">\n${list.filter(c => c.region === key).map(c => `            <option value="${c.code}">${esc(c.name)}</option>`).join('\n')}\n          </optgroup>`).join('\n');
  return `${head({ title: 'Suggest a change | Intelligent Payroll', desc: 'Ask for a country, report a missing or wrong payroll rule, or suggest a feature for Intelligent Payroll.', url, depth: '', graph: [breadcrumbs([['Suggest a change', url]])] })
    .replace("form-action 'none'", "form-action 'self'; script-src 'self'")
    .replace('</head>', '  <script src="suggest.js" defer></script>\n</head>')}
<body>
${header('')}
  <main>
    <h1>Suggest a change</h1>
    <p>Ask for a country, tell us about a rule we are missing or have wrong, or suggest a feature. Suggestions come to us by email and are never published automatically. Popular requests may be listed, without names or contact details, under <a href="countries.html#requested">Requested by visitors</a>.</p>
    <form class="suggest" method="post" action="/api/suggest">
      <label for="s-type">What is it about? <span class="req">(required)</span></label>
      <select id="s-type" name="type" required>
        <option value="">Choose one</option>
        <option value="country">Add a country</option>
        <option value="rule">A missing or wrong rule</option>
        <option value="feature">A feature idea</option>
        <option value="other">Something else</option>
      </select>

      <label for="s-country">Country <span class="opt">(optional)</span></label>
      <select id="s-country" name="country">
        <option value="">None or not relevant</option>
        <option value="other">A country not listed here</option>
${options}
      </select>

      <label for="s-other">Country not listed <span class="opt">(optional)</span></label>
      <input id="s-other" name="otherCountry" type="text" maxlength="100" autocomplete="off">

      <label for="s-details">Your suggestion <span class="req">(required)</span></label>
      <textarea id="s-details" name="details" rows="7" maxlength="2000" required></textarea>
      <p class="hint">Up to 2,000 characters. Please do not include personal data about anyone, such as employee details.</p>

      <label for="s-source">Source link <span class="opt">(optional)</span></label>
      <input id="s-source" name="source" type="url" maxlength="500" placeholder="https://" autocomplete="off">
      <p class="hint">An official page for the rule, if you have one.</p>

      <label for="s-email">Your email <span class="opt">(optional)</span></label>
      <input id="s-email" name="email" type="email" maxlength="254" autocomplete="email">
      <p class="hint">Only if you are happy for us to contact you about this suggestion. We use it for nothing else.</p>

      <div class="hp" aria-hidden="true"><label for="s-website">Leave this empty</label><input id="s-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
      <input type="hidden" name="t" value="">

      <button type="submit" class="cta">Send suggestion</button>
      <p class="hint">We keep suggestions for up to 12 months. See the <a href="privacy.html">privacy notice</a>.</p>
    </form>
  </main>
${footer('')}
</body>
</html>
`;
}

// ---- What's coming: upcoming.html and .ics calendars ----
// Uses the structured `effective` date, shown only as precisely as the source states it.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const upcomingAll = CHANGES.filter(e => e.upcoming)
  .sort((a, b) => (a.effective ?? '9999').localeCompare(b.effective ?? '9999') || a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
const whenLabel = v => v === null ? 'Date not set yet'
  : v.length === 4 ? `Sometime in ${v}`
  : v.length === 7 ? `${MONTHS[+v.slice(5, 7) - 1]} ${v.slice(0, 4)} (day not stated)`
  : fmtDay(v);
// Group key: the month for day/month precision; the year or "undated" otherwise. Keys sort in time order.
const groupOf = v => v === null ? ['~', 'Date not set yet'] : v.length === 4 ? [`${v}-~`, `Sometime in ${v}`] : [v.slice(0, 7), `${MONTHS[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}`];
// Calendars carry only entries with at least a month; "sometime in 2027" would be a misleading 1 January event.
const calendarable = e => e.effective !== null && e.effective.length >= 7;
const icsCountries = list.filter(c => c.entries.some(e => e.upcoming && calendarable(e)));
const icsName = c => `countries/${c.slug}.ics`;

function upcomingPage() {
  const url = `${SITE}upcoming.html`;
  const groups = new Map();
  for (const e of upcomingAll) {
    const [key, label] = groupOf(e.effective);
    if (!groups.has(key)) groups.set(key, { label, items: [] });
    groups.get(key).items.push(e);
  }
  const body = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, g]) => `    <h2>${esc(g.label)}</h2>
    <ul class="timeline">
${g.items.map(e => { const c = countries.get(e.country); return `      <li><span class="when">${esc(whenLabel(e.effective))}</span> <a href="countries/${c.slug}.html#${esc(e.section)}">${e.flag} ${esc(e.name)}: ${esc(e.title)}</a> <span class="count">${REGIONS[c.region]}${e.impact === 'high' ? ' &middot; <strong>high impact</strong>' : ''}</span> ${statusChip(e)}</li>`; }).join('\n')}
    </ul>`).join('\n\n');
  const desc = clip(`${upcomingAll.length} upcoming payroll law changes across ${new Set(upcomingAll.map(e => e.country)).size} countries, by month, each linked to its source. Calendar (.ics) download included.`, 158);
  return `${head({ title: "What's coming: upcoming payroll changes | Intelligent Payroll", desc, url, depth: '', graph: [breadcrumbs([["What's coming", url]])] })}
<body>
${header('')}
  <main>
    <h1>What's coming</h1>
    <p class="meta">${upcomingAll.length} upcoming changes &middot; sources last checked ${VERIFIED}</p>
    <p>Payroll changes that have been announced but are not yet in force, in date order. Dates are shown only as precisely as the source states them. Drafts are proposals that are not yet law and may change. For information only, not legal or tax advice.</p>
    <p><a class="cta" href="${SITE.replace(/^https:/, 'webcal:')}calendar.ics">Subscribe in your calendar app</a> <a class="cta secondary" href="calendar.ics">Download once (.ics)</a></p>
    <h2 class="sub">Keep your calendar up to date</h2>
    <p>Subscribing means your calendar checks this page for new and changed dates by itself after each fortnightly update. A downloaded file is a one-off copy that never changes.</p>
    <ul>
      <li><strong>Google Calendar:</strong> Other calendars, then <em>+</em>, then <em>From URL</em>, and paste <code>${SITE}calendar.ics</code></li>
      <li><strong>Outlook:</strong> Add calendar, then <em>Subscribe from web</em>, and paste the same address.</li>
      <li><strong>Apple Calendar:</strong> File, then <em>New Calendar Subscription</em>, and paste the same address.</li>
    </ul>
    <p class="hint">Calendars refresh on their own schedule (Google can take a day). Changes with only a year are not included, because they have no date to put in a calendar. Calendars for single countries are on each country page, at the same kind of address (for example <code>${SITE}countries/finland.ics</code>).</p>

${body}
  </main>
${footer('')}
</body>
</html>
`;
}

// iCalendar (RFC 5545): CRLF line endings, escaped text, lines folded at 75 octets.
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function icsFold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function icsCalendar(name, entries) {
  const stamp = VERIFIED_ISO.replace(/-/g, '') + 'T000000Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Intelligent Payroll//Upcoming payroll changes//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`];
  for (const e of entries.filter(x => x.upcoming && calendarable(x))) {
    const start = e.effective.length === 7 ? `${e.effective}-01` : e.effective;
    const next = new Date(Date.parse(start + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
    const pageUrl = `${SITE}countries/${countries.get(e.country).slug}.html#${e.section}`;
    const note = e.effective.length === 7 ? `Starts in ${MONTHS[+e.effective.slice(5, 7) - 1]} ${e.effective.slice(0, 4)}; the source does not state the day. ` : '';
    lines.push('BEGIN:VEVENT',
      `UID:${e.country}-${e.section}@${new URL(SITE).hostname.replace(/^www\./, '')}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${next.replace(/-/g, '')}`,
      `SUMMARY:${icsText(`${e.name}: ${e.title}${e.draft ? ' (draft)' : ''}`)}`,
      `DESCRIPTION:${icsText(`${note}${statusLabel(e)}${formatEffective(e.effective) ? ', ' + formatEffective(e.effective) : ''}${e.badge ? ' (' + e.badge + ')' : ''}. ${e.detail.lead}\n\nSource: ${e.detail.sourceUrl}\nDetails: ${pageUrl}\n\nFor information only, not legal or tax advice. Sources last checked ${VERIFIED}.`)}`,
      `URL:${pageUrl}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---- outputs ----
const out = new Map();
out.set('countries.html', indexPage());
out.set('suggest.html', suggestPage());
out.set('glossary.html', glossaryPage());
out.set('keyfacts.html', keyfactsPage());
out.set('minimum-wage-europe.html', minWagePage());
out.set('upcoming.html', upcomingPage());
out.set('calendar.ics', icsCalendar("Intelligent Payroll: what's coming", CHANGES));
for (const c of icsCountries) out.set(icsName(c), icsCalendar(`Intelligent Payroll: ${c.name}`, c.entries));
out.set('worker/countries.json', JSON.stringify(Object.fromEntries(list.map(c => [c.code, c.name])), null, 0) + '\n');
for (const c of list) out.set(`countries/${c.slug}.html`, countryPage(c));

const urls = ['', 'countries.html', ...list.map(c => `countries/${c.slug}.html`), 'upcoming.html', 'keyfacts.html', 'minimum-wage-europe.html', 'glossary.html', 'suggest.html', 'privacy.html', 'terms.html'];
out.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${VERIFIED_ISO}</lastmod></url>`).join('\n')}
</urlset>
`);
// Atom feed of the newest entries (by added/updated date). Entry ids are stable tag: URIs, so readers
// do not show an entry twice when its text changes; a new \`updated\` date resurfaces it.
const FEED_URL = `${SITE}feed.xml`;
const feedEntries = latest(50);
const xmlEsc = s => esc(s).replace(/'/g, '&apos;');
const iso = d => `${d}T00:00:00Z`;
out.set('feed.xml', `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Intelligent Payroll: payroll law changes</title>
  <subtitle>New and updated statutory payroll changes by country, each linked to its source.</subtitle>
  <link href="${SITE}" rel="alternate" type="text/html"/>
  <link href="${FEED_URL}" rel="self" type="application/atom+xml"/>
  <id>${FEED_URL}</id>
  <updated>${iso(feedEntries.length ? lastChanged(feedEntries[0]) : VERIFIED_ISO)}</updated>
  <author><name>Intelligent Payroll</name><uri>${SITE}</uri></author>
  <rights>All rights reserved. For information only, not legal or tax advice.</rights>
${feedEntries.map(e => {
  const url = `${SITE}countries/${countries.get(e.country).slug}.html#${e.section}`;
  const d = e.detail;
  const html = `<p><strong>${esc(statusLabel(e))}${formatEffective(e.effective) ? ', ' + esc(formatEffective(e.effective)) : ''}</strong>${e.badge ? ' &middot; ' + esc(e.badge) : ''}</p><p>${esc(d.lead)}</p>` +
    (d.employer.length ? `<p>For the employer:</p><ul>${d.employer.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '') +
    `<p><a href="${esc(d.sourceUrl)}">${esc(d.sourceLabel)}</a></p><p>For information only, not legal or tax advice.</p>`;
  return `  <entry>
    <title>${xmlEsc(`${e.name}: ${e.title}`)}</title>
    <link href="${xmlEsc(url)}" rel="alternate" type="text/html"/>
    <id>tag:${new URL(SITE).hostname.replace(/^www\./, '')},2026:${xmlEsc(e.country)}/${xmlEsc(e.section)}</id>
    <published>${iso(e.added)}</published>
    <updated>${iso(lastChanged(e))}</updated>
    <category term="${xmlEsc(countryToRegion[e.country])}" label="${REGIONS[countryToRegion[e.country]]}"/>
    <summary>${xmlEsc(clip(d.lead, 280))}</summary>
    <content type="html">${xmlEsc(html)}</content>
  </entry>`;
}).join('\n')}
</feed>
`);
out.set('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);

// ---- legal pages: templates in scripts/templates, facts in scripts/operator.json ----
const op = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/operator.json'), 'utf8'));
const GH = 'https://github.com/ankitbansal2k-ui/payroll-atlas';
const UPDATED = new Date(op.legalUpdated + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const named = Boolean(op.name && op.name.trim());
const issuesLink = `<a href="${ISSUES}" rel="noopener">GitHub Issues</a>`;
const operatorBlock = named
  ? `    <p class="operator"><strong>${esc(op.name)}</strong>${op.registration ? ` (${esc(op.registration)})` : ''}<br>
    ${op.address ? esc(op.address) + '<br>\n    ' : ''}${op.email ? `Email: <a href="mailto:${esc(op.email)}">${esc(op.email)}</a><br>\n    ` : ''}Public contact: ${issuesLink}</p>`
  : `    <p class="operator">The maintainer of the public GitHub repository <a href="${GH}" rel="noopener">ankitbansal2k-ui/payroll-atlas</a> (the &quot;Operator&quot;).<br>
    Contact: ${issuesLink}${op.email ? `, or <a href="mailto:${esc(op.email)}">${esc(op.email)}</a>` : ''}</p>`;
const contactLine = op.email
  ? `Questions, privacy requests and corrections: <a href="mailto:${esc(op.email)}">${esc(op.email)}</a>, or ${issuesLink} (public: do not include personal or confidential information).`
  : `Questions and corrections: open an issue on ${issuesLink}. Issues are public, so do not include personal or confidential information.`;
const rightsRequest = op.email
  ? `To use these rights, email <a href="mailto:${esc(op.email)}">${esc(op.email)}</a>.`
  : `To use these rights, open an issue on ${issuesLink} that says only that you wish to make a privacy request (without personal details), and we will arrange a private way to continue.`;
const hostingSentence = op.githubPagesActive
  ? 'Cloudflare, Inc. serves this site. The older address on GitHub Pages (github.io) is served by GitHub, Inc. while it remains active.'
  : 'Cloudflare, Inc. serves this site and handles the suggestion form.';
const authority = `${esc(op.supervisoryAuthority.name)} (<a href="${esc(op.supervisoryAuthority.url)}" rel="noopener">${esc(op.supervisoryAuthority.url.replace(/^https?:\/\//, ''))}</a>)`;
const fill = tpl => tpl
  .replaceAll('{{SITE}}', SITE).replaceAll('{{UPDATED}}', UPDATED)
  .replaceAll('{{OPERATOR_BLOCK}}', operatorBlock).replaceAll('{{CONTACT_LINE}}', contactLine)
  .replaceAll('{{RIGHTS_REQUEST}}', rightsRequest).replaceAll('{{HOSTING_SENTENCE}}', hostingSentence)
  .replaceAll('{{AUTHORITY}}', authority).replaceAll('{{GOVERNING_LAW}}', esc(op.governingLaw));
for (const f of ['privacy.html', 'terms.html']) {
  const crumb = f === 'privacy.html' ? 'Privacy notice' : 'Terms of use and disclaimer';
  const rendered = fill(fs.readFileSync(path.join(ROOT, 'scripts/templates', f), 'utf8')).replaceAll('{{JSONLD}}', () => ldScript([breadcrumbs([[crumb, SITE + f]])]));
  const left = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`${f}: unfilled template tokens ${left.join(', ')}`);
  out.set(f, rendered);
}
out.set('sitemap.xml', out.get('sitemap.xml').replace(/(privacy|terms)\.html<\/loc><lastmod>[^<]+/g, `$1.html</loc><lastmod>${op.legalUpdated}`)
  .replace(/glossary\.html<\/loc><lastmod>[^<]+/, `glossary.html</loc><lastmod>${GLOSS_CHECKED}`));

// ---- verify index.html social URLs match the canonical host ----
const problems = [];
for (const [re, label] of [[/property="og:url" content="([^"]+)"/, 'og:url'], [/property="og:image" content="([^"]+)"/, 'og:image'], [/name="twitter:image" content="([^"]+)"/, 'twitter:image']]) {
  const m = html.match(re);
  if (!m || !m[1].startsWith(SITE)) problems.push(`index.html ${label} does not start with ${SITE}`);
}

// ---- on-page SEO checks: index.html plus every generated public page (404.html is noindex and excluded) ----
const decodeEnt = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const normWs = x => decodeEnt(x.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const faqVisible = h => [...h.matchAll(/<details class="faq-item">\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)].map(m => [normWs(m[1]), normWs(m[2])]);
function seoProblems(pages) {
  const bad = [], titles = new Map(), descs = new Map();
  for (const [f, h, url] of pages) {
    const one = (re, what) => { const m = [...h.matchAll(re)]; if (m.length !== 1) { bad.push(`${f}: expected exactly one ${what}, found ${m.length}`); return null; } return decodeEnt(m[0][1]); };
    const title = one(/<title>([^<]*)<\/title>/g, '<title>'), desc = one(/<meta name="description" content="([^"]*)">/g, 'meta description');
    const canon = one(/<link rel="canonical" href="([^"]*)">/g, 'canonical link');
    const og = k => one(new RegExp(`<meta property="${k}" content="([^"]*)">`, 'g'), k), tw = k => one(new RegExp(`<meta name="${k}" content="([^"]*)">`, 'g'), k);
    const ogT = og('og:title'), ogD = og('og:description'), ogU = og('og:url'), twT = tw('twitter:title'), twD = tw('twitter:description');
    if (title !== null) {
      if (title.length > TITLE_MAX || !title.length) bad.push(`${f}: title is ${title.length} characters (max ${TITLE_MAX})`);
      if (titles.has(title)) bad.push(`duplicate title "${title}" on ${titles.get(title)} and ${f}`); else titles.set(title, f);
    }
    if (desc !== null) {
      if (desc.length < DESC_MIN || desc.length > DESC_MAX) bad.push(`${f}: description is ${desc.length} characters (must be ${DESC_MIN} to ${DESC_MAX})`);
      if (/[<>]/.test(desc) || !desc.endsWith('.') || desc !== desc.trim()) bad.push(`${f}: description must be plain text ending with a period`);
      if (descs.has(desc)) bad.push(`duplicate description on ${descs.get(desc)} and ${f}`); else descs.set(desc, f);
    }
    if (canon !== null && canon !== url) bad.push(`${f}: canonical must be ${url}`);
    if (ogU !== null && ogU !== canon) bad.push(`${f}: og:url must equal the canonical`);
    if (ogT !== null && ogT !== title) bad.push(`${f}: og:title must equal the <title>`);
    if (twT !== null && twT !== title) bad.push(`${f}: twitter:title must equal the <title>`);
    if (ogD !== null && ogD !== desc) bad.push(`${f}: og:description must equal the description`);
    if (twD !== null && twD !== desc) bad.push(`${f}: twitter:description must equal the description`);
    const h1 = (h.match(/<h1[\s>]/g) || []).length;
    if (h1 !== 1) bad.push(`${f}: expected exactly one <h1>, found ${h1}`);
    const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    if (blocks.length !== 1) bad.push(`${f}: expected exactly one JSON-LD block, found ${blocks.length}`);
    else if (f === 'index.html') {
      let g = null;
      try { const o = JSON.parse(blocks[0][1]); if (o['@context'] === 'https://schema.org' && Array.isArray(o['@graph'])) g = o['@graph']; } catch {}
      if (!g) bad.push('index.html: JSON-LD must be valid JSON with @context https://schema.org and an @graph array');
      else {
        const ws = g.find(n => n['@type'] === 'WebSite'), org = g.find(n => n['@type'] === 'Organization');
        if (!ws || ws.url !== SITE || ws.name !== BRAND || ws.description !== desc) bad.push('index.html: WebSite JSON-LD must carry the site name, url and the meta description');
        if (!org || org.url !== SITE || org.name !== BRAND) bad.push('index.html: Organization JSON-LD must carry the site name and url');
        if (g.some(n => n['@type'] !== 'WebSite' && n['@type'] !== 'Organization') || g.length !== 2) bad.push('index.html: JSON-LD must contain only WebSite and Organization nodes');
      }
    }
  }
  // The "Which countries are covered?" answer must state the real per-region counts.
  const counts = {}; for (const r of Object.values(countryToRegion)) counts[r] = (counts[r] || 0) + 1;
  const ans = (faqVisible(html).find(([q]) => q === 'Which countries are covered?') || [])[1] || '';
  const want = `${Object.keys(countryToRegion).length} countries today, across Europe (${counts.europe}), APAC (${counts.apac}), MENAT (${counts.menat}), LATAM (${counts.latam}), and Africa (${counts.africa}).`;
  if (!ans.startsWith(want)) bad.push(`index.html: FAQ "Which countries are covered?" must start with: ${want}`);
  return bad;
}
{
  const pages = [['index.html', html, SITE]];
  for (const [f, content] of out) if (/\.html$/.test(f)) pages.push([f, content, SITE + f]);
  problems.push(...seoProblems(pages));
}

// ---- write or check ----
const norm = s => s.replace(/\r\n/g, '\n');
const dir = path.join(ROOT, 'countries');
const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.html') || f.endsWith('.ics')).map(f => `countries/${f}`) : [];
const stale = existing.filter(f => !out.has(f));

if (check) {
  for (const [f, content] of out) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) problems.push(`${f} is missing`);
    else if (norm(fs.readFileSync(p, 'utf8')) !== norm(content)) problems.push(`${f} is out of date`);
  }
  for (const f of stale) problems.push(`${f} is no longer generated (delete it)`);
  if (problems.length) {
    console.error(`${problems.length} problem(s). Run: node scripts/build-pages.mjs\n` + problems.map(p => ' - ' + p).join('\n'));
    process.exit(1);
  }
  console.log(`Generated pages are up to date (${out.size} files).`);
} else {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of out) fs.writeFileSync(path.join(ROOT, f), content);
  for (const f of stale) fs.unlinkSync(path.join(ROOT, f));
  console.log(`Wrote ${out.size} files (${list.length} country pages), removed ${stale.length} stale.`);
  for (const p of problems) console.warn('WARNING:', p);
}
