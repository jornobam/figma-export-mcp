# Сценарий: извлечение значений и переименование

## Запрос

> Возьми все карточки, где есть фасовка 0,9 л или 2,5 л. Сгруппируй сначала по коду цвета, затем по фасовке. Название файла: код, аромат и номер карточки. Кириллицу сохрани.

## Возможный plan

```yaml
selection:
  all:
    - descendantText: { regex: "(?:0[.,]9|2[.,]5)\\s*л", flags: "iu" }
variables:
  color:
    from: descendantText
    regex: "RAL\\s*(?<value>\\d{4})"
    required: true
  package:
    from: descendantText
    regex: "(?<value>0[.,]9|2[.,]5)\\s*л"
    normalize: { decimalSeparator: "." }
  aroma:
    from: descendantText
    regex: "Аромат\\s+(?<value>[^\\n]+)"
    required: true
grouping:
  folders: ["RAL {color}", "{package} л"]
naming:
  template: "{color}_{aroma}_{index}.png"
```

## Уточнения

- Если на карточке несколько кодов/фасовок, нельзя брать первое совпадение без правила.
- Если аромат отсутствует, показать affected count и спросить о fallback.
- Нормализация `0,9` в `0.9` для папки должна быть видна в preview.
- Кириллица сохраняется, но запрещённые для Windows символы очищаются одинаково на всех ОС.
