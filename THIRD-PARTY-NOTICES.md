# Third-party notices

Intelligent Payroll includes the following third-party files. They are not covered by the project's own
[LICENSE](LICENSE); each remains under its own licence, summarised here and included in full where the licence
requires it.

| Component | Used for | Files | Licence | Licence text |
|---|---|---|---|---|
| [D3](https://d3js.org) 7.9.0, © 2010-2023 Mike Bostock | Drawing the coverage map | `vendor/d3.min.js` | ISC | [`vendor/LICENSE-d3.txt`](vendor/LICENSE-d3.txt) |
| [TopoJSON](https://github.com/topojson/topojson) 3.0.2, © 2012-2016 Michael Bostock | Reading the map data | `vendor/topojson.min.js` | BSD 3-Clause | [`vendor/LICENSE-topojson.txt`](vendor/LICENSE-topojson.txt) |
| [world-atlas](https://github.com/topojson/world-atlas) 2, © 2013-2019 Michael Bostock | World country outlines | `vendor/countries-110m.json` | ISC | [`vendor/LICENSE-world-atlas.txt`](vendor/LICENSE-world-atlas.txt) |
| [Natural Earth](https://www.naturalearthdata.com) (the data behind world-atlas) | Country boundaries | `vendor/countries-110m.json` | Public domain | None required |
| [GSAP](https://gsap.com) 3.12.5, © 2024 GreenSock | Scroll animations | `vendor/gsap.min.js` | GSAP Standard License | Terms at <https://gsap.com/standard-license>; the notice in the file header is kept intact |
| [Manrope](https://github.com/sharanda/manrope), © 2019 The Manrope Project Authors | Text font (served as web font subsets) | `fonts/manrope-*.woff2` | SIL Open Font License 1.1 | [`fonts/OFL-Manrope.txt`](fonts/OFL-Manrope.txt) |
| [Geist Mono](https://github.com/vercel/geist-font), © 2024 The Geist Project Authors | Monospace font (served as web font subsets) | `fonts/geist-mono-*.woff2` | SIL Open Font License 1.1 | [`fonts/OFL-Geist-Mono.txt`](fonts/OFL-Geist-Mono.txt) |

The font files come from the [Fontsource](https://fontsource.org) distribution of each typeface. D3 is distributed
together with its own dependencies under compatible permissive licences; see the D3 repository for details.

## Developer tooling

The scripts in `scripts/` use only Node.js built-in modules and add no third-party code.
