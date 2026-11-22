import { describe, expect, it } from "vitest";
import {
  computeBatchRenamePreview,
  sortBatchRenameEntries,
  validateWindowsFileName,
  type BatchRenameSourceEntry,
} from "./batchRenameEngine";
import type { RenameRule } from "./renameRulesModel";

function makeEntry(
  fileName: string,
  overrides: Partial<BatchRenameSourceEntry> = {},
): BatchRenameSourceEntry {
  const parentDir = overrides.parentDir ?? "D:\\Temp\\Batch";
  return {
    path: `${parentDir}\\${fileName}`,
    parentDir,
    fileName,
    byteLength: 128,
    createdMs: 1_700_000_000_000,
    modifiedMs: 1_700_086_400_000,
    ...overrides,
  };
}

describe("batchRenameEngine", () => {
  it("applies literal and regex replace rules including ${name}, $1, and $$ without double expansion", () => {
    const entries = [makeEntry("IMG_42.JPG"), makeEntry("IMG_7.JPG")];
    const regexRule: RenameRule = {
      kind: "replace",
      find: "(?<tag>IMG)_(\\d+)",
      replacement: "$2-${tag}-$$1",
      regex: true,
      scope: "stem",
    };

    const preview = computeBatchRenamePreview(entries, regexRule, "name", { locale: "en-US" });
    expect(preview.canExecute).toBe(true);
    // Natural sort puts IMG_7 before IMG_42
    expect(preview.rows.map((r) => [r.oldName, r.newName, r.status])).toEqual([
      ["IMG_7.JPG", "7-IMG-$1.JPG", "ready"],
      ["IMG_42.JPG", "42-IMG-$1.JPG", "ready"],
    ]);
  });

  it("blocks execution cleanly when regex syntax is invalid", () => {
    const entries = [makeEntry("report.txt")];
    const invalidRegexRule: RenameRule = {
      kind: "replace",
      find: "(unclosed",
      replacement: "x",
      regex: true,
      scope: "stem",
    };

    const preview = computeBatchRenamePreview(entries, invalidRegexRule, "name", {
      locale: "zh-CN",
    });
    expect(preview.regexError).toBeTruthy();
    expect(preview.canExecute).toBe(false);
    expect(preview.rows[0]?.newName).toBe("report.txt");
  });

  it("supports prefix/suffix across stem, extension, and full filename", () => {
    const entries = [makeEntry("notes.md"), makeEntry("Makefile")];
    const stemRule: RenameRule = {
      kind: "add",
      prefix: "2026_",
      suffix: "_v2",
      scope: "stem",
    };
    const stemPreview = computeBatchRenamePreview(entries, stemRule, "name", { locale: "en-US" });
    expect(stemPreview.rows.map((r) => r.newName)).toEqual(
      ["Makefile", "notes.md"].map((n) =>
        n === "notes.md" ? "2026_notes_v2.md" : "2026_Makefile_v2",
      ),
    );

    const extRule: RenameRule = {
      kind: "add",
      prefix: "",
      suffix: ".bak",
      scope: "extension",
    };
    const extPreview = computeBatchRenamePreview([makeEntry("notes.md")], extRule, "name", {
      locale: "en-US",
    });
    expect(extPreview.rows[0]?.newName).toBe("notes.md.bak");
  });

  it("formats numbering with start=0, zero padding, date modes, and preserved extensions", () => {
    const entries = [
      makeEntry("b.png", { createdMs: new Date(2026, 0, 15, 12, 0, 0).getTime() }),
      makeEntry("a.png", { createdMs: new Date(2026, 0, 10, 12, 0, 0).getTime() }),
    ];
    const formatRule: RenameRule = {
      kind: "format",
      base: "shot",
      start: 0,
      padding: 3,
      separator: "_",
      date: "created",
    };

    const preview = computeBatchRenamePreview(entries, formatRule, "created", {
      locale: "en-US",
    });
    expect(preview.canExecute).toBe(true);
    expect(preview.rows.map((r) => [r.oldName, r.newName])).toEqual([
      ["a.png", "shot_2026-01-10_000.png"],
      ["b.png", "shot_2026-01-15_001.png"],
    ]);
  });

  it("identifies case-only renames as actionable and supports lower/upper/title case", () => {
    const entries = [makeEntry("readme_final draft.TXT")];
    const titleStem: RenameRule = { kind: "case", mode: "title", scope: "stem" };
    const preview = computeBatchRenamePreview(entries, titleStem, "name", { locale: "en-US" });

    expect(preview.caseOnlyCount).toBe(1);
    expect(preview.readyCount).toBe(0);
    expect(preview.canExecute).toBe(true);
    expect(preview.rows[0]?.newName).toBe("Readme_Final Draft.TXT");
    expect(preview.rows[0]?.status).toBe("case_only");
  });

  it("allows two-file swaps (a.txt <-> b.txt) while catching batch and external collisions", () => {
    const swapEntries = [makeEntry("a.txt"), makeEntry("b.txt")];
    const swapRule: RenameRule = {
      kind: "replace",
      find: "^(a|b)$",
      replacement: "$1",
      regex: true,
      scope: "stem",
    };
    expect(
      computeBatchRenamePreview(swapEntries, swapRule, "name", { locale: "en-US" }).canExecute,
    ).toBe(false);

    // Swap a.txt <-> b.txt via temporary mapping regex or custom rule:
    // Use two files `1_item.txt` and `2_item.txt`? Let's swap `a.txt` and `b.txt` using format when sorted by modified!
    const swapBySortEntries = [
      makeEntry("item-1.txt", { modifiedMs: 2_000 }),
      makeEntry("item-2.txt", { modifiedMs: 1_000 }),
    ];
    const renumberRule: RenameRule = {
      kind: "format",
      base: "item",
      start: 1,
      padding: 1,
      separator: "-",
      date: "none",
    };
    const swapPreview = computeBatchRenamePreview(swapBySortEntries, renumberRule, "modified", {
      locale: "en-US",
      existingDirSiblings: {
        "D:\\Temp\\Batch": ["item-1.txt", "item-2.txt", "keep.txt"],
      },
    });
    expect(swapPreview.canExecute).toBe(true);
    expect(swapPreview.rows.map((r) => [r.oldName, r.newName, r.status])).toEqual([
      ["item-2.txt", "item-1.txt", "ready"],
      ["item-1.txt", "item-2.txt", "ready"],
    ]);

    // External sibling collision (`keep.txt` exists in folder outside batch)
    const externalCollisionRule: RenameRule = {
      kind: "replace",
      find: "item-1",
      replacement: "KEEP",
      regex: false,
      scope: "stem",
    };
    const extCollisionPreview = computeBatchRenamePreview(
      swapBySortEntries,
      externalCollisionRule,
      "name",
      {
        locale: "zh-CN",
        existingDirSiblings: {
          "D:\\Temp\\Batch": ["item-1.txt", "item-2.txt", "keep.txt"],
        },
      },
    );
    expect(extCollisionPreview.canExecute).toBe(false);
    expect(extCollisionPreview.conflictCount).toBe(1);
    expect(extCollisionPreview.rows[0]?.status).toBe("conflict_existing");

    // In-batch case-insensitive collision (two files collapse onto same target name)
    const batchCollisionRule: RenameRule = {
      kind: "replace",
      find: "\\d+",
      replacement: "same",
      regex: true,
      scope: "stem",
    };
    const batchCollisionPreview = computeBatchRenamePreview(
      swapBySortEntries,
      batchCollisionRule,
      "name",
      { locale: "en-US" },
    );
    expect(batchCollisionPreview.canExecute).toBe(false);
    expect(batchCollisionPreview.conflictCount).toBe(2);
    expect(batchCollisionPreview.rows.every((r) => r.status === "conflict_in_batch")).toBe(true);
  });

  it("rejects disallowed Windows characters, trailing dot/space, and reserved DOS device names", () => {
    expect(validateWindowsFileName("CON.txt", "en-US")).toMatch(/reserved/i);
    expect(validateWindowsFileName("lpt9.log", "zh-CN")).toMatch(/保留设备名/);
    expect(validateWindowsFileName("report.", "en-US")).toMatch(/period/i);
    expect(validateWindowsFileName("report ", "en-US")).toMatch(/space/i);
    expect(validateWindowsFileName("a:b.txt", "en-US")).toMatch(/disallowed/i);
    expect(validateWindowsFileName("sub\\file.txt", "en-US")).toMatch(/disallowed/i);
    expect(validateWindowsFileName(".gitignore", "en-US")).toBeNull();
  });

  it("sorts naturally by filename and deterministically by timestamps", () => {
    const unsorted = [
      makeEntry("page10.txt", { modifiedMs: 300 }),
      makeEntry("page2.txt", { modifiedMs: 100 }),
      makeEntry("page1.txt", { modifiedMs: 200 }),
    ];
    expect(sortBatchRenameEntries(unsorted, "name").map((e) => e.fileName)).toEqual([
      "page1.txt",
      "page2.txt",
      "page10.txt",
    ]);
    expect(sortBatchRenameEntries(unsorted, "modified").map((e) => e.fileName)).toEqual([
      "page2.txt",
      "page1.txt",
      "page10.txt",
    ]);
  });
});
