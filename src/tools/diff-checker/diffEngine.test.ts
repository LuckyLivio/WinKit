import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDiffResult, MAX_DIFF_LINES_PER_SIDE } from "./diffEngine";

/**
 * Verifies in an isolated temporary directory (outside any user files) that `git apply`
 * reconstructs exact `rightText` byte-for-byte when applying WinKit's `exactUnifiedPatch` to `leftText`.
 */
function assertPatchReconstructsExactTarget(
  leftText: string,
  rightText: string,
  options = { ignoreWhitespace: false, ignoreCase: false },
) {
  const dir = mkdtempSync(join(tmpdir(), "winkit-d07-patch-"));
  try {
    const res = computeDiffResult(leftText, rightText, options, "sample.txt", "sample.txt");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    const targetFile = join(dir, "sample.txt");
    writeFileSync(targetFile, Buffer.from(leftText, "utf-8"));

    if (leftText === rightText) {
      expect(res.summary.exactIdentical).toBe(true);
      expect(res.exactUnifiedPatch).toBe("");
      return;
    }

    expect(res.summary.exactIdentical).toBe(false);
    expect(res.exactUnifiedPatch.length).toBeGreaterThan(0);

    const patchFile = join(dir, "exact.patch");
    writeFileSync(patchFile, Buffer.from(res.exactUnifiedPatch, "utf-8"));

    execFileSync(
      "git",
      ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "exact.patch"],
      {
        cwd: dir,
        stdio: "pipe",
      },
    );

    const reconstructed = readFileSync(targetFile);
    expect(reconstructed.equals(Buffer.from(rightText, "utf-8"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("D07 diffEngine — Myers diff, intra-line highlights, filters & git-apply patch fidelity", () => {
  it("handles empty-vs-empty, empty-vs-non-empty, non-empty-vs-empty, and trailing-newline-only changes with exact patch reconstruction", () => {
    // 1. Empty vs Empty
    const emptyRes = computeDiffResult("", "", { ignoreWhitespace: false, ignoreCase: false });
    expect(emptyRes.status === "ok" && emptyRes.summary.exactIdentical).toBe(true);
    assertPatchReconstructsExactTarget("", "");

    // 2. Empty vs Non-empty & Non-empty vs Empty
    assertPatchReconstructsExactTarget("", "alpha\nbeta\n");
    assertPatchReconstructsExactTarget("", "single line without newline");
    assertPatchReconstructsExactTarget("alpha\nbeta\n", "");

    // 3. Only trailing newline added or removed
    assertPatchReconstructsExactTarget("line1\nline2", "line1\nline2\n");
    assertPatchReconstructsExactTarget("line1\nline2\n", "line1\nline2");
  });

  it("reconstructs exact bytes across CRLF/LF changes, UTF-8 BOM, repeated lines, CJK/emoji, and HTML tags", () => {
    // CRLF vs LF
    assertPatchReconstructsExactTarget("a\r\nb\r\nc\r\n", "a\nb\nc\n");
    assertPatchReconstructsExactTarget("a\nb\nc", "a\r\nb_mod\r\nc\r\n");

    // UTF-8 BOM added/removed
    assertPatchReconstructsExactTarget("\uFEFFheader\nbody\n", "header\nbody\n");
    assertPatchReconstructsExactTarget("header\nbody\n", "\uFEFFheader\nbody\n");

    // Repeated lines
    assertPatchReconstructsExactTarget(
      "dup\ndup\nkeep\ndup\ndup\n",
      "dup\nchanged\ndup\nkeep\ndup\nadded\n",
    );

    // Chinese, ZWJ emoji, and literal HTML/script strings
    assertPatchReconstructsExactTarget(
      '<h1>标题</h1>\nconst msg = "你好 👨‍👩‍👧‍👦";\n<script>alert(1)</script>\n',
      '<h1>新标题</h1>\nconst msg = "世界 👨‍👩‍👧‍👦 🚀";\n<script>alert(2)</script>\n',
    );
  });

  it("filters display view for ignoreWhitespace and ignoreCase without mutating inputs while keeping exactUnifiedPatch accurate", () => {
    const rawA = "Hello   World\r\nSecond Line\n";
    const rawB = "  hello world\nSECOND LINE  \n";

    const filtered = computeDiffResult(rawA, rawB, {
      ignoreWhitespace: true,
      ignoreCase: true,
    });
    expect(filtered.status).toBe("ok");
    if (filtered.status !== "ok") return;

    // Display diff hides whitespace/case differences, yet raw patch still reconstructs B from A!
    expect(filtered.summary.displayIdentical).toBe(true);
    expect(filtered.summary.exactIdentical).toBe(false);
    assertPatchReconstructsExactTarget(rawA, rawB, {
      ignoreWhitespace: true,
      ignoreCase: true,
    });
  });

  it("handles a 10,000-line input within cap with collapsed context and enforces the 50,000-line ceiling cleanly", () => {
    const aLines: string[] = [];
    const bLines: string[] = [];
    for (let i = 1; i <= 10_000; i++) {
      aLines.push(`record_${i} = ${i * 10}`);
      if (i === 250 || i === 5_000 || i === 9_800) {
        bLines.push(`record_${i} = ${i * 10 + 1} // updated`);
      } else {
        bLines.push(`record_${i} = ${i * 10}`);
      }
    }
    const largeA = `${aLines.join("\n")}\n`;
    const largeB = `${bLines.join("\n")}\n`;

    const res = computeDiffResult(largeA, largeB, {
      ignoreWhitespace: false,
      ignoreCase: false,
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.summary.hunkCount).toBe(3);
      expect(res.summary.addedLines).toBe(3);
      expect(res.summary.deletedLines).toBe(3);
      expect(res.inlineBlocks.some((b) => b.blockType === "collapsed")).toBe(true);
    }

    assertPatchReconstructsExactTarget(largeA, largeB);

    // Exceeding 50,000 lines returns structured LINE_LIMIT_EXCEEDED error without hanging
    const tooMany = "x\n".repeat(MAX_DIFF_LINES_PER_SIDE + 5);
    const overRes = computeDiffResult(tooMany, "x\n", {
      ignoreWhitespace: false,
      ignoreCase: false,
    });
    expect(overRes.status).toBe("error");
    if (overRes.status === "error") {
      expect(overRes.code).toBe("LINE_LIMIT_EXCEEDED");
    }
  });
});
