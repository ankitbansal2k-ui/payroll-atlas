# Intelligent Payroll

A free, source-linked tracker for statutory and legislative payroll changes across 75 countries in Europe, APAC, MENAT, LATAM and Africa. Every entry links to the page it was checked against: a government authority where one could be retrieved, otherwise a published summary from a major tax advisory firm.

**Live site:** https://www.intelligentpayroll.eu/

It is a static site with no build step and no backend. Everything the page needs (fonts, d3, topojson, gsap, world map data) is served from this repository, so visitors make no requests to third parties.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The page markup. No inline scripts, styles or event handlers (see Security) |
| `app.js` | The app logic **and the `CHANGES` data** |
| `reveal.js`, `styles.css` | Scroll animations and all styles |
| `privacy.html`, `terms.html` | **Generated** from `scripts/templates/` and `scripts/operator.json`. Edit those, not the HTML |
| `404.html`, `legal.css` | Error page and the shared stylesheet for legal and generated pages |
| `countries.html`, `countries/*.html` | **Generated.** One static, text-only page per country (and an index) so search engines can read the entries. Do not edit by hand |
| `keyfacts.html` | **Generated.** Index of the countries in `data/facts.json`, grouped by region, each linking to its Key facts box. Linked from the header nav and footer of every page. Do not edit by hand |
| `data/glossary.json`, `glossary.html` | Glossary terms, and the **generated** glossary page built from them (see "The glossary") |
| `data/facts.json` | Country key facts (minimum wage, social security, tax bands, pay frequency) shown as the "Key facts" box on the generated country pages (see "Country key facts") |
| `fonts/`, `vendor/`, `design/` | Self-hosted fonts, libraries and map data, icons and favicon |
| `og-image.png`, `robots.txt`, `sitemap.xml` | Sharing image and search files (`robots.txt` and `sitemap.xml` are generated) |
| `scripts/` | `validate.mjs` (data checks), `check-links.mjs` (source URL checks), `build-pages.mjs` (generates the static pages) |
| `.github/workflows/` | CI: validate on every push, link check monthly |
| `vercel.json` | Security and cache headers if deployed on Vercel |
| `.tastemaker/` | Design style lock (colours, type, contrast rules) |

## Running locally

The map loads its data with `fetch`, so open the site through a web server rather than double-clicking the file:

```bash
python -m http.server 8000
# or: npx serve .
```

Then visit http://localhost:8000/. Node 18 or later is needed only for the scripts.

## The data

All content is the `CHANGES` array in `app.js`, one object per line:

```js
{country:'hk',flag:'🇭🇰',name:'Hong Kong',section:'hk-mpf',title:'...',
 effective:'2025-05-01',added:'2026-10-03',category:'payroll',upcoming:false,
 detail:{lead:'...',employer:['...'],employee:['...'],note:'',example:'',
         sourceUrl:'https://...',sourceLabel:'Source: <Publisher> - <page title>'}},
```

