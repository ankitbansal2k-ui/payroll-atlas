// Generates the static, crawlable pages from the CHANGES data in index.html:
//   countries.html, countries/<slug>.html, sitemap.xml, robots.txt, and the canonical links
//   and privacy.html / terms.html (rendered from scripts/templates using scripts/operator.json).
// Run: node scripts/build-pages.mjs          (write files)
//      node scripts/build-pages.mjs --check  (fail if generated files are out of date; used in CI)
// The site's public address is read from <link rel="canonical"> in index.html, so changing
// domain means editing that one tag (and the og/twitter URLs, which --check verifies), then re-running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from './load.mjs';

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
const head = ({ title, desc, url, depth, noindex }) => `<!DOCTYPE html>
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
  <link rel="icon" type="image/svg+xml" href="${depth}design/assets/favicons/favicon.svg">
  <link rel="alternate" type="application/atom+xml" title="Intelligent Payroll: latest payroll changes" href="${depth}feed.xml">
  <link rel="stylesheet" href="${depth}legal.css">
</head>`;

const header = depth => `  <header><a href="${depth || './'}">Intelligent Payroll</a> <a class="nav" href="${depth}countries.html">All countries</a></header>`;
const footer = depth => `  <footer>
    <p>For information only, not legal or tax advice. Sources last checked ${VERIFIED}. Found an error? <a href="${ISSUES}" rel="noopener">Tell us</a>.</p>
    <p><a href="${depth || './'}">Home</a> &middot; <a href="${depth}countries.html">All countries</a> &middot; <a href="${depth}upcoming.html">What's coming</a> &middot; <a href="${depth}suggest.html">Suggest a change</a> &middot; <a href="${depth}feed.xml">RSS feed</a> &middot; <a href="${depth}privacy.html">Privacy</a> &middot; <a href="${depth}terms.html">Terms and disclaimer</a></p>
  </footer>`;

const list2 = (label, items) => items && items.length
  ? `      <div class="who"><h3>${label}</h3><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>\n`
  : '';

function entryHtml(e) {
  const d = e.detail;
  const badges = [`<span class="badge">${esc(e.badge)}</span>`];
  const fresh = freshness(e);
  if (fresh) badges.unshift(`<span class="badge fresh">${fresh === 'new' ? 'New' : 'Updated'}</span>`);
  if (e.impact === 'high') badges.push('<span class="badge impact-high">High impact</span>');
  if (e.draft) badges.push('<span class="badge draft">Draft — not yet law</span>');
  else if (e.upcoming) badges.push('<span class="badge upcoming">Upcoming</span>');
  return `    <article class="entry" id="${esc(e.section)}">
      <h2>${esc(e.title)}</h2>
      <p class="badges">${badges.join(' ')}</p>
      <p>${esc(d.lead)}</p>
${list2('For the employer', d.employer)}${list2('For the employee', d.employee)}${d.example ? `      <p class="example"><strong>In practice:</strong> ${esc(d.example)}</p>\n` : ''}${d.note ? `      <p class="note">${esc(d.note)}</p>\n` : ''}      <p class="source"><a href="${esc(d.sourceUrl)}" rel="noopener">${esc(d.sourceLabel)}</a> &middot; Payroll impact: ${IMPACT[e.impact]} &middot; Last verified ${VERIFIED} &middot; Added ${fmtDay(e.added)}${e.updated ? ` &middot; Updated ${fmtDay(e.updated)}` : ''}</p>
    </article>`;
}

