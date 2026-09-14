#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(dirname -- "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI не найден в PATH." >&2
  exit 1
fi

codex exec resume --last "Продолжай разработку до полного выполнения TASK.md и ACCEPTANCE_CRITERIA.md. Проверь текущие изменения и тесты; не останавливайся на промежуточном scaffold."
