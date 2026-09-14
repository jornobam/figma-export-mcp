#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(dirname -- "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI не найден в PATH." >&2
  exit 1
fi

if [ ! -f TASK.md ] || [ ! -f AGENTS.md ]; then
  echo "Запускайте скрипт из полного распакованного пакета задания." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -q
fi

echo "Запускаю автономную разработку в sandbox workspace-write..." >&2
codex exec --sandbox workspace-write - < TASK.md
