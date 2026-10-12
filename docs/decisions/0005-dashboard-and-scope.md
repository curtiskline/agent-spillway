# 0005: Dashboard authentication and positive glob scopes

Accepted 2026-10-12 after independent review.

Browser cookies on loopback are shared across TCP ports. Exchange the initial bearer token for an HttpOnly SameSite cookie scoped to a fresh 256-bit `/view/<secret>/` path. Browser task and artifact links remain within that prefix. Ordinary API paths accept bearer tokens only; knowing a cookie alone cannot authenticate ordinary APIs or guess the dashboard prefix. All private URLs remain sensitive. No external scripts/resources/referrers. Artifact reads require an explicit stored path, regular managed directories, containment and no symbolic-link substitutions.

Scope and protected patterns use positive POSIX globs only. Reject leading negation rather than OR-ing picomatch matchers, which would unintentionally permit unrelated paths. This is explicit syntax restriction, not an exclusion implementation. Risk/test weakening flags require frontier review; checks-only permission is checked again at dispatch and readiness so revocation takes effect.
