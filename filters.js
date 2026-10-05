// filters.js: pure helpers for the changelog filters (multi-country selection, URL state, CSV export).
// Classic script: exposes window.PayrollFilters in the browser, module.exports under Node/tests.
// No DOM or browser storage access here; callers pass in data and URL params.
(function () {
  'use strict';

  const MAX_COUNTRIES = 30;
  const FILTERS = ['all', 'payroll', 'reporting', 'high-impact'];
  const WHENS = Object.freeze(['all', 'upcoming', 'inforce']);
  // Shared user-facing labels (data values stay unchanged in URLs and data).
  const CATEGORY_LABELS = Object.freeze({ payroll: 'Payroll', reporting: 'Reporting' });
  const WHEN_LABELS = Object.freeze({ all: 'All dates', upcoming: 'Upcoming', inforce: 'In force' });
  const CATEGORIES = ['payroll', 'reporting'];
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const STATUS_LABELS = Object.freeze({ draft: 'Draft — not yet law', upcoming: 'Upcoming', inforce: 'In force', ongoing: 'Ongoing' });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Parse 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' strictly; returns {y, m, d} (m/d may be 0) or null.
  function parseEffective(v) {
    if (typeof v !== 'string') return null;
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
    if (!m) return null;
    const y = +m[1], mo = m[2] ? +m[2] : 0, d = m[3] ? +m[3] : 0;
    if (m[2] && (mo < 1 || mo > 12)) return null;
    if (m[3]) {
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
      if (d < 1 || d > dim) return null;
    }
    return { y, m: mo, d };
  }

  // '2026-01-01' -> '1 Jan 2026', '2026-09' -> 'Sep 2026', '2026' -> '2026'; invalid -> ''.
  function formatEffective(v) {
    const p = parseEffective(v);
    if (!p) return '';
    if (p.d) return p.d + ' ' + MONTHS[p.m - 1] + ' ' + p.y;
    if (p.m) return MONTHS[p.m - 1] + ' ' + p.y;
    return String(p.y);
  }

  // Status key for an entry: flags first, then the date relative to verifiedIso (if given).
  function statusOf(entry, verifiedIso) {
    const e = entry || {};
    if (e.draft === true) return 'draft';
    if (e.upcoming === true) return 'upcoming';
    if (e.effective === null || e.effective === undefined) return 'ongoing';
    if (typeof verifiedIso === 'string') {
      const p = parseEffective(e.effective);
      if (p) {
        const start = String(p.y).padStart(4, '0') + '-' + String(p.m || 1).padStart(2, '0') + '-' + String(p.d || 1).padStart(2, '0');
        if (start > verifiedIso.slice(0, 10)) return 'upcoming';
      }
    }
    return 'inforce';
  }

  function statusText(c, verifiedIso) {
    const date = formatEffective(c.effective);
    return STATUS_LABELS[statusOf(c, verifiedIso)] + (date ? ', ' + date : '');
  }

  // Parse "a,b,c" into known country codes: trimmed, lower-cased, de-duplicated, capped.
  // Anything not an own key of countryToRegion is dropped (blocks injection and __proto__ tricks).
  function parseCountries(raw, countryToRegion) {
    if (typeof raw !== 'string' || !raw) return [];
    const out = [];
    for (const part of raw.split(',')) {
      if (out.length >= MAX_COUNTRIES) break;
      const code = part.trim().toLowerCase();
      if (code && has(countryToRegion, code) && !out.includes(code)) out.push(code);
    }
    return out;
  }

  // Selection order is preserved.
  function serializeCountries(list) {
    return (list || []).join(',');
  }

  // Merge ?countries= (first) with legacy ?country=, de-duplicated and capped.
  function readSelection(params, countryToRegion) {
    const merged = [params.get('countries'), params.get('country')].filter(Boolean).join(',');
    return parseCountries(merged, countryToRegion);
  }

  // Minimal query-string reader with a URLSearchParams-like get() (first value wins).
  // Hand-rolled so this file has no host dependencies; malformed %-escapes are skipped.
  function parseQuery(search) {
    const map = Object.create(null);
    for (const pair of String(search || '').replace(/^\?/, '').split('&')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      try {
        const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
        const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        if (!(k in map)) map[k] = v;
      } catch (e) { /* skip malformed pair */ }
    }
    return { get: k => (k in map ? map[k] : null) };
  }

  // Full changelog state from a query string. Unknown filter -> 'all'; unknown region dropped.
  function readUrlState(search, countryToRegion) {
    const params = parseQuery(search);
    const filter = params.get('filter');
    const region = params.get('region');
    const regions = Object.keys(countryToRegion).map(k => countryToRegion[k]);
    const q = params.get('q') || '';
    const rawWhen = params.get('when');
    // Legacy ?filter=upcoming maps to the timing toggle; an explicit valid ?when= wins.
    let when = WHENS.includes(rawWhen) ? rawWhen : (filter === 'upcoming' ? 'upcoming' : 'all');
    return {
      countries: readSelection(params, countryToRegion),
      filter: FILTERS.includes(filter) ? filter : 'all',
      when,
      region: region && regions.includes(region) ? region : null,
      search: q // URL param is ?q=, exposed as `search` to match applyFilters state (plan CP2 uses `search`).
    };
  }

  // Filter changes by state {filter, when, countries, region, search}. Keeps original order; never mutates.
  // Region needs the country->region map (changes carry no region field): pass it as the 3rd argument.
  function applyFilters(changes, state, countryToRegion) {
    const st = state || {};
    const filter = st.filter || 'all';
    const picked = st.countries || [];
    const needle = foldForSearch(st.search || '');
    return changes.filter(c => {
      if (CATEGORIES.includes(filter) && c.category !== filter) return false;
      if (st.when === 'upcoming' && !c.upcoming) return false;
      if (st.when === 'inforce' && c.upcoming) return false;
      if (filter === 'high-impact' && c.impact !== 'high') return false;
      if (picked.length && !picked.includes(c.country)) return false;
      if (st.region && countryToRegion && countryToRegion[c.country] !== st.region) return false;
      // Intentionally wider than old app.js (name+title): also matches detail.lead.
      if (needle && ![c.title, c.name, c.detail && c.detail.lead, c.detail && c.detail.sourceLabel].some(t => foldForSearch(t || '').includes(needle))) return false;
      return true;
    });
  }

  const SEARCH_MAX_LENGTH = 200;
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escHtml(s) { return s.replace(/[&<>"']/g, ch => HTML_ESC[ch]); }
  // Shared case fold for search filtering AND highlighting, so a card the filter shows always gets a mark.
  // Lower-cases per code point (astral letters such as Deseret fold too). A code point whose lower case has a
  // different length (Turkish capital dotted I -> "i" + combining dot) is kept unchanged, so the fold is
  // length-preserving and indices map back to the original text. Final sigma folds to plain sigma.
  function foldForSearch(s) {
    let out = '';
    for (const ch of String(s)) {
      const lo = ch.toLowerCase();
      out += lo.length !== ch.length ? ch : lo === 'ς' ? 'σ' : lo;
    }
    return out;
  }

  // Escaped text with case-insensitive literal matches of query wrapped in <mark class="search-hit">.
  // Matching runs on the raw text (never on entities); no regex is built from the query.
  function highlight(text, query) {
    if (text === null || text === undefined) return '';
    const raw = String(text);
    if (typeof query !== 'string' || !query.trim() || query.length > SEARCH_MAX_LENGTH || query.length > raw.length) return escHtml(raw);
    const hay = foldForSearch(raw), needle = foldForSearch(query);
    let out = '', pos = 0, i;
    while ((i = hay.indexOf(needle, pos)) !== -1) {
      out += escHtml(raw.slice(pos, i)) + '<mark class="search-hit">' + escHtml(raw.slice(i, i + needle.length)) + '</mark>';
      pos = i + needle.length;
    }
    return out + escHtml(raw.slice(pos));
  }

  // Same slug rule as scripts/build-pages.mjs (country page file names).
  function slugify(n) {
    return n.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  const WORD_CHAR = /^[\p{L}\p{N}]$/u;
  function isWordCharAt(text, i, before) {
    if (before) {
      if (i <= 0) return false;
      const cp = Array.from(text.slice(Math.max(0, i - 2), i)).pop();
      return WORD_CHAR.test(cp);
    }
    if (i >= text.length) return false;
    return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(i)));
  }

  // HTML for RAW text with the first whole-word occurrence of each applicable glossary entry wrapped in
  // <a class="term" href="HREF#term-SLUG"><abbr title="EXPANSION">MATCH</abbr><span class="visually-hidden"> (EXPANSION)</span></a>.
  // Everything else is escaped.
  // An entry applies when its countries list is empty or includes `country`. The term and its aliases are
  // matched literally and case-sensitively (no regex is built from glossary text); the longest name wins at a
  // position, and a name whose entry is already linked is left as plain text. Never mutates its inputs.
  function linkTerms(text, glossary, country, href) {
    if (text === null || text === undefined) return '';
    const raw = String(text);
    if (!Array.isArray(glossary) || !glossary.length || !raw) return escHtml(raw);
    const base = typeof href === 'string' ? href : '../glossary.html';
    const names = [];
    glossary.forEach((e, idx) => {
      if (!e || typeof e.term !== 'string' || !e.term) return;
      if (Array.isArray(e.countries) && e.countries.length && !e.countries.includes(country)) return;
      const slug = slugify(e.term);
      if (!slug) return;
      for (const name of [e.term, ...(Array.isArray(e.aliases) ? e.aliases : [])]) {
        if (typeof name === 'string' && name) names.push({ name, idx, slug, expansion: String(e.expansion === undefined || e.expansion === null ? '' : e.expansion) });
      }
    });
    if (!names.length) return escHtml(raw);
    names.sort((a, b) => b.name.length - a.name.length);
    const used = new Set();
    let out = '', plainFrom = 0, i = 0;
    while (i < raw.length) {
      let hit = null;
      if (!isWordCharAt(raw, i, true)) {
        for (const n of names) {
          if (raw.startsWith(n.name, i) && !isWordCharAt(raw, i + n.name.length, false)) { hit = n; break; }
        }
      }
      if (!hit) { i++; continue; }
      const end = i + hit.name.length;
      if (!used.has(hit.idx)) {
        used.add(hit.idx);
        // The expansion is also in visually hidden text so it is available without hover (touch, keyboard, screen readers).
        const exp = escHtml(hit.expansion);
        out += escHtml(raw.slice(plainFrom, i)) + '<a class="term" href="' + escHtml(base) + '#term-' + hit.slug + '"><abbr title="' + exp + '">' + escHtml(raw.slice(i, end)) + '</abbr><span class="visually-hidden"> (' + exp + ')</span></a>';
        plainFrom = end;
      }
      i = end;
    }
    return out + escHtml(raw.slice(plainFrom));
  }

  // One CSV cell: neutralise spreadsheet formulas, quote when needed.
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise if the first non-whitespace char is a formula trigger (ASCII or full-width), or the cell starts with tab/CR/LF.
    if (/^\s*[=+\-@|＝＋－＠]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return s[0] === "'" || /[",\r\n]/.test(s) ?'"' + s.replace(/"/g, '""') + '"' : s;
  }

  // CSV of the given (already filtered) changes, with BOM and CRLF line endings. verifiedIso (optional) dates the Status column as statusOf does.
  function toCsv(items, site, verifiedIso) {
    const rows = [['Country', 'Title', 'Effective', 'Status', 'Impact', 'Category', 'Source URL', 'Page URL']];
    for (const c of items) {
      rows.push([c.name, c.title, c.effective, statusText(c, verifiedIso), c.impact, has(CATEGORY_LABELS, c.category) ? CATEGORY_LABELS[c.category] : c.category,
        c.detail && c.detail.sourceUrl, c.name ? (site || '') + 'countries/' + slugify(String(c.name)) + '.html#' + (c.section || '') : '']);
    }
    return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function csvFilename(date) {
    return 'intelligent-payroll-changes-' + String(date).slice(0, 10) + '.csv';
  }

  // Number of entries per country code, as a plain object (no prototype keys leak in).
  function coverageDepth(changes) {
    const counts = Object.create(null);
    for (const c of changes || []) {
      if (!c || typeof c.country !== 'string') continue;
      counts[c.country] = (counts[c.country] || 0) + 1;
    }
    const out = {};
    for (const k of Object.keys(counts)) Object.defineProperty(out, k, { value: counts[k], enumerable: true, writable: true, configurable: true });
    return out;
  }

  // Shading bucket: 1-3 as is, 4 for 4 or more, 0 for anything that is not a positive integer.
  function depthBucket(n) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return 0;
    return n >= 4 ? 4 : n;
  }

  // CSS class for a country's map shape/legend swatch, from its entry count.
  function depthClass(n) { return `depth-${depthBucket(n)}`; }

  // Number normalisation for the minimum-wage headline drift guard (validate.mjs): a token is digits joined by "." or ",".
  // Both separator kinds: the last separator is the decimal mark. One kind, several times: thousands marks. Exactly one: a thousands
  // mark when exactly 3 digits follow it, otherwise the decimal mark. Canonical = integer digits (no thousands marks, no leading
  // zeros) + "." + fraction without trailing zeros. Spaces are not separators.
  function canonicalNumber(token) {
    const t = String(token), seps = [...t.matchAll(/[.,]/g)].map(m => ({ ch: m[0], at: m.index }));
    let dec = -1;
    if (seps.length) {
      const last = seps[seps.length - 1];
      if (new Set(seps.map(x => x.ch)).size === 2) dec = last.at;
      else if (seps.length === 1 && t.length - last.at - 1 !== 3) dec = last.at;
    }
    const ip = (dec < 0 ? t : t.slice(0, dec)).replace(/[.,]/g, '').replace(/^0+(?=\d)/, ''), fp = dec < 0 ? '' : t.slice(dec + 1).replace(/0+$/, '');
    return fp ? ip + '.' + fp : ip;
  }
  // True when some number token in `text` has the same canonical form as `amount`.
  // With `period` ('hour' | 'month') that token must also sit next to a matching period word: within 40 characters on either side,
  // but not beyond a ";" or another number, so "4,806 zl gross per month; minimum hourly rate 31.40" does not make 4,806 hourly.
  const PERIOD_WORDS = { hour: /\b(hour|hourly|per hour|an hour|\/h)\b/i, month: /\b(month|monthly|per month|a month)\b/i };
  function amountInText(amount, text, period) {
    const want = canonicalNumber(amount), s = String(text), toks = [...s.matchAll(/\d+(?:[.,]\d+)*/g)];
    return toks.some((m, i) => {
      if (canonicalNumber(m[0]) !== want) return false;
      if (!period) return true;
      const re = PERIOD_WORDS[period];
      if (!re) return false;
      const from = m.index + m[0].length, nextTok = toks[i + 1] ? toks[i + 1].index : s.length, prevEnd = i ? toks[i - 1].index + toks[i - 1][0].length : 0;
      const after = s.slice(from, Math.min(nextTok, from + 40)).split(';')[0];
      const before = s.slice(Math.max(prevEnd, m.index - 40), m.index).split(';').pop();
      return re.test(after) || re.test(before);
    });
  }

  const api = { canonicalNumber, amountInText, MAX_COUNTRIES, WHENS, STATUS_LABELS, statusOf, formatEffective, CATEGORY_LABELS, WHEN_LABELS, parseCountries, serializeCountries, readSelection, readUrlState, applyFilters, slugify, csvCell, toCsv, csvFilename, coverageDepth, depthBucket, depthClass, highlight, linkTerms, foldForSearch, SEARCH_MAX_LENGTH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.PayrollFilters = api;
})();
