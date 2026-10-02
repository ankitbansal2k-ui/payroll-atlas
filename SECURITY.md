# Security policy

Intelligent Payroll is a static website (https://www.intelligentpayroll.eu/). It has no accounts, cookies, stored visitor data or backend, and it loads no third-party code.

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** and describe the problem, with steps to reproduce it.

Include the address of the affected page and, if relevant, the link or input that triggers it. We will acknowledge your report as soon as we can, fix confirmed issues promptly, and credit you if you wish.

## In scope

- The live website and its generated pages.
- Cross-site scripting, content injection, open redirects, weaknesses in the security headers or content security policy.
- Mistakes in this repository that expose secrets or allow unwanted changes to the site.

## Out of scope

- Wrong or out-of-date payroll information. Please report those as a normal [issue](https://github.com/ankitbansal2k-ui/payroll-atlas/issues) with a link to the official source.
- Findings that need a compromised device, browser extension or hosting account.
- Automated scanner output with no demonstrated impact.

## How the site is protected

- Strict Content Security Policy (no inline scripts, styles or event handlers), HTTPS only with HSTS, framing blocked.
- Every value that can come from the address bar or the search box is validated and escaped, and a check that runs before each commit rejects unescaped values and inline code.
- GitHub Actions run with read-only permissions and pinned versions.
