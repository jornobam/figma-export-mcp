import type {
  LayoutInfo,
  Match,
  NormalizedNode,
  Selector,
  Snapshot,
  StringMatcher,
} from "../domain/types.js";
import { appError } from "../errors.js";
import { normalizeText } from "../util.js";
import { analyzeGeometry } from "./geometry.js";

const UNSAFE_REGEX = /(\([^)]*[+*][^)]*\))[+*{]|(\.\*){2,}|(\.\+){2,}|\\[1-9]|\(\?<([=!])/u;

export function safeRegex(pattern: string, flags = "iu"): RegExp {
  if (pattern.length > 500 || UNSAFE_REGEX.test(pattern)) {
    throw appError(
      "UNSAFE_REGEX",
      "selection",
      "Regular expression is too complex or potentially unsafe",
    );
  }
  try {
    return new RegExp(pattern, flags.replaceAll("g", ""));
  } catch {
    throw appError("INVALID_REGEX", "selection", "Regular expression is invalid");
  }
}

function matchesString(value: string | undefined, matcher: StringMatcher): boolean {
  if (value === undefined) return false;
  const normalized = normalizeText(value);
  const caseSensitive = matcher.caseSensitive ?? false;
  const compared = caseSensitive ? normalized : normalized.toLocaleLowerCase("und");
  if (matcher.exact !== undefined) {
    const expected = caseSensitive ? matcher.exact : matcher.exact.toLocaleLowerCase("und");
    return value === expected;
  }
  if (matcher.normalizedExact !== undefined) {
    const expected = normalizeText(matcher.normalizedExact);
    return compared === (caseSensitive ? expected : expected.toLocaleLowerCase("und"));
  }
  if (matcher.contains !== undefined) {
    const expected = normalizeText(matcher.contains);
    return compared.includes(caseSensitive ? expected : expected.toLocaleLowerCase("und"));
  }
  if (matcher.oneOf) {
    return matcher.oneOf.some(
      (item) =>
        compared ===
        (caseSensitive ? normalizeText(item) : normalizeText(item).toLocaleLowerCase("und")),
    );
  }
  if (matcher.regex !== undefined)
    return safeRegex(matcher.regex, matcher.flags).test(value.slice(0, 50_000));
  return false;
}

function matchesIndex(actual: number | undefined, expected: number | number[]): boolean {
  if (actual === undefined) return false;
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

function inRange(actual: number | undefined, range: { min?: number; max?: number }): boolean {
  return (
    actual !== undefined &&
    (range.min === undefined || actual >= range.min) &&
    (range.max === undefined || actual <= range.max)
  );
}

function evaluate(
  node: NormalizedNode,
  selector: Selector,
  layout: LayoutInfo,
  reasons: string[],
): boolean {
  if (selector.excludeIds?.includes(node.id)) return false;
  const manualInclude = selector.includeIds?.includes(node.id) ?? false;
  const checks: Array<[boolean, string]> = [];
  if (selector.id !== undefined)
    checks.push([
      Array.isArray(selector.id) ? selector.id.includes(node.id) : selector.id === node.id,
      "id",
    ]);
  if (selector.type) checks.push([selector.type.in.includes(node.type), "type"]);
  if (selector.name) checks.push([matchesString(node.name, selector.name), "name"]);
  if (selector.text) checks.push([matchesString(node.text, selector.text), "text"]);
  if (selector.descendantText)
    checks.push([
      matchesString(node.descendantTexts.join("\n"), selector.descendantText),
      "descendantText",
    ]);
  if (selector.page) checks.push([matchesString(node.page, selector.page), "page"]);
  if (selector.section) checks.push([matchesString(node.section, selector.section), "section"]);
  if (selector.hierarchyPath)
    checks.push([
      matchesString(node.hierarchyPath.join("/"), selector.hierarchyPath),
      "hierarchyPath",
    ]);
  if (selector.componentName)
    checks.push([matchesString(node.componentName, selector.componentName), "componentName"]);
  if (selector.componentProperties) {
    checks.push([
      Object.entries(selector.componentProperties).every(([key, matcher]) =>
        matchesString(node.componentProperties[key], matcher),
      ),
      "componentProperties",
    ]);
  }
  if (selector.visible !== undefined) checks.push([node.visible === selector.visible, "visible"]);
  if (selector.width) checks.push([inRange(node.bounds?.width, selector.width), "width"]);
  if (selector.height) checks.push([inRange(node.bounds?.height, selector.height), "height"]);
  if (selector.aspectRatio) {
    const ratio =
      node.bounds && node.bounds.height > 0 ? node.bounds.width / node.bounds.height : undefined;
    checks.push([inRange(ratio, selector.aspectRatio), "aspectRatio"]);
  }
  if (selector.rowIndex !== undefined)
    checks.push([matchesIndex(layout.rowIndex, selector.rowIndex), "rowIndex"]);
  if (selector.columnIndex !== undefined)
    checks.push([matchesIndex(layout.columnIndex, selector.columnIndex), "columnIndex"]);
  if (selector.blockIndex !== undefined)
    checks.push([matchesIndex(layout.blockIndex, selector.blockIndex), "blockIndex"]);
  if (selector.siblingIndex !== undefined)
    checks.push([matchesIndex(node.siblingIndex, selector.siblingIndex), "siblingIndex"]);
  if (selector.all)
    checks.push([selector.all.every((part) => evaluate(node, part, layout, [])), "all"]);
  if (selector.any)
    checks.push([selector.any.some((part) => evaluate(node, part, layout, [])), "any"]);
  if (selector.not) checks.push([!evaluate(node, selector.not, layout, []), "not"]);
  const passed = checks.every(([result]) => result);
  if (passed) reasons.push(...checks.filter(([result]) => result).map(([, reason]) => reason));
  if (manualInclude) reasons.push("manual include");
  return manualInclude || passed;
}

function selectExportTarget(
  snapshot: Snapshot,
  matched: NormalizedNode,
  target: {
    mode: string;
    where?: Selector;
    maxDepth?: number;
    depth?: number;
    idMap?: Record<string, string>;
  },
  layout: Map<string, LayoutInfo>,
): { node: NormalizedNode; confidence: number; explanation?: string } | undefined {
  if (target.mode === "self") return { node: matched, confidence: 1 };
  if (target.mode === "explicitIdMap") {
    const mapped = target.idMap?.[matched.id];
    return mapped && snapshot.nodes[mapped]
      ? { node: snapshot.nodes[mapped], confidence: 1 }
      : undefined;
  }
  let current = matched.parentId ? snapshot.nodes[matched.parentId] : undefined;
  if (target.mode === "parent") return current ? { node: current, confidence: 1 } : undefined;
  const desiredDepth = target.mode === "ancestorAtDepth" ? (target.depth ?? 1) : undefined;
  for (let depth = 1; current && depth <= (target.maxDepth ?? 8); depth += 1) {
    if (desiredDepth === depth) return { node: current, confidence: 1 };
    const reasons: string[] = [];
    if (!target.where || evaluate(current, target.where, layout.get(current.id) ?? {}, reasons)) {
      const typeConfidence = ["FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION"].includes(
        current.type,
      )
        ? 0.95
        : 0.75;
      return {
        node: current,
        confidence: typeConfidence,
        explanation: `nearest ancestor at depth ${depth}`,
      };
    }
    current = current.parentId ? snapshot.nodes[current.parentId] : undefined;
  }
  return undefined;
}

export function querySnapshot(
  snapshot: Snapshot,
  selector: Selector,
  options: {
    toleranceFactor?: number;
    global?: boolean;
    exportTarget?: {
      mode: string;
      where?: Selector;
      maxDepth?: number;
      depth?: number;
      idMap?: Record<string, string>;
    };
  } = {},
): { matches: Match[]; warnings: string[]; layout: ReturnType<typeof analyzeGeometry> } {
  const candidates = Object.values(snapshot.nodes).filter(
    (node) => node.type !== "DOCUMENT" && node.type !== "CANVAS",
  );
  const geometry = analyzeGeometry(candidates, {
    toleranceFactor: options.toleranceFactor,
    global: options.global,
  });
  const matches: Match[] = [];
  const target = options.exportTarget ?? { mode: "self" };
  const seen = new Set<string>();
  for (const node of candidates) {
    const reasons: string[] = [];
    const layout = geometry.layout.get(node.id) ?? {};
    if (!evaluate(node, selector, layout, reasons)) continue;
    const selectedTarget = selectExportTarget(snapshot, node, target, geometry.layout);
    if (!selectedTarget) continue;
    if (seen.has(selectedTarget.node.id)) continue;
    seen.add(selectedTarget.node.id);
    matches.push({
      node,
      exportNode: selectedTarget.node,
      reasons: [...reasons, ...(selectedTarget.explanation ? [selectedTarget.explanation] : [])],
      variables: {},
      layout: geometry.layout.get(selectedTarget.node.id) ?? layout,
      confidence: selectedTarget.confidence,
    });
  }
  return { matches, warnings: geometry.warnings, layout: geometry };
}

export { matchesString };