- Every entry shows a **status chip** (In force / Upcoming / Draft — not yet law / Ongoing) followed by the date formatted from `effective` (`1 Jan 2026`, `Sep 2026` or `2026`). Both come from `statusOf()` and `formatEffective()` in `filters.js`, used by the changelog, the generated pages, the feed, the calendar and the CSV Status column. Status: `draft:true` gives Draft, `upcoming:true` gives Upcoming, `effective:null` gives Ongoing, otherwise In force.
- `badge` (optional) is a short free-text note shown after the date, only when it adds something the date cannot say (for example `Phased from 1 Jan 2026`, `Effective 1 Jan 2026 (retroactive)`, `Confirmed for 2026/27`). Leave it out when it would just repeat the date or status: the validator rejects badges such as `Effective 1 Jan 2026`, `From Sep 2026` or `In force` ("restates the date").
- `effective` is the start of the change in machine-readable form, only of the change, only as precise as the source states it (`'2026-01-01'`, `'2026-04'` or `'2026'`). For a phased change use the first phase. Use `null` only when no single start date applies (for example "current rates", or a draft with no date yet). Tax years count from their known start (UK `2026/27` is `'2026-04-06'`).
- `added` is the day the entry was first published (`YYYY-MM-DD`; not later than UTC today plus one day). Do not change it when you edit an entry.
- `updated` (optional, `YYYY-MM-DD`): set it when you make a change readers should notice (new rate, new date, corrected figure), not for typo fixes. It moves the entry to the top of the RSS feed (`feed.xml`) and the "Latest changes" list on `countries.html`.
- "New" and "Updated" labels appear on entries whose `added` or `updated` date falls in the 14 days up to and including the last-verified date (never after it) (`FRESH_DAYS` in `app.js`). Entries that were on the site at launch (on or before `FRESH_LABELS_AFTER`) never get a label.
- The validator checks that `effective` is a real date (and, when a badge is present, that its year appears in the badge or lead), and that `upcoming` agrees with it relative to the last-verified date: a change starting after that date must be `upcoming:true`, one that started before it must be `upcoming:false` (unless it is a draft). After moving the last-verified date forward, run the validator and flip the entries it names.
- `category` is `payroll` or `reporting`.
- `impact` is how much payroll work the change causes for an employer it applies to: `high` (a new process, system, filing or calculation method: project work), `medium` (new rates, thresholds or bands to load and check; the usual case) or `low` (little or no payroll configuration, for example rates confirmed unchanged, or a change that is not really a payroll item). High-impact entries get a label and their own filter.
- `upcoming:true` means not yet in force. Add `draft:true` as well for proposed legislation that is not yet law; the status chip then reads "Draft — not yet law".
- `country` is the key used by the country selectors, the region tabs and the map. Two-letter codes for most countries; full lowercase names for the European ones. A new country must also be added to `countryToRegion`, to **both** `<select class="country-selector">` lists, and to `COUNTRY_ISO` (for the map).
- Section ids must be unique within a country.

### Rules for adding or changing an entry

1. Only record changes in force in the current or previous year, or officially enacted for the future. Proposals must be marked as drafts.
2. Every number, date, rate and authority in the entry must appear on the page in `sourceUrl`. Open the page and check; do not rely on memory or a second-hand summary.
3. Prefer government pages. Use PwC Worldwide Tax Summaries, KPMG, EY, Deloitte or BDO only when a government page cannot be retrieved, and never news sites, blogs or HR vendors.
4. Examples must be arithmetic that follows from the sourced numbers.
5. If a country has nothing verifiable, leave it with fewer entries rather than guessing.

### The glossary

`data/glossary.json` is an array of fact-checked abbreviations and local terms. `node scripts/build-pages.mjs` turns it into `glossary.html` (A to Z, with a jump list, one anchor `#term-<slug>` per term, listed in `sitemap.xml` with the newest `checked` date as `lastmod`) and links terms on the generated country pages. The Glossary link is in the header and footer of every generated page and the legal pages, and in the `index.html` top nav (Home, Changelog, Key facts, Glossary; the last two are normal links to separate pages). In the changelog country picker, the sticky Done button closes the picker, keeps the selection and returns focus to the picker button; clicking outside an open picker also closes it. The interactive changelog (`app.js`) does not link terms.

```json
{"term":"PRSI","countries":["ireland"],
 "expansion":"Pay Related Social Insurance",
 "definition":"Ireland's social insurance contribution, paid by employers and employees. The rate depends on the employee's pay and PRSI class.",
 "sourceUrl":"https://revenue.ie/en/employing-people/paying-your-employees-tax-to-revenue/prsi.aspx",
 "sourceLabel":"Source: Revenue - Pay Related Social Insurance (PRSI)","checked":"2026-10-04"}
```

