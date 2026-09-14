# Installation

1. Install Node.js 20 or newer.
2. In the project directory run `npm ci && npm run build`.
3. Copy `.env.example` to a secret manager or client `env` block; never commit tokens.
4. Point the MCP client at `node dist/stdio.js` (example: `examples/codex-mcp.json`).

The server is cross-platform and uses platform state directories automatically. It communicates exclusively over MCP STDIO; stdout is reserved for protocol messages and diagnostics go to stderr.

Figma accepts a personal access token or OAuth bearer token with `file_content:read`. Yandex Disk uses an OAuth token. Public links are never created.
