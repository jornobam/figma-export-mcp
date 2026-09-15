# Installation

1. Install Node.js 20 or newer.
2. In the project directory run `npm ci && npm run build`.
3. Copy `.env.example` to a secret manager or client `env` block; never commit tokens.
4. Point the MCP client at `node dist/stdio.js` (example: `examples/codex-mcp.json`).

The server is cross-platform and uses platform state directories automatically. It communicates exclusively over MCP STDIO; stdout is reserved for protocol messages and diagnostics go to stderr.

Figma accepts a personal/plan access token or an OAuth access token with `file_content:read`.
Choose one mode explicitly:

- PAT/plan access token: `FIGMA_AUTH_MODE=pat` (default) and `FIGMA_TOKEN=...`; requests use `X-Figma-Token`.
- OAuth: `FIGMA_AUTH_MODE=oauth` and `FIGMA_OAUTH_ACCESS_TOKEN=...`; requests use `Authorization: Bearer ...`.

The server consumes an OAuth access token obtained by your Figma OAuth app; it does not register an
OAuth app, perform the browser authorization flow, or refresh expired tokens. Rotate the token in
your secret manager and restart the STDIO process when needed. [Figma's OAuth documentation](https://developers.figma.com/docs/rest-api/oauth-apps/)
describes obtaining and refreshing access tokens. Yandex Disk uses its own OAuth token. Public
links are never created.

`check_connections` does not call Figma's user-profile endpoint. It reports a configured token as
pending network verification; `inspect_figma_file` performs that verification with the
`file_content:read` scope when a file key is available.

Preview pages include both source image entries and every planned archive (`kind`, `delivery`,
`archive_count`, `output_count`, and `archive_samples`). ZIP archives and their entry names are
materialized into the confirmed plan digest. Existing draft ZIP plans created by earlier builds
must be recreated and previewed before confirmation; an existing in-progress legacy ZIP job is
paused without deleting its local recovery files.

ZIP modes use streaming ZIP64 creation and streaming Yandex upload. Peak memory does not scale with
the total archive size, while `FIGMA_EXPORT_MAX_TEMP_BYTES` remains a hard disk-usage guard.
