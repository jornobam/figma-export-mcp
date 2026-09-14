import type { CreateExportPlanInput } from "../domain/schemas.js";
import type { Clarification, ExportPlan, Match, Snapshot } from "../domain/types.js";
import { appError } from "../errors.js";
import { querySnapshot, safeRegex } from "../selection/engine.js";
import {
  canonicalJson,
  ensureCaseInsensitiveUnique,
  joinRemotePath,
  makeId,
  sanitizeSegment,
  sha256,
} from "../util.js";

type VariableRule = CreateExportPlanInput["variables"][string];

function sourceFor(match: Match, from: VariableRule["from"]): string {
  switch (from) {
    case "name":
      return match.exportNode.name;
    case "text":
      return match.node.text ?? match.exportNode.text ?? "";
    case "descendantText":
      return match.exportNode.descendantTexts.join("\n");
    case "hierarchyPath":
      return match.exportNode.hierarchyPath.join("/");
    case "page":
      return match.exportNode.page ?? "";
    case "section":
      return match.exportNode.section ?? "";
    case "rowIndex":
      return match.layout.rowIndex ? String(match.layout.rowIndex) : "";
    case "columnIndex":
      return match.layout.columnIndex ? String(match.layout.columnIndex) : "";
    case "sequence":
      return "";
  }
}

function normalizeVariable(value: string, rule: VariableRule): string {
  let result = rule.normalize.trim ? value.trim() : value;
  if (rule.normalize.collapseWhitespace) result = result.replace(/\s+/gu, " ");
  if (rule.normalize.decimalSeparator)
    result = result.replace(/[.,]/gu, rule.normalize.decimalSeparator);
  if (rule.normalize.case === "lower") result = result.toLocaleLowerCase("und");
  if (rule.normalize.case === "upper") result = result.toLocaleUpperCase("und");
  return rule.lookup?.[result] ?? result;
}

function extractVariable(
  match: Match,
  rule: VariableRule,
): { value?: string; ambiguous?: string[] } {
  if (rule.from === "sequence") return {};
  const source = sourceFor(match, rule.from).slice(0, 50_000);
  if (!rule.regex) {
    const value = normalizeVariable(source, rule);
    return value ? { value } : {};
  }
  const expression = safeRegex(rule.regex, rule.flags);
  const global = new RegExp(
    expression.source,
    expression.flags.includes("g") ? expression.flags : `${expression.flags}g`,
  );
  const values: string[] = [];
  for (const result of source.matchAll(global)) {
    const captured = result.groups?.[rule.capture] ?? result[1] ?? result[0];
    if (captured !== undefined) values.push(normalizeVariable(captured, rule));
    if (result[0] === "") break;
  }
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length > 1) return { ambiguous: unique };
  return unique[0] ? { value: unique[0] } : {};
}

