// Header dropdown groups (details.nav-group): at most one open, closed by an outside click or Escape.
// The groups work without this script (a click on a summary opens and closes its group); this only adds the tidy-up.
// It manages nothing but details.nav-group, so the country picker and other widgets are left alone.
(function () {
  'use strict';
  var SELECTOR = 'details.nav-group';

  function groups() {
    return Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  }

  function closeOthers(keep) {
    groups().forEach(function (g) {
      if (g !== keep && g.open) g.open = false;
    });
  }

  function init() {
    groups().forEach(function (g) {
      g.addEventListener('toggle', function () {
        if (g.open) closeOthers(g);
      });
      // Keyboard: tabbing out of an open group closes it (a click elsewhere is handled below).
      g.addEventListener('focusout', function (e) {
        if (g.open && e.relatedTarget && !g.contains(e.relatedTarget)) g.open = false;
      });
    });
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    groups().forEach(function (g) {
      if (g.open && !g.contains(target)) g.open = false;
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var openGroup = groups().filter(function (g) { return g.open; })[0];
    if (!openGroup) return;
    openGroup.open = false;
    var summary = openGroup.querySelector('summary');
    if (summary) summary.focus();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
