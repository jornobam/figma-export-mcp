# Installation

1. Install Node.js 20 or newer.
2. In the project directory run `npm ci && npm run build`.
3. Copy `.env.example` to a secret manager or client `env` block; never commit tokens.
4. Point the MCP client at `node dist/stdio.js` (example: `examples/codex-mcp.json`).

The server is cross-platform and uses platform state directories automatically. It communicates exclusively over MCP STDIO; stdout is reserved for protocol messages and diagnostics go to stderr.

Figma accepts a personal access token or OAuth bearer token with `file_content:read`. Yandex Disk uses an OAuth token. Public links are never created.

`check_connections` does not call Figma's user-profile endpoint. It reports a configured token as
pending network verification; `inspect_figma_file` performs that verification with the
`file_content:read` scope when a file key is available.

ZIP modes use streaming ZIP64 creation and streaming Yandex upload. Peak memory does not scale with
the total archive size, while `FIGMA_EXPORT_MAX_TEMP_BYTES` remains a hard disk-usage guard.