- Allowed fields: `term`, `aliases` (optional), `countries`, `expansion`, `definition`, `sourceUrl`, `sourceLabel`, `checked`. Unknown fields are rejected.
- `term` is a non-empty, trimmed string; `aliases` (optional) are trimmed, non-empty alternative spellings that link to the same entry. Matching is literal, case-sensitive and whole-word (no letter or digit directly before or after), the longest match wins, and only the first occurrence per term is linked.
- Every term is a page anchor, so its slug (lower-case ASCII letters and digits, e.g. `AHV/IV/EO` gives `ahv-iv-eo`) must not be empty and must be **unique across the whole glossary**, even for terms in different countries. When one acronym means different things in different countries, give each entry its own term and share the acronym as an alias: `WPS (Qatar)` and `WPS (Bahrain)` both have the alias `WPS`, scoped to `qa` and `bh`.
- `countries` lists country codes (as in `countryToRegion`, no duplicates) where the term applies; `[]` means general (every country). A scoped term only links on those countries' pages, so ambiguous acronyms such as `NI` never link in the wrong country. A scope must be supported by the stored source: do not list a country the source does not cover.
- `expansion`, `definition` and `sourceLabel` are plain text: no `<` or `>`, no control characters or line breaks. The definition has 3 to 40 words and at most 300 characters. `sourceUrl` is `https://` without a user name or password; `sourceLabel` follows `Source: <Publisher> - <page title>`; `checked` is a real `YYYY-MM-DD` date. Check every definition against the page in `sourceUrl` and say no more than that page does.
- "Not in the future" (`checked`, and `added`/`updated` on entries) means not later than UTC today plus one day, so authors up to UTC+14 can use their local date.
- A term or alias may appear only once in any overlapping country scope (a general term overlaps everything), and every term must occur as a whole word in the lead, employer, employee or note text of at least one entry within its countries (no orphan terms: titles and examples do not count, because they are not linked). `node scripts/validate.mjs` enforces all of this; failures name "glossary".
- On a country page each term is linked once per entry card, in this order: lead, employer bullets, employee bullets, note. Headings, titles and the example are never linked. Links read `<a class="term"><abbr title="...">TERM</abbr><span class="visually-hidden"> (expansion)</span></a>`, so the expansion is available without hover. Every glossary term must link at least once from some country page; the tests check this. Backlog: `TSD` (Estonia) is researched but not listed, because it only occurs in an entry title.

### Country key facts

`data/facts.json` is an array with one object per country. `node scripts/build-pages.mjs` turns each into a "Key facts" box (`<section class="key-facts">` with the heading `id="key-facts"`, so `#key-facts` links to it) on that country's generated page, between the introduction and the first entry. Countries that are not listed get no box at all, and a fact that could not be verified is simply left out. Every box carries the line "Check the source before use. For information only, not legal or tax advice." and every fact shows its source link, the country's "As of" date and the date the fact was last checked.

```json
{"code":"ireland","asOf":"2026-10-04","currency":"EUR",
 "facts":[
  {"key":"minimumWage","label":"National minimum wage","value":"EUR 13.50 per hour for experienced adult workers",
   "validFrom":"2026-01-01","note":"Lower rates apply to workers under 20.",
   "sourceUrl":"https://example.gov/minimum-wage","sourceLabel":"Source: Example Ministry - National minimum wage","checked":"2026-10-04"},
  {"key":"taxBands","label":"Income tax bands (single person)","value":"20% up to EUR 44,000; 40% above",
   "bands":[{"from":"EUR 0","to":"EUR 44,000","rate":"20%"},{"from":"EUR 44,001","to":null,"rate":"40%"}],
   "sourceUrl":"https://example.gov/tax-bands","sourceLabel":"Source: Example Revenue - Income tax rates and bands","checked":"2026-10-04"}
 ]}
```

- Country fields: `code` (a country code from `countryToRegion`, unique in the file), `asOf` (real `YYYY-MM-DD` date the figures describe), `currency` (three upper-case letters, ISO 4217) and `facts` (a non-empty array). Unknown fields are rejected, on the country, on each fact and on each band.
- Fact fields: `key` (one of `minimumWage`, `ssEmployer`, `ssEmployee`, `ssCeiling`, `taxBands`, `payFrequency`, `other`; each key once per country, except `other`, which may repeat), `label`, `value`, optional `validFrom`, optional `note`, optional `bands`, `sourceUrl`, `sourceLabel`, `checked`.
- `label`, `value`, `note` and the band strings are plain text: trimmed, no `<` or `>`, no control characters or line breaks. `label` and `sourceLabel` have at most 200 characters, `value` and `note` at most 300. Zero-width and other invisible characters and bidirectional overrides are rejected like control characters (in the glossary too). `value` is the figure as the source states it, with unit and period. Where a system is too complex for bands (for example regional minimum wages), use a text `value` and a `note` instead of `bands`.
- `validFrom` (optional) is a real `YYYY-MM-DD` date and may be in the future, for a rate announced for later. It is shown as "Valid from 1 January 2026".
- `bands` (optional, only on `taxBands`, 1 to 20 rows) are objects `{from, to, rate}` of strings up to 60 characters. `to: null` means no upper limit and is shown as "No limit"; only the last band may have it. Start each band one unit above the previous `to` when the source does so (for example `£12,570` then `£12,571`). Bands render as a table with a caption inside a scroll container (`.table-scroll`), so a wide table scrolls by itself and never the page; the container is keyboard-focusable and labelled (`role="region"`, `aria-label` "<label> table").
- `sourceUrl` is `https://` without a user name or password (the build refuses anything else) and only visible ASCII (no quotes, angle brackets or backticks), with a public host name: no IP addresses, no `localhost`; `sourceLabel` follows `Source: <Publisher> - <page title>`. Use an official source (tax authority, social-security institution, labour ministry, official gazette) or a major professional body, and check each value against that page.
- `asOf` and `checked` must not be in the future: not later than UTC today plus one day, so authors up to UTC+14 can use their local date.
- `node scripts/validate.mjs` enforces all of this (failures name "facts") and prints a `WARNING` for every fact whose `checked` date is more than 365 days old and for every `validFrom` more than 400 days back (rates reset every year); the warning never fails the run, so re-check the source and update `checked`. `node scripts/check-links.mjs` also fetches every fact source, labelled `facts/<code>/<key>`.
- In print (and save as PDF) the box is kept, on white, with each fact unbroken and the source address printed after each link.

