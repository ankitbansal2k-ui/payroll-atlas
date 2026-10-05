// deadlines.js: the "Coming up in the next 12 months" list on deadlines.html. A progressive enhancement:
// the static tables on the page stay the fallback. Classic script, loaded after filters.js (window.PayrollFilters).
// One same-origin request (deadlines.json). The chosen countries live in the URL only (?countries=uk,spain);
// nothing is stored in the browser. Every value from the data is escaped before it reaches innerHTML.
(function () {
  'use strict';

  var box = document.getElementById('deadlines-upcoming');
  var PF = window.PayrollFilters;
  if (!box || !PF) return;

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var esc = function (v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // 'Sat 31 Oct 2026': the weekday comes from the ISO date read as UTC, so the user's time zone cannot shift it.
  var shortDay = function (iso) {
    var wd = DAYS[new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay()];
    return wd + ' ' + +iso.slice(8, 10) + ' ' + MONTHS[+iso.slice(5, 7) - 1].slice(0, 3) + ' ' + iso.slice(0, 4);
  };
  var monthName = function (iso) { return MONTHS[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4); };

  var data = null;     // {countries, deadlines} once loaded
  var picked = [];     // chosen country codes, in the order they were chosen

  function today() {
    var n = new Date();
    return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  }

  function chipHtml(code) {
    var c = data.countries[code];
    return '<button type="button" class="deadline-chip" data-country="' + esc(code) + '" aria-pressed="' + (picked.indexOf(code) >= 0 ? 'true' : 'false') + '">' +
      esc(c.flag) + ' ' + esc(c.name) + '</button>';
  }

  function itemHtml(hit) {
    var d = hit.deadline, c = data.countries[d.country];
    var source = typeof d.sourceUrl === 'string' && /^https:\/\//i.test(d.sourceUrl)
      ? '<a href="' + esc(d.sourceUrl) + '" rel="noopener">' + esc(d.sourceLabel) + '</a>'
      : '<span class="deadline-source">' + esc(d.sourceLabel) + '</span>';
    return '<li class="deadline-item" data-country="' + esc(d.country) + '" data-id="' + esc(d.id) + '">' +
      '<time datetime="' + esc(hit.date) + '">' + esc(shortDay(hit.date)) + '</time> ' +
      '<span class="deadline-country">' + esc(c.flag) + ' ' + esc(c.name) + '</span> ' +
      '<strong class="deadline-title">' + esc(d.title) + '</strong> ' +
      '<span class="deadline-rule">' + esc(d.ruleText) + '</span> ' + source + ' ' +
      '<span class="deadline-weekend">Non-working day: ' + (typeof d.weekendNote === 'string' && d.weekendNote ? esc(d.weekendNote) : 'check the source') + '</span></li>';
  }

  function render(focusCode) {
    var codes = Object.keys(data.countries);
    var html = '';
    if (codes.length) {
      html += '<div class="deadline-filter" role="group" aria-label="Filter by country">' + codes.map(chipHtml).join('');
      if (picked.length) html += '<button type="button" class="deadline-chip-clear" data-action="clear-countries">Show all countries</button>';
      html += '</div>';
    }
    var list = PF.upcomingList(data.deadlines, today(), 12, picked);
    var who = picked.length ? picked.map(function (c) { return data.countries[c].name; }).join(', ') : 'all countries';
    html += '<p class="deadline-status" role="status">' + list.length + (list.length === 1 ? ' deadline' : ' deadlines') + ' in the next 12 months for ' + esc(who) + '</p>';
    if (!list.length) {
      html += '<p class="deadline-empty">No deadlines fall in the next 12 months' + (picked.length ? ' for the selected countries' : '') + '.</p>';
    } else {
      var month = '';
      list.forEach(function (hit) {
        var m = hit.date.slice(0, 7);
        if (m !== month) {
          if (month) html += '</ul>';
          html += '<h3 class="deadline-month">' + esc(monthName(hit.date)) + '</h3><ul class="deadline-items">';
          month = m;
        }
        html += itemHtml(hit);
      });
      html += '</ul>';
    }
    box.innerHTML = html;
    if (focusCode !== undefined && box.querySelectorAll) {
      // The widget is rebuilt on every change: put the keyboard focus back on the same chip (or the first one after "Show all").
      var chips = box.querySelectorAll('button[data-country]');
      for (var i = 0; i < chips.length; i++) {
        if (focusCode === null ? i === 0 : chips[i].dataset.country === focusCode) { chips[i].focus(); break; }
      }
    }
  }

  function writeUrl() {
    var q = picked.length ? '?countries=' + PF.serializeCountries(picked.map(encodeURIComponent)) : '';
    history.replaceState(null, '', location.pathname + q + location.hash);
  }

  function change(next, focusCode) {
    picked = next;
    render(focusCode);
    writeUrl();
  }

  box.addEventListener('click', function (e) {
    if (!data) return;
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var clear = t.closest('button[data-action="clear-countries"]');
    if (clear) { change([], null); return; }
    var chip = t.closest('button[data-country]');
    if (!chip) return;
    var code = chip.dataset.country;
    if (typeof code !== 'string' || !has(data.countries, code)) return;
    var at = picked.indexOf(code);
    change(at >= 0 ? picked.filter(function (x) { return x !== code; }) : picked.concat([code]), code);
  });

  function fail() {
    data = null;
    box.innerHTML = '<p class="deadline-error">The list of upcoming deadlines could not be loaded. The tables below list every deadline.</p>';
  }

  function start(body) {
    var ok = body && typeof body === 'object' && Array.isArray(body.deadlines) && body.countries && typeof body.countries === 'object' && !Array.isArray(body.countries);
    if (!ok) { fail(); return; }
    data = { countries: body.countries, deadlines: body.deadlines.filter(function (d) { return d && typeof d === 'object' && has(body.countries, d.country); }) };
    var known = {};
    Object.keys(data.countries).forEach(function (code) { known[code] = true; });
    picked = PF.readSelection(new URLSearchParams(location.search), known);
    render();
  }

  try {
    fetch('deadlines.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(start)
      .catch(fail);
  } catch (err) {
    fail();
  }
})();
