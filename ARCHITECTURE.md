# Архитектура

## Общая схема

```text
AI-агент
   │ MCP (STDIO; HTTP-ready boundary)
   ▼
MCP server / tool handlers
   │
   ├── Workflow guard + confirmation policy
   ├── Snapshot service
   ├── Selection engine
   ├── Export plan compiler
   ├── Job orchestrator + persistent state
   ├── Naming/package pipeline
   └── Delivery verifier
           │                       │
           ▼                       ▼
     Figma REST API          Яндекс Диск REST API
```

## Модули

### Transport

Технический entrypoint запускает MCP по STDIO. Доменные сервисы не должны зависеть от STDIO, чтобы позже добавить Streamable HTTP без переписывания логики. Пользовательского CLI нет.

### FigmaClient

Отвечает только за официальный REST API:

- разбор и нормализацию URL;
- получение файла или выбранных nodes;
- версию и кеш;
- пакетный `GET /v1/images/:key?ids=...`;
- адаптивный размер batch;
- ограничение параллельности;
- обработку 429 через `Retry-After`;
- retry только для повторяемых ошибок;
- сохранение null-результатов рендера как явных failures.

HTTP-детали не должны проникать в selection engine.

### SnapshotStore

Преобразует ответ Figma в компактный нормализованный граф:

- node ID, type, name;
- parent/children и materialized hierarchy path;
- видимость;
- absolute bounds и размер;
- извлечённые descendant texts;
- component/instance metadata;
- sibling index и top-level page/section;
- file key, version, timestamp.

Сырые ответы могут храниться с ограниченным TTL. В контекст модели возвращаются только сводки и страницы результатов.

### SelectionEngine

Чистый детерминированный модуль без сети. Принимает snapshot и декларативный selector. Возвращает:

- совпавшие узлы;
- причины совпадения;
- confidence для эвристик;
- вычисленные строки/колонки;
- извлечённые переменные;
- предупреждения о неоднозначности.

Все правила должны быть тестируемы на fixtures.

### PlanCompiler

Создаёт immutable plan:

1. нормализует selectors;
2. вычисляет точный ordered manifest;
3. применяет `exportTarget`;
4. строит имена и пути;
5. проверяет конфликты;
6. вычисляет expected count/bytes estimate;
7. формирует clarifications;
8. сохраняет canonical JSON и SHA-256 digest.

После подтверждения изменение любого поля создаёт новый draft и новый digest.

### JobOrchestrator

Предпочтительно использовать SQLite с транзакциями и migrations; допустимо другое кроссплатформенное устойчивое хранилище при доказанной атомарности.

Минимальные сущности:

- snapshots;
- plans;
- jobs;
- export_items;
- upload_items;
- events.

Стадии item: `planned → rendering → downloaded → transformed → uploaded → verified → cleaned`, плюс `failed` с номером попытки.

### TempWorkspace

- Каталог создаётся через безопасный системный temp API.
- Пути строятся только из санитизированных сегментов.
- Запись выполняется атомарно через временное имя и rename.
- Cleanup выполняется item-by-item после remote verification либо целиком после полной проверки — выбранное решение должно исключать потерю единственной успешной копии.
- При partial/failed job workspace сохраняется и отображается в статусе без раскрытия лишних системных путей модели.

### YandexDiskClient

- Создаёт каталоги идемпотентно.
- Получает upload URL у API и передаёт поток/файл.
- Проверяет metadata после загрузки.
- Не публикует файлы автоматически.
- Нормализует удалённый путь независимо от локальной ОС.
- Хранит checkpoints и не загружает verified item повторно.

### Error model

Каждая ошибка содержит:

```json
{
  "code": "FIGMA_RATE_LIMITED",
  "stage": "rendering",
  "retryable": true,
  "retry_after_seconds": 60,
  "safe_message": "Figma временно ограничила запросы",
  "item_id": "optional"
}
```

Не возвращать access token, signed upload/download URL целиком, заголовки авторизации или сырой сетевой body, способный содержать секрет.

## Конфигурация

Минимальные переменные окружения:

```text
FIGMA_TOKEN
YANDEX_DISK_TOKEN
FIGMA_EXPORT_STATE_DIR
YANDEX_DISK_ROOT
LOG_LEVEL
```

Значения по умолчанию для директорий должны определяться через кроссплатформенный механизм application data, а не через жёсткие Unix-пути.

## Transport deployment

V1 поставляется как installable Node package с STDIO entrypoint. Один build должен запускаться на трёх ОС. Streamable HTTP допускается как дополнительный adapter после полного прохождения критериев V1; он не должен менять MCP tool schemas или семантику job.
