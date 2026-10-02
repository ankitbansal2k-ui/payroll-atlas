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
{country:'hk',flag:'🇭🇰',name:'Hong Kong',section:'hk-mpf',title:'...',badge:'Effective 1 May 2025',
 category:'payroll',upcoming:false,
 detail:{lead:'...',employer:['...'],employee:['...'],note:'',example:'',
         sourceUrl:'https://...',sourceLabel:'Source: <Publisher> - <page title>'}},
```

- `category` is `payroll`, `reporting` or `infrastructure`.
- `upcoming:true` means not yet in force. Add `draft:true` as well for proposed legislation that is not yet law; the site then shows a "Draft — not yet law" badge.
- `country` is the key used by the country selectors, the region tabs and the map. Two-letter codes for most countries; full lowercase names for the European ones. A new country must also be added to `countryToRegion`, to **both** `<select class="country-selector">` lists, and to `COUNTRY_ISO` (for the map).
- Section ids must be unique within a country.

### Rules for adding or changing an entry

1. Only record changes in force in the current or previous year, or officially enacted for the future. Proposals must be marked as drafts.
2. Every number, date, rate and authority in the entry must appear on the page in `sourceUrl`. Open the page and check; do not rely on memory or a second-hand summary.
3. Prefer government pages. Use PwC Worldwide Tax Summaries, KPMG, EY, Deloitte or BDO only when a government page cannot be retrieved, and never news sites, blogs or HR vendors.
4. Examples must be arithmetic that follows from the sourced numbers.
5. If a country has nothing verifiable, leave it with fewer entries rather than guessing.

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
node scripts/check-links.mjs   # fetches every sourceUrl (about a minute)
```

### Git hook (once per clone)

Git hooks are not part of the repository, so install the pre-commit hook after cloning:

```bash
sh scripts/hooks/install.sh
```

It runs `validate.mjs` and `build-pages.mjs --check` before every commit and blocks the commit if the data is invalid, a PDF, archive or file over 1 MB is tracked, or the generated pages are stale. Do not bypass it with `--no-verify`. Keep research downloads outside the repository.

`check-links.mjs` fails on broken links, and lists links that redirect to a homepage (the page has probably moved) or are blocked by bot protection (check those by hand). A GitHub Action runs it on the 1st of every month and `validate.mjs` on every push.

## Monthly update routine

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

## Reporting errors

Open an issue with a link to the official source: https://github.com/ankitbansal2k-ui/payroll-atlas/issues
