# Стратегия тестирования

## Unit tests

### URL и нормализация

- Figma design/file URL, node-id с дефисом и двоеточием.
- Unicode normalization и пробелы.
- Безопасные пути для Linux/macOS/Windows.
- Зарезервированные Windows names и case collisions.

### Selection engine

- `all`, `any`, `not`.
- exact/contains/regex/lookup.
- descendant texts.
- include/exclude node IDs.
- nearest ancestor.
- extracted variables и missing required values.

### Геометрия

- ровная сетка;
- небольшой Y drift;
- разные размеры карточек;
- вложенные секции на одинаковой высоте;
- overlaps;
- пропущенные колонки;
- RTL/custom ordering как минимум корректно отклоняется, если не поддержан.

### Plan

- canonical serialization и стабильный digest.
- изменение любого существенного поля меняет digest.
- collisions до выполнения.
- confirmed plan immutable.

## Contract tests

Поднять локальные mock HTTP servers с зафиксированными контрактами:

### Figma mock

- get file/file nodes;
- get images с несколькими IDs;
- null URL для одного item;
- 403, 404, 429 + Retry-After, 500;
- версия файла изменилась.

### Yandex mock

- создание существующей/новой папки;
- получение upload URL;
- успешная загрузка;
- timeout после фактически успешной загрузки;
- metadata size/checksum mismatch;
- quota exceeded;
- временный 429/5xx;
- collision.

Контракты сверять с официальной документацией при обновлении зависимостей.

## MCP tests

- initialize/list tools.
- schema validation для каждого tool.
- server instructions содержат confirmation workflow.
- draft execution rejected.
- pagination/resources.
- стабильная сериализация ошибок.
- отсутствие секретов в stdout/stderr и snapshots.

## End-to-end fixture

Создать синтетический Figma-like fixture минимум из:

- 3 секций;
- 5 цветовых групп;
- 2 продуктовых типов;
- 7 строк разной структуры;
- 8 карточек в большинстве строк;
- одной неполной строки;
- одного скрытого draft;
- дублирующего имени;
- текстов на русском и английском.

Прогнать полный workflow до mock Яндекс Диска, остановить процесс после частичной загрузки и продолжить новым процессом.

## Live smoke tests

Отключены по умолчанию. Включаются владельцем отдельной переменной, используют маленький тестовый Figma-файл и выделенную папку Яндекс Диска. Не удаляют удалённые данные без отдельного флага.

## CI matrix

- Ubuntu latest.
- macOS latest.
- Windows latest.
- Node.js minimum supported и current LTS.

Минимальные команды проекта должны покрывать `lint`, `typecheck`, `test`, `test:integration`, `build`, `mcp:inspect`.
