# Figma Export MCP — пакет задания на разработку

Этот архив предназначен для передачи автономному Codex на Linux-сервере. Его задача — разработать production-ready MCP-сервер, который позволяет AI-агенту анализировать произвольно организованные Figma-файлы, согласовывать с пользователем правила отбора и именования, массово экспортировать изображения и загружать проверенный результат в один аккаунт Яндекс Диска.

## Важное разграничение

- Codex CLI используется только для разработки проекта.
- Конечный продукт — MCP-сервер, а не пользовательская CLI-утилита.
- Техническая команда запуска STDIO-процесса допустима и необходима для подключения MCP-клиента, но не считается пользовательским CLI.
- MCP не должен содержать логику, привязанную к одному макету, бренду, сетке или примеру WABE.

## Как передать задание Codex

1. Распакуйте архив в отдельный каталог на сервере.
2. Перейдите в этот каталог.
3. Убедитесь, что установлен и авторизован Codex CLI.
4. Запустите:

   ```bash
   chmod +x scripts/start-development.sh
   ./scripts/start-development.sh
   ```

Скрипт передаст `TASK.md` в `codex exec` и разрешит изменения только внутри рабочей директории. Codex должен прочитать `AGENTS.md` и остальные документы до начала реализации.

## Состав спецификации

- `TASK.md` — исполняемое задание автономному разработчику.
- `AGENTS.md` — постоянные правила разработки.
- `PRODUCT_SPEC.md` — продуктовые требования и пользовательский сценарий.
- `ARCHITECTURE.md` — рекомендуемая архитектура.
- `MCP_TOOLS.md` — контракты инструментов MCP.
- `AGENT_WORKFLOW.md` — обязательный диалоговый протокол.
- `EXPORT_PLAN_SCHEMA.md` — модель универсального плана экспорта.
- `FIGMA_SELECTION_RULES.md` — правила анализа дерева, строк и колонок.
- `YANDEX_DISK_WORKFLOW.md` — доставка и проверка файлов.
- `SECURITY.md` — работа с токенами, путями и внешними URL.
- `ACCEPTANCE_CRITERIA.md` — критерии готовности.
- `TESTING_STRATEGY.md` — необходимое покрытие тестами.
- `ROADMAP.md` — рекомендуемый порядок реализации.
- `examples/` — сценарии, на которых проверяется универсальность.

## Авторитетные источники

Перед реализацией разработчик должен повторно проверить актуальную документацию:

- OpenAI Docs — MCP и подключение серверов: https://learn.chatgpt.com/docs/extend/mcp
- Figma REST API — файлы и изображения: https://developers.figma.com/docs/rest-api/file-endpoints/
- Figma REST API — авторизация: https://developers.figma.com/docs/rest-api/authentication/
- Figma REST API — лимиты: https://developers.figma.com/docs/rest-api/rate-limits/
- Яндекс Диск REST API: https://yandex.ru/dev/disk-api/doc/ru/

Не копируйте токены в репозиторий, issue, отчёты Codex или сообщения чата.

## Реализация

В этом каталоге находится готовый универсальный STDIO MCP-сервер. Он работает на Node.js 20+, не изменяет Figma, сохраняет снимки/планы/состояние заданий атомарно и возобновляет частичные загрузки без повторной отправки проверенных файлов.

### Установка и запуск

```bash
npm ci
npm run check
npm run build
FIGMA_TOKEN=... YANDEX_DISK_TOKEN=... npm start
```

На Windows используйте `$env:FIGMA_TOKEN="..."; npm start`, на PowerShell; на macOS/Linux — `export FIGMA_TOKEN=...`. Полный перечень переменных находится в `.env.example`. По умолчанию состояние хранится в `%LOCALAPPDATA%/FigmaExportMCP/state`, `~/Library/Application Support/figma-export-mcp` или `$XDG_STATE_HOME/figma-export-mcp`.

### Подключение MCP-клиента

Готовый пример конфигурации Codex находится в `examples/codex-mcp.json`. Для Claude Desktop, Cursor и других клиентов используется тот же STDIO command: `node /absolute/path/dist/stdio.js`; секреты передаются только через `env`.

### Проверки и troubleshooting

`npm run check` выполняет typecheck, lint, unit/integration tests, build и MCP smoke. `npm run mcp:inspect` проверяет MCP initialization, instructions, schemas и structured output без сети. Если Figma отвечает 429, клиент уважает `Retry-After`; 5xx повторяются с ограниченным backoff. Ошибка `PLAN_NOT_CONFIRMED` означает, что сначала нужно показать preview и подтвердить его digest. Ошибки сети Яндекс Диска безопасно возобновляются через `retry_failed_items`.

Для реальных read-only проверок предусмотрен opt-in скрипт `LIVE_SMOKE_CONFIRM=YES npm run live:smoke`; он не загружает и не удаляет данные.
