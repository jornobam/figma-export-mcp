# Roadmap разработки

## Этап 0 — проверка контрактов

- Проверить актуальные MCP SDK и API.
- Создать `docs/DECISIONS.md`.
- Зафиксировать tool schemas, error model и versioning.
- Настроить TypeScript, tests, lint, CI matrix.

Критерий: server запускается, проходит initialize/list tools, но бизнес-инструменты могут быть минимальными.

## Этап 1 — вертикальный MVP

- Figma URL parser и client.
- Snapshot нормализация.
- Базовые selectors name/text/type/id.
- Draft plan, preview, digest, confirm.
- PNG 1x batch export.
- Яндекс upload + metadata verification.
- Cleanup после проверки.
- Persistent job state.

Критерий: один небольшой end-to-end fixture проходит полностью.

## Этап 2 — универсальная выборка

- Descendant text и hierarchy selectors.
- Nearest exportable ancestor.
- Geometry rows/columns.
- Position selectors.
- Variables, lookup maps, templates.
- Collision detection.

Критерий: проходят четыре сценария из `examples/`.

## Этап 3 — массовость и восстановление

- Адаптивные batches.
- Rate limiting, Retry-After, bounded concurrency.
- Resume после рестарта.
- Проверка неоднозначных upload outcomes.
- ZIP modes.
- Manifest resources/pagination.

Критерий: synthetic job на 1 000 элементов проходит без дубликатов и без чрезмерного MCP output.

## Этап 4 — эксплуатационная готовность

- Cross-platform packaging.
- CI Linux/macOS/Windows.
- Secret redaction и security tests.
- Doctor/check_connections.
- Установка и конфигурация для Codex и других MCP clients.
- Troubleshooting и release notes.

Критерий: выполнен весь checklist `ACCEPTANCE_CRITERIA.md`.

## После V1

- Streamable HTTP transport.
- Несколько storage providers.
- OAuth onboarding UI.
- Optional visual contact sheet preview.
- Optional vision-assisted classification с обязательным подтверждением.
- Webhooks и плановые задания.

Эти пункты не должны задерживать полностью рабочий STDIO V1.
