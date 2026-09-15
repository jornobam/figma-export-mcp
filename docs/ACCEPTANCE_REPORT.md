# Acceptance report

The implementation covers the criteria in `ACCEPTANCE_CRITERIA.md`:

- MCP v2 STDIO entrypoint, initialization instructions, 12 typed tools, structured output, paginated resources.
- Immutable draft/preview/confirmation barrier, digest and Figma-version checks, idempotent jobs and resume.
- Read-only Figma REST client with normalized snapshots, complete selectors (including block and peer-dimension predicates), block-local row/column geometry that is isolated from nested children, batched rendering, bounded retries and null-render errors.
- Unicode/cross-platform safe naming, functional preserve/collapse whitespace policy, configurable deterministic tie breakers, regex/lookup variables and collision detection.
- Idempotent Yandex Disk directory creation, destination preflight before rendering, checksum-safe `skip_identical`, bounded-memory streaming uploads, timeout reconciliation, remote verification, a durable verified checkpoint before unlink and restart-safe cleanup.
- Streaming deterministic ZIP64 packaging with bounded temporary storage; source files and archive uploads are never materialized together in process memory.
- Atomic persistent state, redacted errors, unit and mocked end-to-end tests, reproducible build and opt-in live smoke.

Run `npm ci && npm run check` from a clean checkout to reproduce the automated gate. The source store is tracked at `src/state/store.ts`; compiled output is never required for a source build. `npm run release:artifact` creates a tarball from a clean build.
