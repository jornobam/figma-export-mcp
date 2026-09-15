# Контракты MCP-инструментов

Названия окончательные на уровне продукта, но разработчик может улучшить поля без изменения семантики. Все inputs и structured outputs обязаны иметь схемы и стабильный `schema_version`.

## Server instructions

Первые 512 символов должны быть самодостаточными и сообщать агенту главное:

> Before any bulk export, inspect the Figma file, create a draft export plan, resolve every material ambiguity with the user, preview the exact count/order/naming/destination, and obtain explicit user confirmation. Never call confirm_export_plan or execute_export_plan based on assumptions. Figma is read-only. Upload to Yandex Disk, verify every object, and delete temporary files only after verification. Resume partial jobs instead of duplicating files.

Полная версия дополняется правилами из `AGENT_WORKFLOW.md`, ограничениями API и описанием ошибок.

## `check_connections`

Проверяет конфигурацию без раскрытия секретов.

Вход:

```json
{}
```

Выход:

```json
{
  "figma": { "configured": true, "reachable": true, "identity_hint": "i***@example.com" },
  "yandex_disk": { "configured": true, "reachable": true, "root": "/AI Exports" },
  "state_store": { "writable": true },
  "warnings": []
}
```

## `inspect_figma_file`

Создаёт кешированный snapshot. Не возвращает полное дерево одним ответом.

Основные поля входа:

```json
{
  "figma_url": "https://www.figma.com/design/<key>/<name>?node-id=1-2",
  "scope": { "page_names": [], "node_ids": [] },
  "refresh": false
}
```

Выход: `snapshot_id`, `file_key`, `version`, страницы, число узлов, краткая статистика типов, доступные тексты/имена верхнего уровня, предупреждения и cursor для подробностей.

## `analyze_figma_layout`

Выявляет повторяющиеся размеры, строки, колонки, блоки и кандидаты на карточки/обложки. Эвристики не являются фактом.

Вход: `snapshot_id`, selector области, параметры tolerance и необязательные подсказки (`expected_columns`, `expected_items_per_row`).

Выход: найденные layout groups, representative node IDs, confidence, признаки группировки и объяснения.

## `query_nodes`

Применяет декларативные selectors без экспорта.

Вход:

```json
{
  "snapshot_id": "snap_...",
  "selector": {},
  "order": { "mode": "row-major" },
  "page_size": 100,
  "cursor": null
}
```

Выход содержит совпадения, извлечённые variables, row/column indexes, hierarchy path, match reasons и total count.

## `create_export_plan`

Компилирует immutable draft из точной выборки и правил назначения.

Вход:

```json
{
  "snapshot_id": "snap_...",
  "selection": {},
  "export": { "format": "png", "scale": 1 },
  "ordering": { "mode": "row-major" },
  "naming": { "template": "{ral}/{product}/{index}_{aroma}.png" },
  "destination": { "root": "/AI Exports", "job_folder": "WABE" },
  "packaging": { "mode": "folders" },
  "collision_policy": "error",
  "expected": { "count": null }
}
```

Выход: `plan_id`, `digest`, exact count, folder summary, filename samples, duplicates, missing variables, low-confidence decisions, `clarifications[]`, warnings.

Если есть существенные clarifications, план нельзя подтвердить.

## `preview_export_plan`

Возвращает стабильное резюме и страницы manifest без массового рендера. Пагинация охватывает
исходные изображения и все материализованные ZIP-архивы; каждая запись указывает `kind` и
`delivery`. Резюме отдельно показывает `source_count`, `archive_count`, `output_count` и
`archive_samples`. Пути архивов и состав ZIP входят в digest и проверку коллизий до подтверждения.

Выход должен позволять агенту сообщить:

- что именно выбрано;
- точное число файлов;
- порядок;
- структуру папок;
- примеры имён;
- формат/scale;
- конфликтную политику;
- путь Яндекс Диска;
- предупреждения и отсутствующие ожидаемые элементы.

## `confirm_export_plan`

Снимает программный барьер только после явного подтверждения пользователя в диалоге.

Вход:

```json
{
  "plan_id": "plan_...",
  "digest": "sha256:...",
  "confirmation_summary": "Пользователь подтвердил 448 PNG 1x, группировку RAL/product/aroma и путь /AI Exports/WABE"
}
```

Инструмент отклоняет plan с clarifications, конфликтами, изменившимся snapshot version или несовпавшим digest.

## `execute_export_plan`

Запускает подтверждённый plan. Должен быстро вернуть `job_id`; длительная работа выполняется с progress/events или фоновым job manager.

Вход: `plan_id`, `digest`, `idempotency_key`.

Повтор с тем же ключом возвращает тот же job. Повтор с другим ключом для уже выполняемого плана должен быть отклонён или явно связан с существующим job.

## `get_export_status`

Возвращает totals по стадиям, текущие retry delays, ошибки, `can_resume`, удалённые пути и cursor журнала. Никаких signed URLs или секретных заголовков.

## `retry_failed_items`

Повторяет только failed/retryable items. Не перерендеривает и не перезагружает verified items. Требует `job_id` и `idempotency_key`.

## `verify_yandex_upload`

Повторно сверяет удалённое состояние с manifest: наличие, размер и checksum, если API её предоставляет. Возвращает missing/mismatch/verified counts.

## `cleanup_job`

Удаляет локальные временные данные только для completed и полностью verified job. Для failed/partial job требует отдельного явного подтверждения пользователя; по умолчанию отказывает.

## MCP resources

Для крупных данных предпочтительно предоставить ресурсы:

```text
figma-export://snapshots/{snapshot_id}/summary
figma-export://plans/{plan_id}/manifest?page=...
figma-export://jobs/{job_id}/report
```

Ресурсы не должны раскрывать токены, signed URLs или произвольные локальные файлы.
