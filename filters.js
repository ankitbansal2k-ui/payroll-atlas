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
    const needle = (st.search || '').toLowerCase();
    return changes.filter(c => {
      if (CATEGORIES.includes(filter) && c.category !== filter) return false;
      if (st.when === 'upcoming' && !c.upcoming) return false;
      if (st.when === 'inforce' && c.upcoming) return false;
      if (filter === 'high-impact' && c.impact !== 'high') return false;
      if (picked.length && !picked.includes(c.country)) return false;
      if (st.region && countryToRegion && countryToRegion[c.country] !== st.region) return false;
      // Intentionally wider than old app.js (name+title): also matches detail.lead.
      if (needle && ![c.title, c.name, c.detail && c.detail.lead].some(t => (t || '').toLowerCase().includes(needle))) return false;
      return true;
    });
  }

  // Same slug rule as scripts/build-pages.mjs (country page file names).
  function slugify(n) {
    return n.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

  const api = { MAX_COUNTRIES, WHENS, STATUS_LABELS, statusOf, formatEffective, CATEGORY_LABELS, WHEN_LABELS, parseCountries, serializeCountries, readSelection, readUrlState, applyFilters, slugify, csvCell, toCsv, csvFilename, coverageDepth, depthBucket, depthClass };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.PayrollFilters = api;
})();
