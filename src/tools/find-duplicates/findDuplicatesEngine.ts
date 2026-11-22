export type DuplicateScanPhase =
  "walking" | "edge_hashing" | "full_hashing" | "completed" | "cancelled" | "error";

export interface DuplicateFileEntry {
  path: string;
  parentDir: string;
  fileName: string;
  byteLength: number;
  modifiedMs: number | null;
  createdMs: number | null;
  isHidden: boolean;
  hardlinkCount: number;
  fileIdKey: string | null;
}

export interface DuplicateGroup {
  groupId: string;
  sha256: string;
  byteLength: number;
  reclaimableBytes: number;
  files: DuplicateFileEntry[];
}

export interface DuplicateScanSkippedItem {
  path: string;
  reason: string;
}

export interface DuplicateHardlinkAlias {
  skippedPath: string;
  primaryPath: string;
}

export interface DuplicateScanProgressPayload {
  taskId: string;
  phase: DuplicateScanPhase;
  scannedFiles: number;
  candidateFiles: number;
  processedBytes: number;
  totalCandidateBytes: number | null;
  currentPath: string | null;
}

export interface DuplicateScanOptions {
  rootPaths: string[];
  minSizeBytes: number;
  includeHidden: boolean;
}

export interface DuplicateScanResult {
  taskId: string;
  effectiveRoots: string[];
  collapsedRedundantRoots: string[];
  scannedFileCount: number;
  totalDuplicateFiles: number;
  totalReclaimableBytes: number;
  groups: DuplicateGroup[];
  skippedItems: DuplicateScanSkippedItem[];
  skippedHardlinks: DuplicateHardlinkAlias[];
}

export type DuplicateSelectionPreset =
  "keep_newest" | "keep_oldest" | "keep_shortest_path" | "keep_in_folder";

export interface DuplicateVerifyTarget {
  path: string;
  expectedFileIdKey: string | null;
}

export interface RecycleGroupPlan {
  groupId: string;
  expectedSize: number;
  expectedSha256: string;
  removeTargets: DuplicateVerifyTarget[];
  keepTargets: DuplicateVerifyTarget[];
}

export interface RecycleItemOutcome {
  groupId: string;
  path: string;
  byteLength: number;
  status: "recycled" | "skipped" | "failed";
  reason: string | null;
}

export interface DuplicateRecycleResponse {
  recycledCount: number;
  recycledBytes: number;
  skippedCount: number;
  failedCount: number;
  outcomes: RecycleItemOutcome[];
}

export interface DuplicateSelectionSummary {
  selectedCount: number;
  selectedBytes: number;
  estimatedReclaimableBytes: number;
  affectedGroupCount: number;
  plans: RecycleGroupPlan[];
}

export function normalizeWindowsPathPrefix(folderPath: string): string {
  const trimmed = folderPath.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  return trimmed.toLowerCase();
}

