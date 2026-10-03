// CP5 print / save-as-PDF tests: @media print rules in styles.css (index/changelog) and legal.css
// (generated pages: countries.html, countries/*.html, upcoming.html, privacy, terms).
// Run: node scripts/test-print.mjs
// The CSS is parsed with a small brace-matching extractor. Every selector the tests require must also
// match markup that really exists (index.html, app.js render output, generated pages), so a rule cannot
// pass on a dead selector.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- tiny CSS parser ----------
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
function matchBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces in CSS');
}
// Bodies of every @media block whose query mentions `print` (e.g. "@media print", "@media print and (...)").
function printBlocks(css) {
  css = stripComments(css);
  const out = [];
  const re = /@media\s+([^{]*)\{/g;
  let m;
  while ((m = re.exec(css))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(css, open);
    if (/\bprint\b/.test(m[1]) && !/\bnot\s+print\b/.test(m[1])) out.push(css.slice(open + 1, close));
    re.lastIndex = close + 1;
  }
  return out;
}
// Flat rules inside a block: [{ selectors: [...], decls: {prop: value} }]. Nested at-rules are skipped.
function rules(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const prelude = body.slice(i, open).trim();
    const close = matchBrace(body, open);
    const inner = body.slice(open + 1, close);
    if (!prelude.startsWith('@')) {
      const decls = {};
      for (const d of inner.split(';')) {
        const k = d.indexOf(':');
        if (k < 0) continue;
        decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim();
      }
      out.push({ selectors: prelude.split(',').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean), decls });
    }
    i = close + 1;
  }
  return out;
}
const printRules = file => printBlocks(read(file)).flatMap(rules);
const val = v => (v || '').replace(/\s*!important\s*$/i, '').trim().toLowerCase();
// Rules whose selector list contains `sel` (exact, whitespace-normalised).
const rulesFor = (rs, sel) => rs.filter(r => r.selectors.includes(sel));
const declOf = (rs, sel, prop) => { const hits = rulesFor(rs, sel).filter(r => prop in r.decls); return hits.length ? hits.at(-1).decls[prop] : undefined; };
const isWhite = v => /^(#fff|#ffffff|white)$/.test(val(v));
function isDark(v) {
  v = val(v);
  if (v === 'black') return true;
  const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return false;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].every(i => parseInt(h.slice(i, i + 2), 16) <= 0x33);
}

