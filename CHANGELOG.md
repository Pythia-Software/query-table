# Changelog

Notable user-visible changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, minor releases may
contain intentional API changes described in their release notes.

## [Unreleased]

### Added

- Publishable ESM builds and declarations for the core, React, UI, and schema
  codegen packages.
- A working `query-table-codegen` CLI and programmatic generation API.
- Package-level documentation, release verification, CI, Dependabot, security
  policy, contribution guidance, and community standards.
- Runtime query normalization and matching TypeScript/Go resource limits.
- Safe-protocol enforcement for the generic link renderer.

### Changed

- URL synchronization and durable browser storage are now explicit opt-ins.
- Package manifests use the initial `0.1.0` version and public scoped-publishing
  metadata.

### Security

- Updated the JavaScript toolchain to remove known dependency advisories.
- Added Git-history secret scanning and Go/npm vulnerability checks to CI.

[Unreleased]: https://github.com/Pythia-Software/query-table/compare/main...HEAD
