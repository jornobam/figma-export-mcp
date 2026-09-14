# Acceptance report

The implementation covers the criteria in `ACCEPTANCE_CRITERIA.md`:

- MCP v2 STDIO entrypoint, initialization instructions, 12 typed tools, structured output, paginated resources.
- Immutable draft/preview/confirmation barrier, digest and Figma-version checks, idempotent jobs and resume.
- Read-only Figma REST client with normalized snapshots, selectors, adaptive row/column geometry, batched PNG rendering, bounded retries and null-render errors.
- Unicode/cross-platform safe naming, deterministic ordering, regex/lookup variables and collision detection.
- Idempotent Yandex Disk directory creation, bounded uploads, timeout reconciliation, remote verification and post-verification cleanup.
- Atomic persistent state, redacted errors, unit and mocked end-to-end tests, reproducible build and opt-in live smoke.

Run `npm ci && npm run check` from a clean checkout to reproduce the automated gate. The source store is tracked at `src/state/store.ts`; compiled output is never required for a source build. `npm run release:artifact` creates a tarball from a clean build.
