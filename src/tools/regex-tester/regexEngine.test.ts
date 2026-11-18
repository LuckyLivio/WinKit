import { Worker as NodeThreadWorker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { enterFrontendShutdownGate, resetFrontendShutdownGate } from "../../lib/shutdownGate";
import { PreemptiveRegexController, type RegexWorkerLike } from "./regexController";
import { executeRegexInWorkerScope } from "./regexCore";
import type { RegexWorkerMessageIn, RegexWorkerMessageOut } from "./regexWorker";

/**
 * Wraps a real OS-level `node:worker_threads` thread executing `RegExp` so automated unit tests
 * verify true preemptive thread termination (`terminate()`) on catastrophic backtracking.
 */
function createNodeThreadRegexWorker(): RegexWorkerLike {
  const workerScript = `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", ({ seq, request }) => {
      try {
        const re = new RegExp(request.pattern, request.flags);
        const matches = [];
        re.lastIndex = 0;
        const iterative = re.global || re.sticky;
        while (true) {
          const m = re.exec(request.testText);
          if (!m) break;
          matches.push({
            matchNumber: matches.length + 1,
            value: m[0],
            utf16Start: m.index,
            utf16End: m.index + m[0].length,
            line: 1,
            utf16Column: m.index + 1,
            isZeroLength: m[0].length === 0,
            captures: []
          });
          if (!iterative) break;
          if (m[0].length === 0) re.lastIndex += 1;
        }
        parentPort.postMessage({
          seq,
          result: {
            status: "ok",
            flagsUsed: re.flags,
            hasIndicesFlag: false,
            totalMatchesCollected: matches.length,
            matchesTruncated: false,
            highlightTruncated: false,
            matches,
            replacementPreview: request.enableReplace
              ? request.testText.replace(new RegExp(request.pattern, request.flags), request.replacementTemplate)
              : null,
            replacementFull: request.enableReplace
              ? request.testText.replace(new RegExp(request.pattern, request.flags), request.replacementTemplate)
              : null,
            replacementPreviewTruncated: false,
            elapsedMs: 1
          }
        });
      } catch (err) {
        parentPort.postMessage({
          seq,
          result: { status: "invalid_regex", errorMessage: err.message }
        });
      }
    });
  `;

  const thread = new NodeThreadWorker(workerScript, { eval: true });
  const wrapper: RegexWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: RegexWorkerMessageIn) {
      thread.postMessage(msg);
    },
    terminate() {
      void thread.terminate();
    },
  };
  thread.on("message", (data: RegexWorkerMessageOut) => {
    wrapper.onmessage?.({ data } as MessageEvent<RegexWorkerMessageOut>);
  });
  thread.on("error", (err: Error) => {
    wrapper.onerror?.({ message: err.message } as ErrorEvent);
  });
  return wrapper;
}

