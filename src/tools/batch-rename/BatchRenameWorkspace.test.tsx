import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { BatchRenameWorkspace } from "./BatchRenameWorkspace";

function renderBatchRename(locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(
    <I18nContext.Provider value={{ locale, t: MESSAGES[locale], setLocale: () => {} }}>
      <SessionStoreProvider>
        <BatchRenameWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("F02 BatchRenameWorkspace UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads dropped folders, previews rules & conflicts, executes batch rename, and supports Undo", async () => {
    const user = userEvent.setup();
    let dropHandler: ((paths: string[]) => void) | null = null;

    vi.spyOn(tauriBridge, "getBatchRenameUndoStatus").mockResolvedValue({
      available: false,
      itemCount: 0,
      completedAtMs: null,
    });
    vi.spyOn(tauriBridge, "subscribeFileDrop").mockImplementation(async (handlers) => {
      dropHandler = handlers.onDropPaths;
      return () => {};
    });

    const inspectSpy = vi.spyOn(tauriBridge, "inspectBatchRenameSources").mockResolvedValue({
      entries: [
        {
          path: "D:\\Work\\draft_1.txt",
          parentDir: "D:\\Work",
          fileName: "draft_1.txt",
          byteLength: 512,
          createdMs: 1_700_000_000_000,
          modifiedMs: 1_700_000_000_000,
        },
        {
          path: "D:\\Work\\draft_2.txt",
          parentDir: "D:\\Work",
          fileName: "draft_2.txt",
          byteLength: 1024,
          createdMs: 1_700_000_100_000,
          modifiedMs: 1_700_000_100_000,
        },
      ],
      existingDirSiblings: {
        "D:\\Work": ["draft_1.txt", "draft_2.txt", "occupied.txt"],
      },
      skipped: [],
    });

    const executeSpy = vi.spyOn(tauriBridge, "executeBatchRename").mockResolvedValue({
      renamedCount: 2,
      items: [
        {
          oldPath: "D:\\Work\\draft_1.txt",
          newPath: "D:\\Work\\final_1.txt",
          oldName: "draft_1.txt",
          newName: "final_1.txt",
        },
        {
          oldPath: "D:\\Work\\draft_2.txt",
          newPath: "D:\\Work\\final_2.txt",
          oldName: "draft_2.txt",
          newName: "final_2.txt",
        },
      ],
      updatedInspection: {
        entries: [
          {
            path: "D:\\Work\\final_1.txt",
            parentDir: "D:\\Work",
            fileName: "final_1.txt",
            byteLength: 512,
            createdMs: 1_700_000_000_000,
            modifiedMs: 1_700_000_000_000,
          },
          {
            path: "D:\\Work\\final_2.txt",
            parentDir: "D:\\Work",
            fileName: "final_2.txt",
            byteLength: 1024,
            createdMs: 1_700_000_100_000,
            modifiedMs: 1_700_000_100_000,
          },
        ],
        existingDirSiblings: {
          "D:\\Work": ["final_1.txt", "final_2.txt", "occupied.txt"],
        },
        skipped: [],
      },
      undoStatus: {
        available: true,
        itemCount: 2,
        completedAtMs: 1_700_000_500_000,
      },
    });

    const undoSpy = vi.spyOn(tauriBridge, "undoLastBatchRename").mockResolvedValue({
      renamedCount: 2,
      items: [],
      updatedInspection: {
        entries: [
          {
            path: "D:\\Work\\draft_1.txt",
            parentDir: "D:\\Work",
            fileName: "draft_1.txt",
            byteLength: 512,
            createdMs: 1_700_000_000_000,
            modifiedMs: 1_700_000_000_000,
          },
          {
            path: "D:\\Work\\draft_2.txt",
            parentDir: "D:\\Work",
            fileName: "draft_2.txt",
            byteLength: 1024,
            createdMs: 1_700_000_100_000,
            modifiedMs: 1_700_000_100_000,
          },
        ],
        existingDirSiblings: {
          "D:\\Work": ["draft_1.txt", "draft_2.txt", "occupied.txt"],
        },
        skipped: [],
      },
      undoStatus: {
        available: false,
        itemCount: 0,
        completedAtMs: null,
      },
    });

    renderBatchRename("zh-CN");

    await waitFor(() => expect(dropHandler).not.toBeNull());
    await act(async () => {
      dropHandler?.(["D:\\Work"]);
    });

    expect(inspectSpy).toHaveBeenCalledWith(["D:\\Work"]);
    expect((await screen.findAllByText("draft_1.txt")).length).toBeGreaterThan(0);

    // Test external sibling collision blocking (`draft_1 -> occupied`)
    await user.type(screen.getByLabelText("查找"), "draft_1");
    await user.type(screen.getByLabelText("替换为"), "occupied");
    expect(screen.getByText("目标已存在")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行重命名/ })).toBeDisabled();

    // Test Windows reserved name blocking (`draft_1 -> CON`)
    await user.clear(screen.getByLabelText("替换为"));
    await user.type(screen.getByLabelText("替换为"), "CON");
    expect(screen.getByText("文件名无效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行重命名/ })).toBeDisabled();

    // Valid rename (`draft_ -> final_`)
    await user.clear(screen.getByLabelText("查找"));
    await user.type(screen.getByLabelText("查找"), "draft_");
    await user.clear(screen.getByLabelText("替换为"));
    await user.type(screen.getByLabelText("替换为"), "final_");

    const execBtn = screen.getByRole("button", { name: "执行重命名 (2)" });
    expect(execBtn).toBeEnabled();
    await user.click(execBtn);

    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已完成 2 个文件的重命名/)).toBeInTheDocument();
    expect(screen.getAllByText("final_1.txt").length).toBeGreaterThan(0);

    // Undo button is now enabled with count 2
    const undoBtn = screen.getByRole("button", { name: "撤销上一批 (2)" });
    expect(undoBtn).toBeEnabled();
    await user.click(undoBtn);

    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已撤销上一批操作/)).toBeInTheDocument();
    expect(screen.getAllByText("draft_1.txt").length).toBeGreaterThan(0);
  });

  it("displays clear protection message when Undo encounters an occupied original filename", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "getBatchRenameUndoStatus").mockResolvedValue({
      available: true,
      itemCount: 1,
      completedAtMs: 1_700_000_500_000,
    });
    vi.spyOn(tauriBridge, "subscribeFileDrop").mockResolvedValue(() => {});
    vi.spyOn(tauriBridge, "undoLastBatchRename").mockRejectedValue({
      code: "UNDO_TARGET_OCCUPIED",
      message:
        'Cannot undo batch: original filename "old.txt" is now occupied by another file. Existing files were left untouched.',
    });

    renderBatchRename("zh-CN");

    const undoBtn = await screen.findByRole("button", { name: "撤销上一批 (1)" });
    await user.click(undoBtn);

    expect(await screen.findByText(/原文件名已被其他新文件占用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销上一批 (1)" })).toBeEnabled();
  });
});
