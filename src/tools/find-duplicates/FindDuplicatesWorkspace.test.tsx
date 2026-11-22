import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import type { DuplicateScanProgressPayload, DuplicateScanResult } from "./findDuplicatesEngine";
import { FindDuplicatesWorkspace } from "./FindDuplicatesWorkspace";

function renderFindDuplicates(locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(
    <I18nContext.Provider value={{ locale, t: MESSAGES[locale], setLocale: () => {} }}>
      <SessionStoreProvider>
        <FindDuplicatesWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("F03 FindDuplicatesWorkspace UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with 0 items selected, enforces >= 1 kept copy, confirms count/size, and displays Recycle Bin outcome & space note", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "subscribeFileDrop").mockResolvedValue(() => {});
    vi.spyOn(tauriBridge, "subscribeDuplicateScanProgress").mockResolvedValue(() => {});
    vi.spyOn(tauriBridge, "pickMultipleDirectories").mockResolvedValue([
      "D:\\Photos",
      "D:\\Backup",
    ]);

    const mockResult: DuplicateScanResult = {
      taskId: "scan-1",
      effectiveRoots: ["D:\\Photos", "D:\\Backup"],
      collapsedRedundantRoots: ["D:\\Photos\\2026"],
      scannedFileCount: 12,
      totalDuplicateFiles: 2,
      totalReclaimableBytes: 4096,
      groups: [
        {
          groupId: "4096:aaaa",
          sha256: "a".repeat(64),
          byteLength: 4096,
          reclaimableBytes: 4096,
          files: [
            {
              path: "D:\\Photos\\cover.jpg",
              parentDir: "D:\\Photos",
              fileName: "cover.jpg",
              byteLength: 4096,
              modifiedMs: 1_700_000_500_000,
              createdMs: 1_700_000_000_000,
              isHidden: false,
              hardlinkCount: 1,
              fileIdKey: "1:100",
            },
            {
              path: "D:\\Backup\\cover_old.jpg",
              parentDir: "D:\\Backup",
              fileName: "cover_old.jpg",
              byteLength: 4096,
              modifiedMs: 1_700_000_100_000,
              createdMs: 1_700_000_000_000,
              isHidden: false,
              hardlinkCount: 1,
              fileIdKey: "1:200",
            },
          ],
        },
      ],
      skippedItems: [],
      skippedHardlinks: [
        {
          skippedPath: "D:\\Photos\\cover_hardlink.jpg",
          primaryPath: "D:\\Photos\\cover.jpg",
        },
      ],
    };

    vi.spyOn(tauriBridge, "scanDuplicateFolders").mockResolvedValue(mockResult);
    const recycleSpy = vi.spyOn(tauriBridge, "recycleDuplicateGroups").mockResolvedValue({
      recycledCount: 1,
      recycledBytes: 4096,
      skippedCount: 0,
      failedCount: 0,
      outcomes: [
        {
          groupId: "4096:aaaa",
          path: "D:\\Backup\\cover_old.jpg",
          byteLength: 4096,
          status: "recycled",
          reason: null,
        },
      ],
    });

    renderFindDuplicates("zh-CN");

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    expect(await screen.findByText("D:\\Photos")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(await screen.findByText("cover.jpg")).toBeInTheDocument();

    // Default: 0 items checked after scan
    const cbPrimary = screen.getByRole("checkbox", {
      name: "勾选移入回收站 D:\\Photos\\cover.jpg",
    });
    const cbBackup = screen.getByRole("checkbox", {
      name: "勾选移入回收站 D:\\Backup\\cover_old.jpg",
    });
    expect(cbPrimary).not.toBeChecked();
    expect(cbBackup).not.toBeChecked();
    expect(screen.getByRole("button", { name: "移入回收站" })).toBeDisabled();

    // Check `cover_old.jpg` -> `cover.jpg` becomes the last remaining kept copy and its checkbox is disabled!
    await user.click(cbBackup);
    expect(cbBackup).toBeChecked();
    expect(cbPrimary).toBeDisabled();

    // Clear and apply `保留最新` preset -> selects older `cover_old.jpg`
    await user.click(screen.getByRole("button", { name: "清空勾选" }));
    expect(cbBackup).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "保留最新" }));
    expect(cbBackup).toBeChecked();
    expect(cbPrimary).not.toBeChecked();

    // Click Move to Recycle Bin -> opens confirmation modal showing count & size
    await user.click(screen.getByRole("button", { name: "移入回收站 (1 项 · 4.0 KiB)" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("1 个文件（合计大小 4.0 KiB）");

    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    await waitFor(() => expect(recycleSpy).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("已移入回收站：1 个文件（4.0 KiB）")).toBeInTheDocument();
    expect(screen.getByText(/仍占用磁盘空间/)).toBeInTheDocument();
  });

  it("preserves live duplicate scan progress when switching to another tool and returning", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();

    let progressHandler: ((payload: DuplicateScanProgressPayload) => void) | null = null;
    let resolveScan!: (res: DuplicateScanResult) => void;
    let capturedTaskId = "";

    vi.spyOn(tauriBridge, "subscribeFileDrop").mockResolvedValue(() => {});
    vi.spyOn(tauriBridge, "subscribeDuplicateScanProgress").mockImplementation(async (cb) => {
      progressHandler = cb;
      return () => {};
    });
    vi.spyOn(tauriBridge, "pickMultipleDirectories").mockResolvedValue(["D:\\LargeScan"]);
    vi.spyOn(tauriBridge, "scanDuplicateFolders").mockImplementation((taskId) => {
      capturedTaskId = taskId;
      return new Promise<DuplicateScanResult>((res) => {
        resolveScan = res;
      });
    });
    const cancelSpy = vi.spyOn(tauriBridge, "cancelBackendTask").mockResolvedValue(true);

    render(<App />);

    // Open F03 from sidebar/home
    const f03Buttons = screen.getAllByRole("button", { name: /重复文件查找/ });
    await user.click(f03Buttons[0]!);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(await screen.findByRole("button", { name: "取消扫描" })).toBeInTheDocument();

    // Switch away to Settings while scan is running (unmounts F03 workspace)
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消扫描" })).not.toBeInTheDocument();

    // Progress event arrives while F03 is unmounted!
    await act(async () => {
      progressHandler?.({
        taskId: capturedTaskId,
        phase: "full_hashing",
        scannedFiles: 345,
        candidateFiles: 8,
        processedBytes: 50 * 1024 * 1024,
        totalCandidateBytes: 100 * 1024 * 1024,
        currentPath: "D:\\LargeScan\\movie_copy.mkv",
      });
    });

    // Return to F03 -> sees updated 50% progress, current file path, and working Cancel button!
    await user.click(screen.getByRole("button", { name: /重复文件查找/ }));
    expect(screen.getByText(/已扫描 345 个普通文件 · 50%/)).toBeInTheDocument();
    expect(screen.getByText("D:\\LargeScan\\movie_copy.mkv")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消扫描" }));
    expect(cancelSpy).toHaveBeenCalledWith(capturedTaskId);

    // Resolve cleanly to settle pending promise
    await act(async () => {
      resolveScan({
        taskId: capturedTaskId,
        effectiveRoots: ["D:\\LargeScan"],
        collapsedRedundantRoots: [],
        scannedFileCount: 345,
        totalDuplicateFiles: 0,
        totalReclaimableBytes: 0,
        groups: [],
        skippedItems: [],
        skippedHardlinks: [],
      });
    });
  });
});
