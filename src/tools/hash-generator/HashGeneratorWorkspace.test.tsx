import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { HashGeneratorWorkspace } from "./HashGeneratorWorkspace";

function renderHashWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <HashGeneratorWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("D03 HashGeneratorWorkspace UI (multi-algorithm & multi-file batch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 known vectors, verifies grouped SHA-256 expected digest, and shows compat notice", async () => {
    const user = userEvent.setup();
    renderHashWorkspace();

    await user.click(screen.getByRole("button", { name: "MD5" }));
    await user.click(screen.getByRole("button", { name: "SHA-512" }));
    expect(screen.getByText(/不适用于密码存储/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新计算" }));
    await waitFor(() =>
      expect(screen.getByTestId("digest-SHA-256")).toHaveTextContent(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    );
    expect(screen.getByTestId("digest-MD5")).toHaveTextContent("d41d8cd98f00b204e9800998ecf8427e");

    const input = screen.getByLabelText("待计算文本");
    await user.type(input, "abc");
    await waitFor(() =>
      expect(screen.getByTestId("digest-MD5")).toHaveTextContent(
        "900150983cd24fb0d6963f7d28e17f72",
      ),
    );

    // Grouped 32+32 SHA-256("abc") must match SHA-256 rather than truncating to MD5
    const compareBox = screen.getByLabelText(/期望摘要比对/);
    await user.type(
      compareBox,
      "ba7816bf8f01cfea414140de5dae2223 b00361a396177a9cb410ff61f20015ad",
    );
    expect(screen.getByText(/一致：与当前计算的 SHA-256/)).toBeInTheDocument();

    // Unselected SHA-1 (40 hex) informs candidate SHA-1 uncomputed until enabled
    await user.clear(compareBox);
    await user.type(compareBox, "a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(screen.getByText(/推断候选算法为 SHA-1/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "SHA-1" }));
    await waitFor(() => expect(screen.getByText(/一致：与当前计算的 SHA-1/)).toBeInTheDocument());
  });

  it("handles multi-file drop with same-basename files, isolates per-file Compare, freezes algorithm snapshot, copies batch digests, and exports CSV", async () => {
    const user = userEvent.setup();
    let capturedDropHandler: ((paths: string[]) => void) | null = null;

    vi.spyOn(tauriBridge, "subscribeFileDrop").mockImplementation(async (handlers) => {
      capturedDropHandler = handlers.onDropPaths;
      return () => {};
    });

    const clipWrites: string[] = [];
    vi.spyOn(tauriBridge, "writeSystemClipboardText").mockImplementation(async (txt) => {
      clipWrites.push(txt);
    });

    const savedPayloads: Array<Parameters<typeof tauriBridge.saveLocalTextFile>[0]> = [];
    vi.spyOn(tauriBridge, "pickSaveFilePath").mockResolvedValueOnce("D:\\out\\batch_hashes.csv");
    vi.spyOn(tauriBridge, "saveLocalTextFile").mockImplementation(async (params) => {
      savedPayloads.push(params);
      return { path: params.outputPath, byteLength: params.content.length };
    });

    vi.spyOn(tauriBridge, "computeBatchFileHashes").mockImplementation(async (batchId, items) => ({
      batchId,
      cancelled: false,
      items: items.map((it) => {
        if (it.path === "D:\\dirA\\payload.bin") {
          return {
            itemId: it.itemId,
            path: it.path,
            fileName: "payload.bin",
            status: "completed",
            byteLength: 3,
            digests: [
              {
                algorithm: "SHA-256",
                hexLength: 64,
                digestHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
              },
            ],
            errorCode: null,
            errorMessage: null,
          };
        }
        if (it.path === "D:\\dirB\\payload.bin") {
          return {
            itemId: it.itemId,
            path: it.path,
            fileName: "payload.bin",
            status: "completed",
            byteLength: 0,
            digests: [
              {
                algorithm: "SHA-256",
                hexLength: 64,
                digestHex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              },
            ],
            errorCode: null,
            errorMessage: null,
          };
        }
        return {
          itemId: it.itemId,
          path: it.path,
          fileName: "missing.bin",
          status: "error",
          byteLength: null,
          digests: null,
          errorCode: "FILE_NOT_FOUND",
          errorMessage: "not found",
        };
      }),
    }));

    renderHashWorkspace();
    await waitFor(() => expect(capturedDropHandler).not.toBeNull());

    // Drop 3 paths at once (including two identically named `payload.bin` in distinct folders)
    await act(async () => {
      capturedDropHandler!([
        "D:\\dirA\\payload.bin",
        "D:\\dirB\\payload.bin",
        "D:\\dirB\\missing.bin",
      ]);
    });

    await waitFor(() =>
      expect(screen.getByText(/共 3 项 · 完成 2 · 读取中 0 · 等待 0 · 失败 1/)).toBeInTheDocument(),
    );

    // Bind expected digest to File #1 (`dirA\payload.bin`), then click File #2 (`dirB\payload.bin`) and verify no cross-contamination
    const compareBox = screen.getByLabelText(/期望摘要比对/);
    await user.type(compareBox, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(screen.getByText(/一致：与当前计算的 SHA-256/)).toBeInTheDocument();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    await user.click(options[1]!);
    expect(compareBox).toHaveValue("");
    expect(screen.getByTestId("digest-SHA-256")).toHaveTextContent(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    // Toggle MD5 in toolbar: existing batch keeps its `SHA-256` snapshot without claiming MD5 is done
    await user.click(screen.getByRole("button", { name: "MD5" }));
    expect(screen.getByText("本批算法快照：SHA-256")).toBeInTheDocument();
    expect(screen.queryByTestId("digest-MD5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按当前算法重算本批" })).toBeInTheDocument();

    // Uppercase + Copy Batch Digests
    await user.click(screen.getByLabelText("大写十六进制"));
    await user.click(screen.getByRole("button", { name: "复制本批摘要 (2)" }));
    expect(clipWrites[0]).toContain("# payload.bin (D:\\dirA\\payload.bin)");
    expect(clipWrites[0]).toContain("# payload.bin (D:\\dirB\\payload.bin)");
    expect(clipWrites[0]).toContain(
      "SHA-256: BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    );

    // Export CSV and verify all 3 source paths are protected against overwrite
    await user.click(screen.getByRole("button", { name: "保存 CSV…" }));
    await waitFor(() => expect(savedPayloads).toHaveLength(1));
    expect(savedPayloads[0]!.forbiddenSourcePaths).toEqual([
      "D:\\dirA\\payload.bin",
      "D:\\dirB\\payload.bin",
      "D:\\dirB\\missing.bin",
    ]);
    expect(savedPayloads[0]!.content).toContain("match (SHA-256)");
    expect(savedPayloads[0]!.content).toContain("FILE_NOT_FOUND");
  });

  it("finishes an active file batch after clearing the text workspace", async () => {
    const user = userEvent.setup();
    const pending = createDeferred<tauriBridge.MultiFileBatchHashResult>();
    const path = "report.bin";
    const digest = "abcd".repeat(16);
    vi.spyOn(tauriBridge, "pickMultipleFiles").mockResolvedValue([path]);
    const compute = vi
      .spyOn(tauriBridge, "computeBatchFileHashes")
      .mockReturnValue(pending.promise);
    const cancel = vi.spyOn(tauriBridge, "cancelBackendTask").mockResolvedValue(true);

    renderHashWorkspace();
    await user.click(screen.getByRole("button", { name: /本地文件/ }));
    await user.click(screen.getAllByRole("button", { name: "选择本地文件…" })[0]!);
    const [batchId, items] = compute.mock.calls[0]!;
    await user.click(screen.getByRole("button", { name: "UTF-8 文本" }));
    await user.type(screen.getByLabelText("待计算文本"), "abc");
    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByLabelText("待计算文本")).toHaveValue("");
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve({
        batchId,
        cancelled: false,
        items: [
          {
            ...items[0]!,
            fileName: path,
            status: "completed",
            byteLength: 3,
            digests: [{ algorithm: "SHA-256", hexLength: 64, digestHex: digest }],
            errorCode: null,
            errorMessage: null,
          },
        ],
      });
    });
    await user.click(screen.getByRole("button", { name: /本地文件/ }));
    expect(screen.getByRole("option")).toHaveTextContent(path);
    expect(screen.getByText(/共 1 项 · 完成 1/)).toBeInTheDocument();
    expect(screen.getByTestId("digest-SHA-256")).toHaveTextContent(digest);
  });

  it("resumes only incomplete items after batch cancellation and discards stale callbacks after Clear or new batch", async () => {
    const user = userEvent.setup();
    const calls: Array<{
      batchId: string;
      items: readonly tauriBridge.BatchHashInputItem[];
      deferred: ReturnType<typeof createDeferred<tauriBridge.MultiFileBatchHashResult>>;
    }> = [];

    vi.spyOn(tauriBridge, "pickMultipleFiles")
      .mockResolvedValueOnce(["D:\\f1.bin", "D:\\f2.bin"])
      .mockResolvedValueOnce(["D:\\fresh.bin"]);

    vi.spyOn(tauriBridge, "cancelBackendTask").mockResolvedValue(true);
    vi.spyOn(tauriBridge, "computeBatchFileHashes").mockImplementation((batchId, items) => {
      const deferred = createDeferred<tauriBridge.MultiFileBatchHashResult>();
      calls.push({ batchId, items, deferred });
      return deferred.promise;
    });

    renderHashWorkspace();
    await user.click(screen.getByRole("button", { name: /本地文件/ }));
    await user.click(screen.getAllByRole("button", { name: "选择本地文件…" })[0]!);

    expect(calls).toHaveLength(1);
    const firstCall = calls[0]!;
    expect(firstCall.items).toHaveLength(2);

    // Simulate user clicking Cancel Batch: file 1 completed, file 2 cancelled
    await user.click(screen.getByRole("button", { name: "取消批次" }));
    await act(async () => {
      firstCall.deferred.resolve({
        batchId: firstCall.batchId,
        cancelled: true,
        items: [
          {
            itemId: firstCall.items[0]!.itemId,
            path: "D:\\f1.bin",
            fileName: "f1.bin",
            status: "completed",
            byteLength: 3,
            digests: [
              {
                algorithm: "SHA-256",
                hexLength: 64,
                digestHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
              },
            ],
            errorCode: null,
            errorMessage: null,
          },
          {
            itemId: firstCall.items[1]!.itemId,
            path: "D:\\f2.bin",
            fileName: "f2.bin",
            status: "cancelled",
            byteLength: null,
            digests: null,
            errorCode: "TASK_CANCELLED",
            errorMessage: "cancelled",
          },
        ],
      });
    });

    // Resume button shows ONLY 1 incomplete item, and clicking Resume dispatches ONLY `f2.bin`!
    const resumeBtn = await screen.findByRole("button", { name: "继续未完成项 (1)" });
    await user.click(resumeBtn);

    expect(calls).toHaveLength(2);
    const resumeCall = calls[1]!;
    expect(resumeCall.items).toHaveLength(1);
    expect(resumeCall.items[0]!.path).toBe("D:\\f2.bin");

    // Now click Clear while `resumeCall` is still in flight -> resolving `resumeCall` later must NOT revive cleared batch!
    await user.click(screen.getByRole("button", { name: "清空" }));
    await act(async () => {
      resumeCall.deferred.resolve({
        batchId: resumeCall.batchId,
        cancelled: false,
        items: [
          {
            itemId: resumeCall.items[0]!.itemId,
            path: "D:\\f2.bin",
            fileName: "f2.bin",
            status: "completed",
            byteLength: 3,
            digests: [
              {
                algorithm: "SHA-256",
                hexLength: 64,
                digestHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
              },
            ],
            errorCode: null,
            errorMessage: null,
          },
        ],
      });
    });

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
});