export function isPathInsideFolder(filePath: string, folderPath: string): boolean {
  const normFolder = normalizeWindowsPathPrefix(folderPath);
  if (!normFolder) return false;
  const normFile = filePath.trim().replace(/\//g, "\\").toLowerCase();
  return normFile.startsWith(`${normFolder}\\`);
}

function compareNewestFirst(a: DuplicateFileEntry, b: DuplicateFileEntry): number {
  const ma = a.modifiedMs ?? -1;
  const mb = b.modifiedMs ?? -1;
  if (ma !== mb) return mb - ma;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.localeCompare(b.path);
}

function compareOldestFirst(a: DuplicateFileEntry, b: DuplicateFileEntry): number {
  const ma = a.modifiedMs ?? Number.MAX_SAFE_INTEGER;
  const mb = b.modifiedMs ?? Number.MAX_SAFE_INTEGER;
  if (ma !== mb) return ma - mb;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.localeCompare(b.path);
}

function compareShortestPathFirst(a: DuplicateFileEntry, b: DuplicateFileEntry): number {
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.localeCompare(b.path);
}

/**
 * Generates a new set of selected file paths to move to the Recycle Bin.
 * Strictly preserves at least 1 unselected copy in every duplicate group.
 */
export function computeDuplicateSelectionByPreset(
  groups: readonly DuplicateGroup[],
  preset: DuplicateSelectionPreset,
  options?: { preferredFolder?: string },
): Set<string> {
  const next = new Set<string>();

  for (const group of groups) {
    if (group.files.length < 2) continue;

    if (preset === "keep_in_folder") {
      const folder = options?.preferredFolder?.trim() ?? "";
      if (!folder) continue;
      const inFolder = group.files.filter((f) => isPathInsideFolder(f.path, folder));
      const outsideFolder = group.files.filter((f) => !isPathInsideFolder(f.path, folder));
      // Only select copies outside the protected folder when at least 1 copy exists inside it
      if (inFolder.length >= 1 && outsideFolder.length >= 1) {
        for (const extra of outsideFolder) {
          next.add(extra.path);
        }
      }
      continue;
    }

    const sorted = [...group.files];
    if (preset === "keep_newest") {
      sorted.sort(compareNewestFirst);
    } else if (preset === "keep_oldest") {
      sorted.sort(compareOldestFirst);
    } else {
      sorted.sort(compareShortestPathFirst);
    }

    // Index 0 is the kept copy; select indices 1..N-1
    for (let i = 1; i < sorted.length; i++) {
      next.add(sorted[i]!.path);
    }
  }

  return next;
}

/**
 * Toggles a single file path inside `group`, refusing to select the last remaining kept copy.
 */
export function toggleDuplicateItemSelection(
  group: DuplicateGroup,
  currentSelected: ReadonlySet<string>,
  targetPath: string,
): { nextSelected: Set<string>; blockedLastCopy: boolean } {
  const next = new Set(currentSelected);
  if (next.has(targetPath)) {
    next.delete(targetPath);
    return { nextSelected: next, blockedLastCopy: false };
  }

  const unselectedRemaining = group.files.filter(
    (f) => f.path !== targetPath && !next.has(f.path),
  ).length;
  if (unselectedRemaining < 1) {
    return { nextSelected: next, blockedLastCopy: true };
  }

  next.add(targetPath);
  return { nextSelected: next, blockedLastCopy: false };
}

export function isLastUnselectedInGroup(
  group: DuplicateGroup,
  selected: ReadonlySet<string>,
  candidatePath: string,
): boolean {
  if (selected.has(candidatePath)) return false;
  let unselectedCount = 0;
  for (const f of group.files) {
    if (!selected.has(f.path)) {
      unselectedCount += 1;
      if (unselectedCount > 1) return false;
    }
  }
  return unselectedCount === 1;
}

export function computeSelectionSummary(
  groups: readonly DuplicateGroup[],
  selected: ReadonlySet<string>,
): DuplicateSelectionSummary {
  let selectedCount = 0;
  let selectedBytes = 0;
  let estimatedReclaimableBytes = 0;
  let affectedGroupCount = 0;
  const plans: RecycleGroupPlan[] = [];

  for (const group of groups) {
    const removeFiles = group.files.filter((f) => selected.has(f.path));
    const keepFiles = group.files.filter((f) => !selected.has(f.path));
    if (removeFiles.length === 0) continue;
    // Safety belt: never build a plan that removes all copies in a group
    if (keepFiles.length === 0) continue;

    affectedGroupCount += 1;
    for (const rf of removeFiles) {
      selectedCount += 1;
      selectedBytes += rf.byteLength;
      if (rf.hardlinkCount <= 1) {
        estimatedReclaimableBytes += rf.byteLength;
      }
    }

    plans.push({
      groupId: group.groupId,
      expectedSize: group.byteLength,
      expectedSha256: group.sha256,
      removeTargets: removeFiles.map((f) => ({
        path: f.path,
        expectedFileIdKey: f.fileIdKey,
      })),
      keepTargets: keepFiles.map((f) => ({
        path: f.path,
        expectedFileIdKey: f.fileIdKey,
      })),
    });
  }

  return {
    selectedCount,
    selectedBytes,
    estimatedReclaimableBytes,
    affectedGroupCount,
    plans,
  };
}
