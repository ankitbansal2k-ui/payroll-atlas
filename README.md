# Payroll Atlas

A free, source-linked tracker for statutory and legislative payroll changes across 75 countries in Europe, APAC, MENAT, LATAM and Africa. Every entry links to the page it was checked against: a government authority where one could be retrieved, otherwise a published summary from a major tax advisory firm.

**Live site:** https://ankitbansal2k-ui.github.io/payroll-atlas/

It is a static site with no build step and no backend. Everything the page needs (fonts, d3, topojson, gsap, world map data) is served from this repository, so visitors make no requests to third parties.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The whole app: markup, styles, script and the `CHANGES` data |
| `privacy.html`, `terms.html`, `404.html`, `legal.css` | Legal pages, error page and the shared stylesheet |
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

All content is the `CHANGES` array in `index.html`, one object per line:

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
4. Update `LAST_VERIFIED` in `index.html` (and the dates in `sitemap.xml`, `privacy.html`, `terms.html` if they changed).
5. Commit and push.

## Deploying

The site is plain static files in the repository root, so any static host works.

- **GitHub Pages:** Settings → Pages → deploy from branch `main`, folder `/ (root)`.
- **Vercel:** import the repository, framework preset **Other**, leave the build command and output directory empty. `vercel.json` adds security and cache headers. Note that Vercel's free Hobby plan is for non-commercial use.
- **Cloudflare Pages / Netlify:** connect the repository, no build command, publish directory `/`.

When a custom domain is added, change the address in `index.html` (`canonical`, `og:url`, `og:image`, `twitter:image`) and run `node scripts/build-pages.mjs`. It reads the canonical tag and rewrites every generated page, `sitemap.xml`, `robots.txt` and the canonical links in `privacy.html` and `terms.html`; `--check` flags any `index.html` social URL still on the old host.

## Reporting errors

Open an issue with a link to the official source: https://github.com/ankitbansal2k-ui/payroll-atlas/issues