## On-page SEO

Titles, descriptions and structured data are generated by `scripts/build-pages.mjs` from the data; do not type them per country.

- Country title: `<Name> payroll <YEAR>: key facts and law changes | Intelligent Payroll` when the country has a Key facts box, otherwise `<Name> payroll law changes <YEAR> | Intelligent Payroll`. YEAR is the year of the last-verified date in `app.js`. If the result would exceed 70 characters the ` | Intelligent Payroll` suffix is dropped.
- Country description: `<n> tracked payroll change(s) in <Name>: <first entry title><, plus minimum wage, contributions and tax bands>. Sources linked, checked <date>.` The first entry is the first in page order (non-upcoming first); its title is clipped at a word boundary so the whole description stays within 158 characters. The bracketed part appears only with a Key facts box.
- Every public page (index.html and all generated pages, not 404.html) needs one title of at most 70 characters, one plain-text description of 70 to 158 characters ending with a full stop, one canonical equal to its URL, one `<h1>`, og/twitter title and description equal to the title and description, and a unique title and description. `node scripts/build-pages.mjs --check` enforces this (it only warns when writing).
- JSON-LD: each public page has one `<script type="application/ld+json">` block in the head, `{"@context":"https://schema.org","@graph":[...]}`, with `< > &` and U+2028/U+2029 escaped as `\uXXXX`. Generated pages carry a BreadcrumbList; glossary.html also a DefinedTermSet; privacy and terms get theirs from the `{{JSONLD}}` token in `scripts/templates`. index.html's block (WebSite, Organization, FAQPage) is maintained by hand: when you edit the FAQ, update the FAQPage text to match, because `--check` fails on any difference. Keep the "Which countries are covered?" counts equal to the data (also checked).
- `scripts/validate.mjs` forbids inline scripts except JSON-LD data blocks (type exactly `application/ld+json`, valid JSON, `@context` `https://schema.org`). The CSP is unchanged: data blocks are not executed.

## Legal pages

The privacy notice and terms are written in `scripts/templates/privacy.html` and `terms.html`. Facts that change live in `scripts/operator.json`:

- `name`, `address`, `email`, `registration`: who operates the site. **Fill these in.** While `name` is empty the pages identify the operator only as the maintainer of the GitHub repository, with GitHub Issues as the contact, which is thin for a controller under the GDPR. A named controller with an email address is better, and is expected if the site is run as a business.
- `country`, `governingLaw`, `supervisoryAuthority`: jurisdiction and the data protection authority named in the notice.
- `githubPagesActive`: set to `false` once the old github.io address is unpublished, so the notice stops mentioning GitHub Pages as a host.
- `legalUpdated`: the effective date shown on both pages. Change it whenever the text changes.

After editing, run `node scripts/build-pages.mjs`. Have a lawyer in your country review the texts before relying on them.

## Security

The site is static: no accounts, no cookies, no storage, no third-party requests. It is served with a strict Content Security Policy (`script-src 'self'`, `style-src 'self'`) both as a header in `vercel.json` and as a `<meta>` tag in `index.html`, so injected code cannot run. To keep it that way:

