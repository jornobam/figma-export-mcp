# Критерии приёмки

Все обязательные пункты должны быть подтверждены тестом, демонстрацией или документированным ограничением официального API.

## MCP

- [ ] Сервер запускается по STDIO на Node.js 20+.
- [ ] MCP initialization возвращает корректные server instructions.
- [ ] Все tools имеют JSON schemas и structured output.
- [ ] Большие manifests доступны с пагинацией/resource, а не одним гигантским ответом.
- [ ] Технический launcher не предоставляет пользовательский CLI с отдельной логикой.

## Диалоговый барьер

- [ ] Нельзя выполнить draft plan.
- [ ] Нельзя подтвердить plan с unresolved clarifications.
- [ ] Preview содержит count, order, naming, destination и warnings.
- [ ] Изменение plan меняет digest и инвалидирует confirmation.
- [ ] Изменение Figma version после preview безопасно обнаруживается.

## Figma

- [ ] URL файла и URL узла корректно разбираются.
- [ ] Snapshot кешируется по версии.
- [ ] Поддерживаются фильтры имени, текста, descendant text, type, path, visibility и dimensions.
- [ ] Поддерживаются logical selectors и manual include/exclude.
- [ ] Определяются строки/колонки с адаптивным tolerance.
- [ ] Поддерживается выбор нескольких позиций из каждой строки.
- [ ] Поддерживается выбор nearest exportable ancestor.
- [ ] Пакетный image render работает для PNG 1x.
- [ ] Null render URL становится явной item error.
- [ ] 429 учитывает `Retry-After`, 5xx использует bounded backoff.
- [ ] Figma никогда не изменяется.

## Имена и порядок

- [ ] Работают Unicode/кириллица.
- [ ] Имена безопасны на Linux, macOS и Windows.
- [ ] Row-major и column-major порядок детерминирован.
- [ ] Regex capture и lookup map создают variables.
- [ ] Конфликты обнаруживаются до запуска.
- [ ] Неодинаковые строки и missing required values видны в preview.

## Яндекс Диск

- [ ] Вложенные каталоги создаются идемпотентно.
- [ ] Файлы загружаются с ограниченной параллельностью.
- [ ] После неоднозначного timeout выполняется проверка remote state.
- [ ] Verified item не загружается повторно при resume.
- [ ] Проверяется remote path и размер, checksum — когда доступна.
- [ ] Публичная ссылка не создаётся без запроса.
- [ ] Локальный файл не удаляется до remote verification.
- [ ] Partial job сохраняет данные для восстановления.

## Устойчивость

- [ ] Job продолжается после перезапуска MCP-процесса.
- [ ] Повтор `execute_export_plan` с тем же idempotency key не создаёт второй job.
- [ ] Retry затрагивает только failed/retryable items.
- [ ] Отчёт различает planned/rendered/downloaded/uploaded/verified/failed.
- [ ] В логах и ошибках отсутствуют токены и signed URLs.

## Кроссплатформенность

- [ ] CI проверяет Linux, macOS и Windows.
- [ ] Пути не строятся ручной конкатенацией separators.
- [ ] Temp и application state directories выбираются кроссплатформенно.
- [ ] Инструкции подключения MCP подготовлены для трёх ОС.

## Обязательные end-to-end сценарии

- [ ] Обложка из каждой строки с группировкой по RAL.
- [ ] Колонки 1, 3 и 8 из строк неодинаковой длины.
- [ ] Несколько элементов на строку с пользовательским порядком.
- [ ] Переименование по regex и группировка по двум извлечённым переменным.
- [ ] Один отсутствующий ожидаемый цвет блокирует подтверждение или требует явного override.
- [ ] Частичная ошибка Яндекс Диска успешно продолжается без дубликатов.

## Definition of done

- [ ] Typecheck, lint и tests проходят.
- [ ] MCP Inspector smoke test проходит.
- [ ] README содержит установку, конфигурацию и troubleshooting.
- [ ] Есть `.env.example`, но нет секретов.
- [ ] Есть пример конфигурации Codex MCP для STDIO.
- [ ] Создан release artifact или документирован воспроизводимый build.