function countryPage(c) {
  const ordered = [...c.entries.filter(e => !e.upcoming), ...c.entries.filter(e => e.upcoming)];
  const url = `${SITE}countries/${c.slug}.html`;
  const n = c.entries.length;
  const desc = clip(`${n} payroll ${n === 1 ? 'change' : 'changes'} tracked in ${c.name}: ${ordered[0].title}. Sources linked, last verified ${VERIFIED}.`, 158);
  const region = REGIONS[c.region];
  const siblings = list.filter(x => x.region === c.region && x.code !== c.code);
  const partial = n < 2 ? `    <p class="partial">Partial coverage: we currently track ${n} change for this country. Know of another? <a href="../suggest.html">Tell us</a>.</p>\n` : '';
  return `${head({ title: `${c.name}: payroll law changes | Intelligent Payroll`, desc, url, depth: '../' })}
<body>
${header('../')}
  <main>
    <p class="crumbs"><a href="../countries.html">All countries</a> &rsaquo; ${region}</p>
    <h1>${c.flag} ${esc(c.name)}: payroll law changes</h1>
    <p class="meta">${n} tracked ${n === 1 ? 'change' : 'changes'} &middot; ${region} &middot; sources last checked ${VERIFIED}</p>
    <p>Statutory and legislative payroll changes in ${esc(c.name)}, each linked to the page it was checked against. For information only, not legal or tax advice: confirm details with the source before acting. See the <a href="../terms.html">terms</a>.</p>
    <p><a class="cta" href="../?country=${encodeURIComponent(c.code)}">Open in the interactive changelog</a>${icsCountries.includes(c) ? ` <a class="cta secondary" href="${SITE.replace(/^https:/, 'webcal:')}countries/${c.slug}.ics">Subscribe to ${esc(c.name)} calendar</a> <a href="${c.slug}.ics">Download (.ics)</a>` : ''}</p>
${partial}
${ordered.map(entryHtml).join('\n\n')}

    <h2 class="more">More ${region} countries</h2>
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
  return `${head({ title: 'All countries | Intelligent Payroll', desc, url, depth: '' })}
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

${sections}

${requestsSection()}
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
  return `${head({ title: 'Suggest a change | Intelligent Payroll', desc: 'Ask for a country, report a missing or wrong payroll rule, or suggest a feature for Intelligent Payroll.', url, depth: '' })
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
${g.items.map(e => { const c = countries.get(e.country); return `      <li><span class="when">${esc(whenLabel(e.effective))}</span> <a href="countries/${c.slug}.html#${esc(e.section)}">${e.flag} ${esc(e.name)}: ${esc(e.title)}</a> <span class="count">${REGIONS[c.region]}${e.impact === 'high' ? ' &middot; <strong>high impact</strong>' : ''}${e.draft ? ' &middot; draft, not yet law' : ''}</span></li>`; }).join('\n')}
    </ul>`).join('\n\n');
  const desc = clip(`${upcomingAll.length} upcoming payroll law changes across ${new Set(upcomingAll.map(e => e.country)).size} countries, by month, each linked to its source. Calendar (.ics) download included.`, 158);
  return `${head({ title: "What's coming: upcoming payroll changes | Intelligent Payroll", desc, url, depth: '' })}
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
      `DESCRIPTION:${icsText(`${note}${e.badge}. ${e.detail.lead}\n\nSource: ${e.detail.sourceUrl}\nDetails: ${pageUrl}\n\nFor information only, not legal or tax advice. Sources last checked ${VERIFIED}.`)}`,
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
out.set('upcoming.html', upcomingPage());
out.set('calendar.ics', icsCalendar("Intelligent Payroll: what's coming", CHANGES));
for (const c of icsCountries) out.set(icsName(c), icsCalendar(`Intelligent Payroll: ${c.name}`, c.entries));
out.set('worker/countries.json', JSON.stringify(Object.fromEntries(list.map(c => [c.code, c.name])), null, 0) + '\n');
for (const c of list) out.set(`countries/${c.slug}.html`, countryPage(c));

const urls = ['', 'countries.html', ...list.map(c => `countries/${c.slug}.html`), 'upcoming.html', 'suggest.html', 'privacy.html', 'terms.html'];
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
  const html = `<p><strong>${esc(e.badge)}</strong>${e.draft ? ' (draft, not yet law)' : ''}</p><p>${esc(d.lead)}</p>` +
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
  const rendered = fill(fs.readFileSync(path.join(ROOT, 'scripts/templates', f), 'utf8'));
  const left = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`${f}: unfilled template tokens ${left.join(', ')}`);
  out.set(f, rendered);
}
out.set('sitemap.xml', out.get('sitemap.xml').replace(/(privacy|terms)\.html<\/loc><lastmod>[^<]+/g, `$1.html</loc><lastmod>${op.legalUpdated}`));

// ---- verify index.html social URLs match the canonical host ----
const problems = [];
for (const [re, label] of [[/property="og:url" content="([^"]+)"/, 'og:url'], [/property="og:image" content="([^"]+)"/, 'og:image'], [/name="twitter:image" content="([^"]+)"/, 'twitter:image']]) {
  const m = html.match(re);
  if (!m || !m[1].startsWith(SITE)) problems.push(`index.html ${label} does not start with ${SITE}`);
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
