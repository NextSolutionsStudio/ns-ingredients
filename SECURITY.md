# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab), not in
a public issue. Include what you found, how to reproduce it and what it affects. We aim to acknowledge reports
within three working days.

In scope: the API server (`src/`), its authentication, rate limiting and quota, input handling (the label
parser and analyser), and the deployment files in `deploy/`. Also report knowledge-base content that could
cause harm through a clear factual error, such as an allergen stated as absent when it is present. For
ordinary content disagreements, use the correction-request issue form.

## How the service protects what it holds

- **API keys** are random 32-character secrets with an 8-character public prefix. Only a SHA-256 hash is stored,
  and comparison is constant-time. A key is shown once, at creation. Revocation takes effect within the key
  cache window (60 s by default).
- **No personal data is stored.** Analysis profiles are evaluated per request and never persisted or logged.
  Request logs hold the route template, status, latency and key prefix: no bodies, no query strings.
- **Abuse limits:** per-key token bucket, daily quota, a 16 kB body limit, a 12,000-character text limit, and a
  tested CPU budget for the worst-case analysis.
- **Errors** never include stack traces or internal details.
- **The container** runs as a non-root user with `no-new-privileges`, a memory limit, no runtime dependency
  downloads (`--cached-only`), and read access limited to `/app`.
