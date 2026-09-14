# Модель export plan

Разработчик должен реализовать версионированную JSON Schema и валидировать ею все планы. YAML может использоваться только в тестах/fixtures; агент работает через MCP tools.

## Верхний уровень

```yaml
schemaVersion: 1
source: {}
scope: {}
selection: {}
export: {}
ordering: {}
variables: {}
naming: {}
grouping: {}
packaging: {}
destination: {}
collisionPolicy: error
expected: {}
```

## Source и scope

```yaml
source:
  fileKey: abc123
  version: "456"
  snapshotId: snap_01
scope:
  pageNames: ["Карточки"]
  nodeIds: []
```

Confirmed plan всегда привязан к конкретной версии файла. Если версия изменилась, требуется новый preview и подтверждение.

## Selection

Selector является рекурсивным выражением:

```yaml
selection:
  all:
    - type: { in: [FRAME, GROUP, COMPONENT, INSTANCE] }
    - visible: true
    - descendantText: { regex: "RAL\\s*(6021|6027|7047)", flags: "iu" }
    - any:
        - name: { contains: "обложка", caseSensitive: false }
        - position: { columnInRow: 1 }
    - not:
        name: { regex: "черновик|архив", flags: "iu" }
```

Поддержать predicates:

- `id`, `type`, `name`, `text`, `descendantText`;
- `page`, `section`, `hierarchyPath`;
- `componentName`, `componentProperties`;
- `visible`;
- width/height/aspect-ratio ranges;
- row/column/block indexes;
- sibling index;
- manual `includeIds` и `excludeIds`;
- `all`, `any`, `not`.

Строковые операции: exact, contains, normalized exact, regex, список allowed values. Regex обязан иметь защиту от ReDoS.

## Export target

Совпадение может находиться на текстовом узле, а экспортироваться должна карточка:

```yaml
exportTarget:
  mode: nearestAncestor
  where:
    type: { in: [FRAME, GROUP, COMPONENT, INSTANCE] }
    dimensionsSimilarToPeers: true
  maxDepth: 8
```

Другие режимы: `self`, `parent`, `nearestAncestor`, `ancestorAtDepth`, `explicitIdMap`.

## Position selection

После формирования candidate set:

```yaml
positionSelection:
  layout: rows
  rows: all
  columns: [1, 3, 8]
  indexBase: 1
```

Также: first, last, range, everyNth, explicitIndexes, perGroupLimit. Неодинаковая длина строк должна попадать в warnings.

## Ordering

```yaml
ordering:
  mode: row-major
  rowDirection: top-to-bottom
  itemDirection: left-to-right
  tieBreakers: [hierarchyPath, nodeId]
```

Режимы: hierarchy, row-major, column-major, position, extractedVariable, custom node ID list.

## Variables

Переменные извлекаются из текста, имён, пути, regex capture groups или геометрии:

```yaml
variables:
  ral:
    from: descendantText
    regex: "RAL\\s*(?<value>\\d{4})"
    required: true
  package:
    from: descendantText
    regex: "(?<value>\\d+(?:[.,]\\d+)?)\\s*(?:л|L)"
    normalize:
      decimalSeparator: "."
  index:
    from: sequence
    scope: group
    start: 1
    pad: 2
```

Разработчик должен поддержать явные lookup maps для бизнес-названий.

## Naming и grouping

```yaml
grouping:
  folders: ["RAL {ral}", "{product}", "{aroma}"]
naming:
  template: "{index}_{title}.{ext}"
  unicode: preserve
  whitespace: collapse
  maxSegmentLength: 120
```

До выполнения вычисляется каждый конечный путь и выявляются коллизии.

## Export

```yaml
export:
  format: png
  scale: 1
  contentsOnly: true
  useAbsoluteBounds: false
```

Валидация должна соответствовать актуальным ограничениям Figma API.

## Destination и packaging

```yaml
destination:
  provider: yandex-disk
  root: "/AI Exports"
  jobFolder: "WABE 2026-09-14"
packaging:
  mode: folders
  archiveGroupsBy: []
collisionPolicy: error
```

Packaging modes: folders, singleZip, zipPerGroup, filesAndZip. Публикация ссылок — отдельный явный флаг, default false.

## Expected

```yaml
expected:
  exactCount: 448
  requiredValues:
    ral: ["6021", "6027", "7047"]
  failOnMissingRequiredValue: true
```

Несовпадение expected constraints блокирует confirmation либо требует явного override с предупреждением.