function selectedByPositions(
  matches: Match[],
  input: CreateExportPlanInput,
  warnings: string[],
  clarifications: Clarification[],
): Match[] {
  const selection = input.position_selection;
  if (!selection) return matches;
  const rows = new Map<number, Match[]>();
  for (const match of matches) {
    if (match.layout.rowIndex !== undefined)
      rows.set(match.layout.rowIndex, [...(rows.get(match.layout.rowIndex) ?? []), match]);
  }
  for (const row of rows.values()) {
    row.sort(
      (a, b) =>
        (a.layout.columnIndex ?? 0) - (b.layout.columnIndex ?? 0) ||
        a.exportNode.id.localeCompare(b.exportNode.id, "en"),
    );
  }
  const selected = new Map<string, Match>();
  const wantedRows = selection.rows === "all" ? [...rows.keys()] : selection.rows;
  const addIndexes = (rowNumber: number, positions: number[]) => {
    const row = rows.get(rowNumber) ?? [];
    for (const position of positions) {
      const match = row[position - 1];
      if (match) {
        selected.set(match.exportNode.id, match);
      } else if (selection.missingPositionPolicy === "clarify") {
        clarifications.push({
          code: "MISSING_ROW_POSITION",
          message: `Row ${rowNumber} has no position ${position}`,
          blocking: true,
          options: ["skip", "fail", "complete-rows-only"],
        });
      } else if (selection.missingPositionPolicy === "fail") {
        clarifications.push({
          code: "MISSING_ROW_POSITION",
          message: `Row ${rowNumber} has no position ${position}`,
          blocking: true,
        });
      } else {
        warnings.push(`Skipped missing position ${position} in row ${rowNumber}`);
      }
    }
  };
  for (const rowNumber of wantedRows) {
    const row = rows.get(rowNumber) ?? [];
    const positions = new Set<number>();
    for (const item of selection.columns ?? selection.explicitIndexes ?? []) positions.add(item);
    if (selection.first)
      for (let index = 1; index <= Math.min(selection.first, row.length); index += 1)
        positions.add(index);
    if (selection.last)
      for (
        let index = Math.max(1, row.length - selection.last + 1);
        index <= row.length;
        index += 1
      )
        positions.add(index);
    if (selection.range)
      for (let index = selection.range.from; index <= selection.range.to; index += 1)
        positions.add(index);
    if (selection.everyNth)
      for (let index = selection.everyNth; index <= row.length; index += selection.everyNth)
        positions.add(index);
    if (!positions.size) {
      for (let index = 0; index < row.length; index += 1) positions.add(index + 1);
    }
    if (
      selection.missingPositionPolicy === "complete-rows-only" &&
      [...positions].some((index) => index > row.length)
    ) {
      warnings.push(`Skipped incomplete row ${rowNumber}`);
      continue;
    }
    addIndexes(rowNumber, [...positions]);
  }
  if (selection.perGroupLimit) {
    const perGroupLimit = selection.perGroupLimit;
    return [...selected.values()].filter((_, index) => index < perGroupLimit * wantedRows.length);
  }
  return [...selected.values()];
}

function orderMatches(matches: Match[], input: CreateExportPlanInput): Match[] {
  const directionY = input.ordering.rowDirection === "top-to-bottom" ? 1 : -1;
  const directionX = input.ordering.itemDirection === "left-to-right" ? 1 : -1;
  const custom = new Map((input.ordering.customNodeIds ?? []).map((id, index) => [id, index]));
  return [...matches].sort((a, b) => {
    let result = 0;
    switch (input.ordering.mode) {
      case "row-major":
        result =
          ((a.layout.rowIndex ?? 0) - (b.layout.rowIndex ?? 0)) * directionY ||
          ((a.layout.columnIndex ?? 0) - (b.layout.columnIndex ?? 0)) * directionX;
        break;
      case "column-major":
        result =
          ((a.layout.columnIndex ?? 0) - (b.layout.columnIndex ?? 0)) * directionX ||
          ((a.layout.rowIndex ?? 0) - (b.layout.rowIndex ?? 0)) * directionY;
        break;
      case "custom":
        result =
          (custom.get(a.exportNode.id) ?? Number.MAX_SAFE_INTEGER) -
          (custom.get(b.exportNode.id) ?? Number.MAX_SAFE_INTEGER);
        break;
      case "extractedVariable":
        result = (input.ordering.variables ?? []).reduce(
          (current, key) =>
            current ||
            (a.variables[key] ?? "").localeCompare(b.variables[key] ?? "", "und", {
              numeric: true,
            }),
          0,
        );
        break;
      case "position": {
        const priority = new Map(
          (input.ordering.positionPriority ?? []).map((value, index) => [String(value), index]),
        );
        result =
          (priority.get(String(a.layout.columnIndex)) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(String(b.layout.columnIndex)) ?? Number.MAX_SAFE_INTEGER) ||
          (a.layout.rowIndex ?? 0) - (b.layout.rowIndex ?? 0);
        break;
      }
      case "hierarchy":
        break;
    }
    return (
      result ||
      a.exportNode.hierarchyPath
        .join("/")
        .localeCompare(b.exportNode.hierarchyPath.join("/"), "und", { numeric: true }) ||
      a.exportNode.id.localeCompare(b.exportNode.id, "en")
    );
  });
}

