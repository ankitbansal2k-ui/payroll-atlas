import fs from 'node:fs';
import vm from 'node:vm';

export function loadSite(file = new URL('../index.html', import.meta.url)) {
  const html = fs.readFileSync(file, 'utf8');
  const grab = (startMarker, endMarker, expr) => {
    const i = html.indexOf(startMarker);
    if (i < 0) throw new Error(`Cannot find ${startMarker}`);
    const j = html.indexOf(endMarker, i);
    if (j < 0) throw new Error(`Cannot find end of ${startMarker}`);
    return vm.runInNewContext(`(${expr(html.slice(i, j + endMarker.length))})`);
  };
  const CHANGES = grab('const CHANGES = [', '\n    ];', t => t.replace(/^const CHANGES = /, '').replace(/;$/, ''));
  const countryToRegion = grab('const countryToRegion = {', '\n    };', t => t.replace(/^const countryToRegion = /, '').replace(/;$/, ''));
  const selects = [...html.matchAll(/<select class="country-selector"[\s\S]*?<\/select>/g)].map(m =>
    [...m[0].matchAll(/<option value="([^"]+)"/g)].map(o => o[1]));
  return { html, CHANGES, countryToRegion, selects };
}