- Do not add inline `<script>`, `<style>`, `style=""` or `onclick=""`-style attributes anywhere. Put code in `app.js`, styles in `styles.css`, and use `data-*` attributes plus the delegated listeners at the bottom of `app.js`.
- Anything that can come from the address bar or the search box must go through `escapeHtml()` before it is put into markup, and the `?country=` value is only accepted if it is a known country code.
- `node scripts/validate.mjs` enforces all of this and fails the commit if it is broken.
- `.well-known/security.txt` tells researchers how to report problems (see `SECURITY.md`). Its `Expires` date must be renewed **once a year**; the validator fails when it has expired and warns 60 days before.
- `.github/dependabot.yml` opens monthly pull requests to update the pinned GitHub Actions versions. Review and merge them.
- Protect the `main` branch with a ruleset that blocks deletion and force-pushes. To rewrite history on purpose, disable the ruleset temporarily and turn it back on afterwards.

## Checks

```bash
node scripts/validate.mjs      # schema, duplicates, selectors vs regions (fast; also runs in CI)
node scripts/build-pages.mjs   # regenerate country pages, sitemap and robots.txt from the data
node scripts/build-pages.mjs --check   # fail if generated files are stale (runs in CI)
node scripts/check-links.mjs   # fetches every entry, glossary and key-facts sourceUrl (well under a minute)
node scripts/check-links.mjs facts/   # only the URLs used by labels starting with that text (here: key facts)
```

Each URL has one 30-second time budget (status request, fallback request and retry together) and the response body is never downloaded, so large PDFs do not slow the run. A server that does not answer in time is listed under BLOCKED as SLOW and does not fail the run: open it in a browser. Set `LINKS_TIMING=1` to print the slowest URLs.

### Git hook (once per clone)

Git hooks are not part of the repository, so install the pre-commit hook after cloning:

```bash
sh scripts/hooks/install.sh
```

It runs `validate.mjs` and `build-pages.mjs --check` before every commit and blocks the commit if the data is invalid, a PDF, archive or file over 1 MB is tracked, or the generated pages are stale. Do not bypass it with `--no-verify`. Keep research downloads outside the repository.

`check-links.mjs` fails on broken links, and lists links that redirect to a homepage (the page has probably moved) or are blocked by bot protection (check those by hand). A certificate-chain error (server omits an intermediate certificate, which browsers repair and Node does not) is downgraded to a manual check, labelled `TLS`, only for hosts in the `TLS_HOSTS` allowlist at the top of the script (currently `www.qcb.gov.qa`); any other host with such an error counts as broken. The glossary `sourceUrl`s are checked too. A GitHub Action runs it on the 1st of every month and `validate.mjs` on every push.

## Fortnightly update routine (every other Sunday evening, Central European Time)

1. Run `node scripts/check-links.mjs` and fix or replace anything it flags.
2. Re-check countries with scheduled changes (new tax year, minimum wage updates, contribution ceilings) against their source pages.
3. Add new entries following the rules above, then run `node scripts/validate.mjs`.
   After any change to `CHANGES`, run `node scripts/build-pages.mjs` and commit the regenerated files. CI fails if you forget.
4. Update `LAST_VERIFIED` in `app.js` (and the dates in `sitemap.xml`, `privacy.html`, `terms.html` if they changed).
5. Commit and push.

## Deploying

The site is plain static files in the repository root, so any static host works.

- **GitHub Pages:** Settings → Pages → deploy from branch `main`, folder `/ (root)`.
- **Vercel:** import the repository, framework preset **Other**, leave the build command and output directory empty. `vercel.json` adds security and cache headers. Note that Vercel's free Hobby plan is for non-commercial use.
- **Cloudflare Pages / Netlify:** connect the repository, no build command, publish directory `/`.

When a custom domain is added, change the address in `index.html` (`canonical`, `og:url`, `og:image`, `twitter:image`) and run `node scripts/build-pages.mjs`. It reads the canonical tag and rewrites every generated page, `sitemap.xml`, `robots.txt` and the canonical links in `privacy.html` and `terms.html`; `--check` flags any `index.html` social URL still on the old host.

## Licence

All rights reserved (see [LICENSE](LICENSE)). The repository is public so the site can be viewed and errors reported, but it is not open source: the code, written content and design may not be copied or reused without permission. The fonts and libraries in `fonts/` and `vendor/` keep their own licences, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), with the full texts alongside the files.

If this ever changes (for example to an open licence for the code), change `LICENSE`, the "source code" bullet in `scripts/templates/terms.html`, and this section together, then run `node scripts/build-pages.mjs`.

## Reporting errors

Open an issue with a link to the official source: https://github.com/ankitbansal2k-ui/payroll-atlas/issues