// ---------- markup inventories (for dead-selector checks) ----------
const indexHtml = read('index.html');
const appJs = read('app.js');
const indexMarkup = indexHtml + '\n' + appJs; // app.js renders the cards, chips, banner
const generated = ['countries.html', 'countries/poland.html', 'countries/germany.html', 'upcoming.html', 'privacy.html', 'terms.html'];
const legalMarkup = generated.map(read).join('\n');
// Does a simple selector (tag, #id, .class, tag.class, a[href^="http"], with optional descendant parts and
// ::after) refer to markup that exists? Every compound part must be present somewhere in the markup.
function existsIn(markup, sel) {
  const parts = sel.replace(/::?(after|before)\b/g, '').split(/\s+|>/).filter(Boolean);
  return parts.every(part => {
    const id = part.match(/#([\w-]+)/), cls = [...part.matchAll(/\.([\w-]+)/g)].map(x => x[1]);
    const tag = (part.match(/^([a-z][a-z0-9]*)/i) || [])[1];
    const attrs = [...part.matchAll(/\[([\w-]+)/g)].map(x => x[1]);
    if (id && !new RegExp(`id="${id[1]}"`).test(markup)) return false;
    for (const c of cls) if (!new RegExp(`class="[^"]*(?<![\\w-])${c}(?![\\w-])`).test(markup)) return false;
    if (tag && !new RegExp(`<${tag}[\\s>]`, 'i').test(markup)) return false;
    for (const a of attrs) if (!new RegExp(`\\s${a}[=\\s>]`).test(markup)) return false;
    return true;
  });
}

// ---------- tests ----------
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').slice(0, 4).join('\n     ')}`); }
}

test('parser.sanity: extractor finds rules in a sample @media print block', () => {
  const rs = printBlocks('a{color:red} @media screen{b{x:1}} @media print { .x, .y { display: none !important; } @page { margin: 1cm } }').flatMap(rules);
  assert.equal(rs.length, 1);
  assert.deepEqual(rs[0].selectors, ['.x', '.y']);
  assert.equal(val(rs[0].decls.display), 'none');
});

function hiddenCheck(file, markup, sels) {
  const rs = printRules(file);
  assert.ok(rs.length, `${file} has no @media print rules`);
  const dead = sels.filter(s => !existsIn(markup, s));
  assert.deepEqual(dead, [], `test list refers to selectors missing from the markup: ${dead.join(', ')}`);
  const missing = sels.filter(s => val(declOf(rs, s, 'display')) !== 'none');
  assert.deepEqual(missing, [], `${file} @media print must set display:none on: ${missing.join(', ')}`);
}

// ----- styles.css (index.html / changelog) -----
const INDEX_HIDDEN = [
  'header',              // logo, nav links, country select, search form
  '.region-tabs', '.changelog-filters', '#country-picker', '.chip-remove', '.chip-clear',
  '#export-csv', '#print-page', '.filter-clear', '.coverage-map', '.footer-links', '.item-chevron',
  '.final-cta', '.hero-cta-row'
];

test('css.print_block: styles.css has an @media print block', () => {
  assert.ok(printBlocks(read('styles.css')).length >= 1, 'no @media print in styles.css');
});

test('css.print_block: styles.css hides nav, filter bar, picker, buttons, map, CTAs, footer links', () => {
  hiddenCheck('styles.css', indexMarkup, INDEX_HIDDEN);
});

test('css.print_colours: styles.css prints black-ish text on white', () => {
  const rs = printRules('styles.css');
  const bg = declOf(rs, 'body', 'background') ?? declOf(rs, 'body', 'background-color');
  assert.ok(isWhite(bg), `body background in print must be white, got ${bg}`);
  assert.ok(isDark(declOf(rs, 'body', 'color')), `body color in print must be dark, got ${declOf(rs, 'body', 'color')}`);
  for (const sel of ['.item-card', '.item-detail']) {
    const b = declOf(rs, sel, 'background') ?? declOf(rs, sel, 'background-color');
    assert.ok(b === undefined ? false : (isWhite(b) || val(b) === 'none' || val(b) === 'transparent'), `${sel} background in print must be white/none/transparent, got ${b}`);
  }
});

test('css.print_contrast: every descendant of body forced to dark text with !important', () => {
  const rs = printRules('styles.css');
  const c = declOf(rs, 'body *', 'color') ?? declOf(rs, '*', 'color');
  assert.ok(c !== undefined, 'no `body *` (or `*`) color rule in @media print');
  assert.ok(/!important\s*$/i.test(c), `body * color must be !important, got ${c}`);
  assert.ok(isDark(c), `body * color must be #000..#333, got ${c}`);
});

test('css.print_details: .item-detail shown, cards not split', () => {
  const rs = printRules('styles.css');
  assert.ok(existsIn(indexMarkup, '.item-detail') && existsIn(indexMarkup, '.item-card'));
  assert.equal(val(declOf(rs, '.item-detail', 'display')), 'block', '.item-detail must be display:block in print');
  const bi = val(declOf(rs, '.item-card', 'break-inside')) || val(declOf(rs, '.item-card', 'page-break-inside'));
  assert.equal(bi, 'avoid', '.item-card must have break-inside: avoid');
});

test('css.print_urls: changelog source links print their URL', () => {
  const rs = printRules('styles.css');
  const hit = rs.find(r => r.selectors.some(s => /\.detail-source/.test(s) && /::after$/.test(s)) && /attr\(\s*href\s*\)/.test(r.decls.content || ''));
  assert.ok(hit, 'need e.g. a.detail-source[href^="http"]::after { content: " (" attr(href) ")" }');
  assert.ok(existsIn(indexMarkup, '.detail-source'));
});

test('css.print_reveal: reveal/GSAP elements forced visible with !important', () => {
  const rs = printRules('styles.css');
  // reveal.js animates [data-reveal] and [data-reveal-item] via inline opacity/transform/filter.
  assert.match(read('reveal.js'), /\[data-reveal\], \[data-reveal-item\]/);
  for (const sel of ['[data-reveal]', '[data-reveal-item]']) {
    assert.ok(existsIn(indexHtml, sel), `${sel} not in index.html`);
    for (const [prop, want] of [['opacity', '1'], ['transform', 'none'], ['filter', 'none'], ['visibility', 'visible']]) {
      const v = declOf(rs, sel, prop);
      assert.ok(v && val(v) === want && /!important/i.test(v), `${sel} { ${prop}: ${want} !important } required in print, got ${v}`);
    }
  }
});

test('css.print_header: .print-only hidden on screen, shown in print', () => {
  const top = rules(stripComments(read('styles.css'))); // rules() skips @-blocks, so these are top level
  assert.equal(val(declOf(top, '.print-only', 'display')), 'none', '.print-only { display: none } needed outside @media');
  assert.equal(val(declOf(printRules('styles.css'), '.print-only', 'display')), 'block', '.print-only must be display:block in print');
  assert.match(indexHtml, /<div id="print-header" class="print-only"[^>]*><\/div>/, 'index.html needs <div id="print-header" class="print-only"></div> inside #view-changelog');
  const cl = indexHtml.indexOf('id="view-changelog"'), ph = indexHtml.indexOf('id="print-header"'), list = indexHtml.indexOf('id="changelog-list"');
  assert.ok(cl > 0 && ph > cl && ph < list, '#print-header must sit inside #view-changelog before #changelog-list');
});

test('index.print_button: static Print / PDF button in the filter bar', () => {
  assert.match(indexHtml, /<button type="button" id="print-page"[^>]*data-action="print"[^>]*>Print \/ PDF<\/button>/);
  const filters = indexHtml.indexOf('class="changelog-filters"'), btn = indexHtml.indexOf('id="print-page"'), list = indexHtml.indexOf('id="changelog-list"');
  assert.ok(filters > 0 && btn > filters && btn < list, 'Print button belongs in the changelog filter bar (after .changelog-filters, before #changelog-list)');
  assert.ok(!/id="print-page"[^>]*\son\w+=/.test(indexHtml), 'no inline handler');
  assert.match(appJs, /window\.print\s*\(\s*\)/);
});

// ----- legal.css (generated pages) -----
const LEGAL_HIDDEN = ['header', '.cta', '.chips'];

test('legal.print_block: legal.css hides header nav, CTAs, sibling-country chips, footer link row', () => {
  hiddenCheck('legal.css', legalMarkup, LEGAL_HIDDEN);
  const rs = printRules('legal.css');
  const footerHidden = rs.some(r => r.selectors.some(s => /^footer\b/.test(s) && s !== 'footer') && val(r.decls.display) === 'none');
  assert.ok(footerHidden, 'hide the footer link row (e.g. footer p:last-child { display: none }) but keep the disclaimer');
});

test('legal.print_colours: white background, dark text', () => {
  const rs = printRules('legal.css');
  const bg = declOf(rs, 'body', 'background') ?? declOf(rs, 'body', 'background-color');
  assert.ok(isWhite(bg), `legal.css body background in print must be white, got ${bg}`);
  assert.ok(isDark(declOf(rs, 'body', 'color')), `legal.css body color in print must be dark, got ${declOf(rs, 'body', 'color')}`);
});

test('legal.print_entries: entries not split; source links print URL', () => {
  const rs = printRules('legal.css');
  assert.ok(existsIn(legalMarkup, '.entry') && existsIn(legalMarkup, '.source'));
  const bi = val(declOf(rs, '.entry', 'break-inside')) || val(declOf(rs, '.entry', 'page-break-inside'));
  assert.equal(bi, 'avoid', '.entry must have break-inside: avoid');
  const hit = rs.find(r => r.selectors.some(s => /^\.source\b.*a.*::after$/.test(s)) && /attr\(\s*href\s*\)/.test(r.decls.content || ''));
  assert.ok(hit, 'need e.g. .source a[href^="http"]::after { content: " (" attr(href) ")" }');
});

test('legal.no_print_button: generated pages carry no print button (plan: index/app.js only)', () => {
  assert.ok(!/data-action="print"/.test(legalMarkup));
});

// ---------- P2-6: search highlight (<mark class="search-hit">, built by filters.js highlight) ----------
test('p2_6.search_hit_screen_and_print', () => {
  assert.ok(/class="search-hit"/.test(read('filters.js')), 'filters.js highlight must emit class="search-hit"');
  const css = stripComments(read('styles.css'));
  const screen = rules(css).filter(r => r.selectors.some(s => /(^|\s|mark)\.search-hit$/.test(s)));
  assert.ok(screen.some(r => 'background' in r.decls || 'background-color' in r.decls) && screen.some(r => 'color' in r.decls),
    'screen rule for .search-hit (or mark.search-hit) with explicit background and color (readable on the dark UI)');
  const rs = printRules('styles.css');
  const sel = ['.search-hit', 'mark.search-hit'].find(s => rulesFor(rs, s).length);
  assert.ok(sel, 'need a @media print rule for .search-hit');
  const c = val(declOf(rs, sel, 'color'));
  assert.ok(isDark(c) || c === 'inherit' || c === 'currentcolor', `print .search-hit color must be dark/inherit, got ${c}`);
  const bg = val(declOf(rs, sel, 'background')) || val(declOf(rs, sel, 'background-color'));
  assert.ok(bg !== undefined && bg !== '', 'print .search-hit sets background (e.g. none/transparent or a light tint)');
  assert.ok(!isDark(bg), `print background must not be dark, got ${bg}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
