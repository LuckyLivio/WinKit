import { describe, expect, it } from "vitest";
import {
  computeDuplicateSelectionByPreset,
  computeSelectionSummary,
  isLastUnselectedInGroup,
  toggleDuplicateItemSelection,
  type DuplicateFileEntry,
  type DuplicateGroup,
} from "./findDuplicatesEngine";

function makeFile(path: string, overrides: Partial<DuplicateFileEntry> = {}): DuplicateFileEntry {
  const parts = path.split("\\");
  const fileName = parts[parts.length - 1] ?? path;
  const parentDir = parts.slice(0, -1).join("\\");
  return {
    path,
    parentDir,
    fileName,
    byteLength: 4096,
    modifiedMs: 1_700_000_000_000,
    createdMs: 1_700_000_000_000,
    isHidden: false,
    hardlinkCount: 1,
    fileIdKey: `id:${path.toLowerCase()}`,
    ...overrides,
  };
}

describe("findDuplicatesEngine", () => {
  const sampleGroup: DuplicateGroup = {
    groupId: "g1",
    sha256: "a".repeat(64),
    byteLength: 4096,
    reclaimableBytes: 8192,
    files: [
      makeFile("D:\\Archive\\Deep\\Folder\\doc_copy.pdf", { modifiedMs: 2_000 }),
      makeFile("D:\\Primary\\doc.pdf", { modifiedMs: 3_000 }),
      makeFile("D:\\OldBackup\\doc_2020.pdf", { modifiedMs: 1_000 }),
    ],
  };

  it("enforces keeping at least 1 copy per group during manual toggling", () => {
    const step1 = toggleDuplicateItemSelection(
      sampleGroup,
      new Set(),
      "D:\\Archive\\Deep\\Folder\\doc_copy.pdf",
    );
    expect(step1.blockedLastCopy).toBe(false);
    expect(step1.nextSelected.size).toBe(1);

    const step2 = toggleDuplicateItemSelection(
      sampleGroup,
      step1.nextSelected,
      "D:\\OldBackup\\doc_2020.pdf",
    );
    expect(step2.blockedLastCopy).toBe(false);
    expect(step2.nextSelected.size).toBe(2);

    // Remaining unselected file `D:\Primary\doc.pdf` is now protected as the last kept copy
    expect(isLastUnselectedInGroup(sampleGroup, step2.nextSelected, "D:\\Primary\\doc.pdf")).toBe(
      true,
    );

    const step3 = toggleDuplicateItemSelection(
      sampleGroup,
      step2.nextSelected,
      "D:\\Primary\\doc.pdf",
    );
    expect(step3.blockedLastCopy).toBe(true);
    expect(step3.nextSelected.has("D:\\Primary\\doc.pdf")).toBe(false);
  });

  it("applies Keep Newest, Keep Oldest, Keep Shortest Path, and Keep In Folder presets accurately", () => {
    const keepNewest = computeDuplicateSelectionByPreset([sampleGroup], "keep_newest");
    expect([...keepNewest].sort()).toEqual([
      "D:\\Archive\\Deep\\Folder\\doc_copy.pdf",
      "D:\\OldBackup\\doc_2020.pdf",
    ]);

    const keepOldest = computeDuplicateSelectionByPreset([sampleGroup], "keep_oldest");
    expect([...keepOldest].sort()).toEqual([
      "D:\\Archive\\Deep\\Folder\\doc_copy.pdf",
      "D:\\Primary\\doc.pdf",
    ]);

    const keepShortest = computeDuplicateSelectionByPreset([sampleGroup], "keep_shortest_path");
    expect([...keepShortest].sort()).toEqual([
      "D:\\Archive\\Deep\\Folder\\doc_copy.pdf",
      "D:\\OldBackup\\doc_2020.pdf",
    ]);

    // Keep In Folder (`D:\Primary`) selects copies outside `D:\Primary` while avoiding prefix false-positives (`D:\PrimaryExtra`)
    const prefixTrapGroup: DuplicateGroup = {
      groupId: "g2",
      sha256: "b".repeat(64),
      byteLength: 1024,
      reclaimableBytes: 1024,
      files: [makeFile("D:\\PrimaryExtra\\a.txt"), makeFile("D:\\OldBackup\\a.txt")],
    };
    const keepInPrimary = computeDuplicateSelectionByPreset(
      [sampleGroup, prefixTrapGroup],
      "keep_in_folder",
      { preferredFolder: "D:\\Primary" },
    );
    expect([...keepInPrimary].sort()).toEqual([
      "D:\\Archive\\Deep\\Folder\\doc_copy.pdf",
      "D:\\OldBackup\\doc_2020.pdf",
    ]);
  });

  it("computes selection counts, bytes, hardlink-adjusted reclaimable space, and backend verification plans", () => {
    const groupWithHardlink: DuplicateGroup = {
      groupId: "gh",
      sha256: "c".repeat(64),
      byteLength: 10_000,
      reclaimableBytes: 10_000,
      files: [
        makeFile("D:\\Dir1\\linked.bin", { byteLength: 10_000, hardlinkCount: 2 }),
        makeFile("D:\\Dir2\\copy.bin", { byteLength: 10_000, hardlinkCount: 1 }),
      ],
    };

    const summary = computeSelectionSummary([groupWithHardlink], new Set(["D:\\Dir1\\linked.bin"]));
    expect(summary.selectedCount).toBe(1);
    expect(summary.selectedBytes).toBe(10_000);
    // Removing a file that still has another hardlink elsewhere frees 0 physical bytes
    expect(summary.estimatedReclaimableBytes).toBe(0);
    expect(summary.plans[0]?.keepTargets[0]?.path).toBe("D:\\Dir2\\copy.bin");
    expect(summary.plans[0]?.removeTargets[0]?.path).toBe("D:\\Dir1\\linked.bin");
  });
});
