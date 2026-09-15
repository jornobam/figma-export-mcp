# Technical decisions

## 2026-09-14 — MCP SDK v2 and Node.js 20+

The package uses the official stable `@modelcontextprotocol/server` 2.0.0 line, which implements
the 2026-07-28 protocol and requires Node.js 20+. STDIO uses `serveStdio`; stdout is reserved for
JSON-RPC. Tools use Zod v4 input and output schemas and return `structuredContent`.

## 2026-09-14 — Atomic JSON state instead of a native database

The single-user V1 stores one JSON document per entity and atomically replaces it using a
same-directory temporary file plus `rename`. Per-process writes are serialized. This avoids native
SQLite binaries and keeps one npm artifact portable across Linux, macOS, and Windows. Jobs and
item checkpoints survive process restarts. A future multi-process transport must replace this store
with transactional SQLite or another multi-writer database; the domain repository boundary is
already isolated.

## 2026-09-14 — Immutable plans and content-addressed confirmation

Drafts contain canonical plan input plus a fully materialized manifest. A SHA-256 digest covers
every execution-relevant field, source version, warnings, clarifications, and manifest item. A plan
is never edited: changed inputs create a new plan ID and digest. Confirmation stores the digest.

## 2026-09-14 — Local download before Yandex upload

Rendered bytes are downloaded into a job workspace, hashed, atomically committed, then uploaded.
This permits size/checksum verification and deterministic resume. Signed Figma and Yandex upload
URLs are validated and never persisted or logged. A local item is deleted only after remote
verification; incomplete job workspaces are retained.

## 2026-09-14 — No automatic public links

V1 does not expose publication as a side effect. All uploaded objects remain private. Publication
can be added later as a separate explicitly confirmed tool.

## 2026-09-14 — Streaming ZIP64 without platform tools

Job archives are written directly to a mode-0600 temporary file with Yazl's ZIP64 stream and
atomically renamed when complete. Entries are validated against zip-slip, use fixed metadata for
reproducibility, and never coexist as one in-memory byte array. Archive bytes are hashed while they
are written and streamed from disk to Yandex Disk with upload-progress timeouts. The small exported
`createZip` helper remains only for bounded in-memory callers and unit fixtures. No operating-system
`zip` command or native binary is required on Linux, macOS, or Windows.

## 2026-09-14 — Layout indexes are local to visual blocks

Rows and columns are clustered within a common parent/section block. Their one-based indexes restart
for every block, and block numbering is isolated by hierarchy depth, so nested child nodes cannot
shift their parents' indexes. Position selection keys groups by both block identity and local index.

## 2026-09-14 — Minimal Figma OAuth scope

Connection readiness validates local token configuration without calling `/v1/me`. Network access
is proven by `inspect_figma_file`, which uses the file endpoint and therefore needs only
`file_content:read`; `current_user:read` is not required.

## Verified official API facts

- Figma file/image endpoints require `file_content:read`; image rendering supports PNG/JPG/SVG/PDF,
  scale 0.01–4, version pinning, multi-ID rendering, and explicit null URLs for failed nodes.
- Figma 429 handling honors `Retry-After`; transient 5xx retries use bounded exponential backoff.
- Yandex Disk uses `Authorization: OAuth …`, `cloud-api.yandex.net/v1/disk`, idempotent directory
  creation, a two-step upload-URL/PUT flow, and resource metadata containing path, size and hashes
  when available.
- The MCP SDK v2 stable line uses ESM, Node 20+, `McpServer.registerTool`, `serveStdio`, and resource
  registration. Server stdout is exclusively the protocol stream.
