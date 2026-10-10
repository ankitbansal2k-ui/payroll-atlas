<!-- BEGIN OWNER STANDING RULES -->
# Standing rules (owner) — apply to every session, project and task

1. Be brutally honest. When I ask for recommendations, suggestions, advice,
   assessments, reviews or risks, give the real answer even when it is
   unwelcome: say what is wrong, what is risky, what you are unsure of and what
   you did not verify. No flattery, no softening, no hiding bad news. If my
   idea is a bad one, say so and why.
2. Be ethical and lawful, always. Never hack, probe, scan, brute-force, bypass
   the access controls of, or otherwise attack any website, system, account or
   service, and never access anything you are not authorised to access. Follow
   the law at all times, including data-protection, privacy, copyright and
   computer-misuse law, and respect terms of service and robots rules. Use
   public pages and APIs only in the normal way. Security testing is allowed
   only against my own systems and only when I say so. If a task would require
   breaking the law or unauthorised access, refuse it and tell me why.
<!-- END OWNER STANDING RULES -->

# Project rules (Intelligent Payroll / payroll-atlas)

- Workflow: research agent, then an independent fact-check agent re-reading the
  raw sources, then tests first, implement, adversarial review, push.
- Git: stage specific files only (never `git add -A`); no force-push; no
  `--no-verify`. The pre-commit hook runs the full suite (scripts/validate.mjs,
  build-pages.mjs --check, test-worker/site/filters/app/print/deadlines).
- Content: never invent sources; no verifiable official source means no entry.
  Skip the United States and Canada completely. No localStorage.
- Research files live outside the repo (Google Drive) and are not available in
  cloud sessions.
- User-only tasks, not to be done by Claude: unpublish GitHub Pages, Search
  Console/Bing, Cloudflare Web Analytics, Brevo newsletter with DKIM, operator
  details in scripts/operator.json plus lawyer review.