function renderTemplate(
  template: string,
  variables: Record<string, string>,
  missing: Set<string>,
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, key: string) => {
    const value = variables[key];
    if (value === undefined || value === "") {
      missing.add(key);
      return `_missing_${key}`;
    }
    return value;
  });
}

export function compileExportPlan(
  snapshot: Snapshot,
  input: CreateExportPlanInput,
  configuredRoot: string,
  maxItems: number,
): ExportPlan {
  const warnings: string[] = [];
  const clarifications: Clarification[] = [];
  const destinationRoot = joinRemotePath(configuredRoot);
  const requestedRoot = joinRemotePath(input.destination.root);
  if (requestedRoot !== destinationRoot && !requestedRoot.startsWith(`${destinationRoot}/`)) {
    throw appError(
      "DESTINATION_OUTSIDE_ROOT",
      "planning",
      "Destination root is outside YANDEX_DISK_ROOT",
    );
  }
  const queried = querySnapshot(snapshot, input.selection, { exportTarget: input.export_target });
  warnings.push(...queried.warnings);
  let matches = selectedByPositions(queried.matches, input, warnings, clarifications);
  for (const match of matches) {
    for (const [key, rule] of Object.entries(input.variables)) {
      const extracted = extractVariable(match, rule);
      if (extracted.value !== undefined) match.variables[key] = extracted.value;
      if (extracted.ambiguous) {
        clarifications.push({
          code: "AMBIGUOUS_VARIABLE",
          message: `Node ${match.exportNode.id} has multiple values for ${key}: ${extracted.ambiguous.join(", ")}`,
          blocking: true,
          affectedCount: 1,
        });
      } else if (rule.required && extracted.value === undefined && rule.from !== "sequence") {
        clarifications.push({
          code: "MISSING_REQUIRED_VARIABLE",
          message: `Node ${match.exportNode.id} is missing required variable ${key}`,
          blocking: true,
          affectedCount: 1,
        });
      }
    }
    if (match.confidence < 0.8) {
      clarifications.push({
        code: "LOW_CONFIDENCE_EXPORT_TARGET",
        message: `Export target for node ${match.node.id} has low confidence`,
        blocking: true,
        affectedCount: 1,
      });
    }
  }
  matches = orderMatches(matches, input);
  const sequenceCounters = new Map<string, number>();
  matches.forEach((match, index) => {
    for (const [key, rule] of Object.entries(input.variables)) {
      if (rule.from !== "sequence") continue;
      const scope =
        rule.scope === "row"
          ? `row:${match.layout.rowIndex ?? 0}`
          : rule.scope === "group"
            ? `group:${match.layout.groupKey ?? "root"}`
            : "global";
      const counterKey = `${key}:${scope}`;
      const next = sequenceCounters.get(counterKey) ?? rule.start;
      match.variables[key] = String(next).padStart(rule.pad, "0");
      sequenceCounters.set(counterKey, next + 1);
    }
    match.variables.index ??= String(index + 1).padStart(String(matches.length).length, "0");
    match.variables.ext = input.export.format;
  });
  if (matches.length > maxItems) {
    clarifications.push({
      code: "ITEM_LIMIT_EXCEEDED",
      message: `Plan has ${matches.length} items; configured limit is ${maxItems}`,
      blocking: true,
      affectedCount: matches.length,
    });
  }
  if (input.expected.exact_count !== null && matches.length !== input.expected.exact_count) {
    clarifications.push({
      code: "EXPECTED_COUNT_MISMATCH",
      message: `Expected ${input.expected.exact_count} items but selected ${matches.length}`,
      blocking: true,
      affectedCount: matches.length,
    });
  }
  for (const [key, required] of Object.entries(input.expected.required_values)) {
    const found = new Set(matches.map((match) => match.variables[key]).filter(Boolean));
    const missing = required.filter((value) => !found.has(value));
    if (missing.length) {
      const blocking =
        input.expected.fail_on_missing_required_value &&
        !input.expected.override_missing_required_values;
      const entry = {
        code: "MISSING_EXPECTED_VALUES",
        message: `Missing expected ${key}: ${missing.join(", ")}`,
        blocking,
        affectedCount: missing.length,
      } satisfies Clarification;
      if (blocking) clarifications.push(entry);
      else warnings.push(entry.message);
    }
  }
  const missingTemplateVariables = new Set<string>();
  const manifest = matches.map((match, index) => {
    const folders = input.grouping.folders.map((template) =>
      sanitizeSegment(
        renderTemplate(template, match.variables, missingTemplateVariables),
        input.naming.max_segment_length,
      ),
    );
    const filename = sanitizeSegment(
      renderTemplate(input.naming.template, match.variables, missingTemplateVariables),
      input.naming.max_segment_length,
    );
    const remotePath = joinRemotePath(
      requestedRoot,
      input.destination.job_folder,
      ...folders,
      filename,
    );
    return {
      id: makeId("item"),
      ordinal: index + 1,
      nodeId: match.exportNode.id,
      matchedNodeId: match.node.id,
      hierarchyPath: match.exportNode.hierarchyPath,
      ...(match.layout.rowIndex !== undefined ? { rowIndex: match.layout.rowIndex } : {}),
      ...(match.layout.columnIndex !== undefined ? { columnIndex: match.layout.columnIndex } : {}),
      variables: match.variables,
      remotePath,
      reasons: match.reasons,
      confidence: match.confidence,
    };
  });
  if (missingTemplateVariables.size) {
    clarifications.push({
      code: "MISSING_TEMPLATE_VARIABLES",
      message: `Naming templates reference missing variables: ${[...missingTemplateVariables].join(", ")}`,
      blocking: true,
    });
  }
  const collisionGroups = ensureCaseInsensitiveUnique(manifest.map((item) => item.remotePath));
  const collisions = collisionGroups.map(({ path: normalizedPath, indexes }) => ({
    path: manifest[indexes[0] ?? 0]?.remotePath ?? normalizedPath,
    itemIds: indexes.map((index) => manifest[index]?.id).filter((id): id is string => Boolean(id)),
  }));
  if (collisions.length) {
    clarifications.push({
      code: "PATH_COLLISIONS",
      message: `${collisions.length} case-insensitive path collision(s) must be resolved before export`,
      blocking: true,
      affectedCount: collisions.length,
    });
  }
  const planId = makeId("plan");
  const createdAt = new Date().toISOString();
  const digestPayload = {
    schemaVersion: 1 as const,
    snapshotId: snapshot.id,
    source: { fileKey: snapshot.fileKey, version: snapshot.version },
    input,
    manifest,
    warnings,
    clarifications,
    collisions,
  };
  return {
    ...digestPayload,
    id: planId,
    digest: sha256(canonicalJson(digestPayload)),
    status: "draft",
    createdAt,
    input: input as unknown as Record<string, unknown>,
  };
}

export function previewPlan(plan: ExportPlan, offset = 0, pageSize = 100): Record<string, unknown> {
  const page = plan.manifest.slice(offset, offset + pageSize);
  const input = plan.input as unknown as CreateExportPlanInput;
  return {
    schema_version: "1.0",
    plan_id: plan.id,
    digest: plan.digest,
    status: plan.status,
    source: plan.source,
    count: plan.manifest.length,
    order: input.ordering,
    naming: input.naming,
    grouping: input.grouping,
    destination: input.destination,
    export: input.export,
    packaging: input.packaging,
    collision_policy: input.collision_policy,
    warnings: plan.warnings,
    clarifications: plan.clarifications,
    collisions: plan.collisions,
    samples: plan.manifest.slice(0, 3),
    manifest: page,
    page: { offset, page_size: pageSize, returned: page.length, total: plan.manifest.length },
  };
}

export { extractVariable, normalizeVariable, orderMatches, selectedByPositions };
