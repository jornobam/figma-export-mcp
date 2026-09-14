export type Bounds = { x: number; y: number; width: number; height: number };

export type NormalizedNode = {
  id: string;
  type: string;
  name: string;
  text?: string;
  parentId?: string;
  childIds: string[];
  hierarchyPath: string[];
  page?: string;
  section?: string;
  visible: boolean;
  bounds?: Bounds;
  descendantTexts: string[];
  componentName?: string;
  componentProperties: Record<string, string>;
  siblingIndex: number;
};

export type Snapshot = {
  schemaVersion: 1;
  id: string;
  fileKey: string;
  fileName: string;
  version: string;
  sourceNodeId?: string;
  createdAt: string;
  expiresAt: string;
  nodes: Record<string, NormalizedNode>;
  rootIds: string[];
};

export type StringMatcher = {
  exact?: string;
  contains?: string;
  normalizedExact?: string;
  regex?: string;
  flags?: string;
  oneOf?: string[];
  caseSensitive?: boolean;
};

export type NumberRange = { min?: number; max?: number };

export type Selector = {
  id?: string | string[];
  type?: { in: string[] };
  name?: StringMatcher;
  text?: StringMatcher;
  descendantText?: StringMatcher;
  page?: StringMatcher;
  section?: StringMatcher;
  hierarchyPath?: StringMatcher;
  componentName?: StringMatcher;
  componentProperties?: Record<string, StringMatcher>;
  visible?: boolean;
  width?: NumberRange;
  height?: NumberRange;
  aspectRatio?: NumberRange;
  rowIndex?: number | number[];
  columnIndex?: number | number[];
  blockIndex?: number | number[];
  siblingIndex?: number | number[];
  includeIds?: string[];
  excludeIds?: string[];
  dimensionsSimilarToPeers?: boolean;
  all?: Selector[];
  any?: Selector[];
  not?: Selector;
};

export type LayoutInfo = {
  rowIndex?: number;
  columnIndex?: number;
  blockIndex?: number;
  groupKey?: string;
  dimensionsSimilarToPeers?: boolean;
};

export type Match = {
  node: NormalizedNode;
  exportNode: NormalizedNode;
  reasons: string[];
  variables: Record<string, string>;
  layout: LayoutInfo;
  confidence: number;
};

export type Clarification = {
  code: string;
  message: string;
  blocking: boolean;
  affectedCount?: number;
  options?: string[];
};

export type ManifestItem = {
  id: string;
  ordinal: number;
  nodeId: string;
  matchedNodeId: string;
  hierarchyPath: string[];
  rowIndex?: number;
  columnIndex?: number;
  variables: Record<string, string>;
  remotePath: string;
  reasons: string[];
  confidence: number;
};

export type ExportPlanStatus =
  | "draft"
  | "confirmed"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export type ExportPlan = {
  schemaVersion: 1;
  id: string;
  digest: string;
  status: ExportPlanStatus;
  createdAt: string;
  snapshotId: string;
  source: { fileKey: string; version: string };
  input: Record<string, unknown>;
  manifest: ManifestItem[];
  warnings: string[];
  clarifications: Clarification[];
  collisions: Array<{ path: string; itemIds: string[] }>;
  confirmedAt?: string;
  confirmationSummary?: string;
};

export type ItemStage =
  | "planned"
  | "rendering"
  | "rendered"
  | "downloaded"
  | "transformed"
  | "uploaded"
  | "verified"
  | "cleaned"
  | "failed";

export type SafeError = {
  code: string;
  stage: string;
  retryable: boolean;
  safeMessage: string;
  retryAfterSeconds?: number;
  itemId?: string;
  details?: Record<string, string | number | boolean | null>;
};

export type JobItem = ManifestItem & {
  kind?: "source" | "archive";
  archiveSourceItemIds?: string[];
  stage: ItemStage;
  attempts: number;
  localRelativePath?: string;
  localSize?: number;
  localSha256?: string;
  renderUrl?: string;
  uploadAttempted?: boolean;
  error?: SafeError;
  verifiedAt?: string;
};

export type JobEvent = {
  sequence: number;
  at: string;
  stage: string;
  message: string;
  itemId?: string;
};

export type ExportJob = {
  schemaVersion: 1;
  id: string;
  planId: string;
  planDigest: string;
  idempotencyKey: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  createdAt: string;
  updatedAt: string;
  workspaceName: string;
  items: JobItem[];
  events: JobEvent[];
  cleanupComplete: boolean;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
