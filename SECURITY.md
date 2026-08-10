# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's **Report a vulnerability** form on the repository's Security tab.
Include the affected package and version, reproduction steps, impact, and any
suggested mitigation. Maintainers will acknowledge a report within five
business days and will coordinate disclosure after a fix is available.

If private vulnerability reporting is temporarily unavailable, contact a
maintainer privately and ask for a secure reporting channel. Do not include
exploit details in a public discussion.

## Supported versions

Until the first stable release, security fixes are made on the latest release
only. This policy will be updated when multiple release lines are supported.

## Security properties and deployment guidance

- URL query synchronization is disabled by default. Enabling `syncUrl` places
  the complete query, including raw filter values, in a base64url token. That
  token is not encrypted and can appear in browser history, referrers, logs,
  analytics, bookmarks, and screenshots.
- Durable browser storage is opt-in. `localStorageAdapter()` stores query data
  as cleartext JSON; use a server-backed `StorageAdapter` with appropriate
  access controls for sensitive datasets.
- The Go SQL compiler parameterizes values and allowlists field expressions.
  Applications must define schema expressions exclusively in trusted server
  configuration and must not derive them from request input.
- Applications should still enforce authentication, authorization, request-size
  limits, timeouts, and database statement timeouts at their API boundary.
