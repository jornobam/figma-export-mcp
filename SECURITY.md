# Безопасность

## Секреты

- `FIGMA_TOKEN` и `YANDEX_DISK_TOKEN` читаются из окружения или поддерживаемого secret store.
- `.env` разрешён только как локальный development convenience и обязан быть в `.gitignore`.
- `.env.example` содержит только имена переменных и фиктивные значения.
- Токены запрещено включать в exception, telemetry, test snapshots и structured MCP output.
- Заголовки `Authorization`, `X-Figma-Token`, signed query parameters и upload URLs редактируются в логах.

## Минимальные права

- Figma: только scope чтения содержимого файлов, необходимый для file/nodes/images endpoints.
- Яндекс Диск: минимальный набор прав, позволяющий работать в выбранном каталоге; точные scopes сверить с актуальной документацией.
- MCP никогда не изменяет Figma-файл.

## Сетевые границы

- Метаданные запрашиваются только у официальных API endpoints.
- URL изображения принимается только из ответа Figma API для текущего job.
- Перед скачиванием проверять HTTPS, запрещать localhost, link-local, private IP ranges и небезопасные redirect chains.
- Upload URL принимается только из ответа Яндекс Диск API и проходит аналогичную проверку.
- Установить connect/read/overall timeouts и максимальный размер ответа.

## Пути

- Ни один пользовательский сегмент не должен позволять `..`, абсолютный путь, drive prefix, NUL или separator injection.
- Учитывать зарезервированные имена Windows, trailing dots/spaces и case-insensitive collisions.
- Все remote paths должны оставаться под `YANDEX_DISK_ROOT`.
- Все local paths должны оставаться внутри job temp root.
- ZIP entries проверять на zip-slip.

## Подтверждение массовой операции

- `execute_export_plan` принимает только `confirmed` plan.
- Confirm требует совпадающего SHA-256 digest и отсутствия unresolved clarifications.
- Изменение selection, naming, ordering, destination, packaging, format, scale, collision policy или source version инвалидирует confirmation.
- MCP server instructions запрещают агенту подтверждать план без явного согласия пользователя.

## Ограничение ресурсов

- Максимальное число узлов, файлов, batch size, параллельность, размер файла и суммарный temp volume конфигурируются.
- При превышении лимита MCP возвращает preview warning и не начинает job.
- Regex выполняются с защитой от catastrophic backtracking.
- Большие JSON не возвращаются модели целиком.

## Supply chain

- Lockfile обязателен.
- Проверка зависимостей и лицензий должна быть частью CI.
- Release build воспроизводим и не выполняет неожиданных postinstall scripts.
- Не использовать заброшенные неофициальные SDK, если официальный HTTP API достаточно прост.
