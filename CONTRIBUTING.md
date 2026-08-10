# Contributing

Thanks for helping improve query-table. Bug reports, focused feature proposals,
documentation fixes, tests, and implementation pull requests are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For vulnerabilities, use the private process in [SECURITY.md](SECURITY.md)
instead of opening an issue.

## Development setup

Requirements:

- Node.js 22.14 or newer
- npm 11.5.1 or newer
- Go 1.25 or newer for the backend package

Install exact dependencies and run the normal development gate:

```bash
npm ci
npm run check
```

Useful commands:

```bash
npm test                 # JavaScript and React unit tests
npm run typecheck        # declarations plus source/example/demo type checks
npm run build:demo       # production Vite build
npm run package:check    # tarballs, exports, types, runtime imports, CLI
npm run release:check    # complete pre-release gate, including audits
npm run demo             # local playground on http://localhost:5179
```

The Go package can also be checked directly:

```bash
cd backends/go
go test ./...
go vet ./...
```

## Pull requests

- Keep a pull request focused on one coherent change.
- Add regression tests for behavior changes and security fixes.
- Update package documentation and `CHANGELOG.md` for user-visible changes.
- Preserve the privacy-safe defaults: URL synchronization and durable browser
  storage must remain explicit opt-ins.
- Keep TypeScript and Go validation rules in sync when changing the wire format,
  operators, aggregation capabilities, or resource limits.
- Run `npm run check` before requesting review. Packaging changes must also pass
  `npm run package:check`.

Maintainers may ask to split broad changes or revise an API before merging. A
merged contribution may be included in a later release rather than published
immediately.

## Release checklist

The one-time npm bootstrap and subsequent OIDC release procedures are documented
in [RELEASING.md](RELEASING.md). For every release, maintainers should:

1. Update all public workspace versions and their internal dependency versions
   together.
2. Move relevant entries from `Unreleased` to a dated version in
   `CHANGELOG.md`.
3. Run `npm ci` followed by `npm run release:check`.
4. Inspect `npm pack --dry-run --workspace <package>` for each public package.
5. Follow the applicable release procedure without bypassing its tag, branch,
   trusted-publisher, or package-order safeguards.
6. Publish matching GitHub release notes and verify installation from the npm
   registry in a clean directory.

Never publish from a dirty worktree or bypass the package verification gate.
