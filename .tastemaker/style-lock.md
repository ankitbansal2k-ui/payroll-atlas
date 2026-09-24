# Style lock — Payroll Atlas

## Direction contract
- **Thesis:** a free, government-sourced compliance reference reads as trustworthy through restraint and precision, not through SaaS gradient flourish. Lead with what it protects the team from (missed deadlines), not a generic value prop.
- **Mood:** technical, leaning premium (per reference research: RegTech/fintech trust pages use conservative navy/deep-tone palettes, real numbers over round ones, compliance-as-safety framing above the fold).
- **Reference sourcing:** web search only (no reference images supplied). Searched "compliance tracking SaaS landing page design 2026 regtech dashboard hero" — findings: (1) hero leads with what's protected before what's enabled, (2) deep navy/green palettes signal stability over generic indigo/purple, (3) real specific numbers beat round marketing stats. Applied: swapped the prior generic blue/purple duo for a navy + teal-emerald system; kept the existing real stats (159+, 45+, 29) rather than inventing new ones.
- **First viewport:** headline + one-line subhead + single CTA + a real product mockup card (live changelog preview), not a stock photo — this is a data tool, a photo would be decorative filler.
- **System:** hand-rolled static HTML/CSS/JS (existing stack, no framework). No shadcn/React registries apply.
- **Risk:** no Python in this environment, so `generate_palette.py` / `check_contrast.py` / `anti_slop_scan.py` did not run. Palette was hand-derived and contrast-verified with an equivalent WCAG luminance calculation in Node (see Color contract below) — same math, manual harness. Said here plainly per the skill's honesty rule.

## Color contract (dark, single mode — site is dark-only by design, matches Personio-inspired original direction)

| Token | Hex | Role |
|---|---|---|
| bg | #0B1220 | page background |
| surface | #121B2E | card / section background |
| surface-raised | #182338 | nested card, hover surface |
| border | #26334A | dividers (decorative only, not contrast-critical) |
| text | #EDF1F7 | primary text |
| text-secondary | #9FB0C7 | secondary text |
| primary (accent) | #2DD4A3 | links, CTAs, active states, stat values |
| on-primary | #04140F | text on primary-filled buttons |
| warning | #F0A93B | "upcoming" badges |
| error | #F0576B | reserved, not currently used |

Verified pairings (Node WCAG luminance calc, equivalent to `check_contrast.py --matrix`):

| Pairing | Ratio | Status |
|---|---|---|
| text / bg | 16.52 | text-safe |
| text / surface | 15.16 | text-safe |
| text-secondary / bg | 8.48 | text-safe |
| text-secondary / surface | 7.78 | text-safe |
| primary / bg | 9.86 | text-safe |
| primary / surface | 9.05 | text-safe |
| on-primary / primary | 9.94 | text-safe |
| warning / bg | 9.31 | text-safe |
| error / bg | 5.60 | text-safe |
| primary / surface-raised | 8.27 | text-safe |
| border / surface | 1.35 | decorative only — never use border color to convey information alone |

Legal pairings: any of {text, text-secondary, primary, warning, error} may sit on any of {bg, surface, surface-raised}. `on-primary` only ever sits on `primary` fills.

## Type contract
- **Manrope** — display/headings and body (geometric, confident, one family covers both roles).
- **Geist Mono** — dates, stat values, badges (tabular figures, functionally required for numeric alignment).
- No italics. No weight above 700 (bold cap, per skill).

## Density & spacing
- Section padding: hero and final CTA get 6rem–8rem vertical (pivotal); connective sections (how-it-works, benefits) get 5rem. Not uniform.
- Card internal padding: minimum 1.75rem (≥ external gap of 1.5rem between cards — internal ≥ external rule satisfied).

## Structure (Step 2.5)
- **Cold start** — no `.tastemaker/log.json` or `~/.tastemaker/structure-history.json` existed before this build, so there is no prior pick to rotate against in this project. Logged now for future builds.
- **Macrostructure:** Long-form narrative stack — Hook (hero) → Problem (tagline reveal, reframed as cost-of-missing-a-change) → Solution (what it provides) → Mechanism (how it works) → Proof (benefits + stats) → Objection handling (FAQ) → Close (final CTA). Six beats.
- **Hero archetype:** headline + subhead + single primary CTA + live-data mockup card (not a dashboard-of-everything hero — one visual focus per hero guidelines).
- **Nav:** floating pill removed as a requirement — kept the existing sticky bar nav since a full fluid-island rebuild was out of the user's requested scope (landing page design, not navigation system); noted as a deliberate scope boundary, not an oversight.

## Assets
- **Icons:** Phosphor (`ph`) bold set via Iconify (`api.iconify.design`), tinted to `#2DD4A3`, saved to `design/assets/icons/`. No API key, no attribution required (Iconify open icon sets).
- **Photography:** deliberately skipped. This is a data/reference tool, not a lifestyle or physical product — a stock photo of an office or a laptop would be decorative filler, not "showing" the product. Used a real-data UI mockup card instead (see Hero archetype).
- **Illustrations:** not used — `~/.ideagram/undraw/` is not populated in this environment and no image-gen tool is connected. Said here plainly rather than shipping a fallback and implying it's custom art.
- **Motion:** GSAP + ScrollTrigger via CDN (`cdnjs`), scroll reveals + one sequenced hero entrance. This is a marketing/landing screen (scrolled once), not an app shell, so the scroll-timeline track applies per the skill's motion-track split.

## Honesty notes
- Python-based tastemaker scripts (`generate_palette.py`, `check_contrast.py`, `anti_slop_scan.py`, `audit_motion.py`, `check_component_coherence.py`, `check_structure_history.py`, `check_copy_diversity.py`) could not run — no Python interpreter in this environment. Equivalent checks were done by hand (contrast math in Node, manual re-read for em dashes / generic phrasing / motion tells) and are recorded in this file and the build stamp instead of tool output.