describe("D08 regexCore & PreemptiveRegexController", () => {
  it("supports standard matches, named captures, JS replacement tokens, UTF-16 offsets, and 1-based line/column", () => {
    const res = executeRegexInWorkerScope({
      pattern: "(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})(?:-(?<tag>[A-Z]+))?",
      flags: "gmd",
      testText: "Item A: 2026-11-18\r\nItem B: 2027-01-05-PROD",
      enableReplace: true,
      replacementTemplate: "$<day>/$<month>/$<year> [$$1=$1]",
    });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    expect(res.matches).toHaveLength(2);
    expect(res.matches[0]?.utf16Start).toBe(8);
    expect(res.matches[0]?.utf16End).toBe(18);
    expect(res.matches[0]?.line).toBe(1);
    expect(res.matches[0]?.utf16Column).toBe(9);
    expect(res.matches[0]?.captures[0]?.name).toBe("year");
    expect(res.matches[0]?.captures[0]?.value).toBe("2026");
    expect(res.matches[0]?.captures[3]?.matched).toBe(false);

    expect(res.matches[1]?.line).toBe(2);
    expect(res.matches[1]?.utf16Column).toBe(9);
    expect(res.matches[1]?.captures[3]?.matched).toBe(true);
    expect(res.matches[1]?.captures[3]?.value).toBe("PROD");

    expect(res.replacementFull).toBe(
      "Item A: 18/11/2026 [$1=2026]\r\nItem B: 05/01/2027 [$1=2027]",
    );
  });

  it("advances zero-length global matches across astral surrogate pairs without splitting or infinite looping", () => {
    // "A🚀B" has UTF-16 length 4: 'A' (0), '🚀' (1..3 surrogate pair), 'B' (3)
    const res = executeRegexInWorkerScope({
      pattern: "(?:)",
      flags: "gu",
      testText: "A🚀B",
      enableReplace: false,
      replacementTemplate: "",
    });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.matches.map((m) => m.utf16Start)).toEqual([0, 1, 3, 4]);
    expect(res.matches.every((m) => m.isZeroLength)).toBe(true);
  });

  it("handles Unicode script property escapes and rejects invalid patterns or incompatible flags (e.g. u+v or ICU x)", () => {
    const hanRes = executeRegexInWorkerScope({
      pattern: "\\p{Script=Han}+",
      flags: "gu",
      testText: "WinKit 桌面工具箱 2026",
      enableReplace: false,
      replacementTemplate: "",
    });
    expect(hanRes.status).toBe("ok");
    if (hanRes.status === "ok") {
      expect(hanRes.matches).toHaveLength(1);
      expect(hanRes.matches[0]?.value).toBe("桌面工具箱");
    }

    const badPattern = executeRegexInWorkerScope({
      pattern: "([a-z",
      flags: "g",
      testText: "abc",
      enableReplace: false,
      replacementTemplate: "",
    });
    expect(badPattern.status).toBe("invalid_regex");

    const badFlagsUv = executeRegexInWorkerScope({
      pattern: "a",
      flags: "uv",
      testText: "a",
      enableReplace: false,
      replacementTemplate: "",
    });
    expect(badFlagsUv.status).toBe("invalid_regex");

    const unsupportedIcuX = executeRegexInWorkerScope({
      pattern: "a",
      flags: "x",
      testText: "a",
      enableReplace: false,
      replacementTemplate: "",
    });
    expect(unsupportedIcuX.status).toBe("invalid_regex");
  });

  it("truly terminates a hung OS Worker thread on catastrophic backtracking within budget and recovers immediately for subsequent regexes", async () => {
    resetFrontendShutdownGate();
    const ctrl = new PreemptiveRegexController({
      timeoutMs: 220,
      workerFactory: createNodeThreadRegexWorker,
    });

    const t0 = Date.now();
    // Controlled catastrophic backtracking input: (a+)+$ against 34 'a's + '!' hangs synchronous JS RegExp
    const hungOutcome = await ctrl.evaluate({
      pattern: "^(a+)+$",
      flags: "",
      testText: `${"a".repeat(34)}!`,
      enableReplace: false,
      replacementTemplate: "",
    });
    const elapsed = Date.now() - t0;

    expect(hungOutcome.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(1500);

    // Subsequent normal regex spawns a clean Worker and completes immediately
    const nextOutcome = await ctrl.evaluate({
      pattern: "Win(\\w+)",
      flags: "g",
      testText: "Hello WinKit!",
      enableReplace: true,
      replacementTemplate: "[$1]",
    });
    expect(nextOutcome.kind).toBe("completed");
    if (nextOutcome.kind === "completed" && nextOutcome.result.status === "ok") {
      expect(nextOutcome.result.matches[0]?.value).toBe("WinKit");
      expect(nextOutcome.result.replacementFull).toBe("Hello [Kit]!");
    }

    // Also verify shutdown gate blocks new Worker creation during window shutdown
    enterFrontendShutdownGate();
    const blocked = await ctrl.evaluate({
      pattern: "abc",
      flags: "g",
      testText: "abc",
      enableReplace: false,
      replacementTemplate: "",
    });
    expect(blocked.kind).toBe("cancelled");
    resetFrontendShutdownGate();
    ctrl.dispose();
  });
});
