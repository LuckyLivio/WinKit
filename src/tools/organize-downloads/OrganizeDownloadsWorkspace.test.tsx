import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { OrganizeDownloadsWorkspace } from "./OrganizeDownloadsWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    pickSingleDirectory: vi.fn(),
    previewOrganizeDownloads: vi.fn(),
    executeOrganizeDownloads: vi.fn(),
    openLocalDirectory: vi.fn(),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
    subscribeFileDrop: vi.fn(async () => () => {}),
  };
});

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <OrganizeDownloadsWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("OrganizeDownloadsWorkspace (F05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never auto-scans on mount, previews selected folder, confirms move, and opens target folder", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("D:\\TempPics");
    vi.mocked(tauriBridge.previewOrganizeDownloads)
      .mockResolvedValueOnce({
        folderPath: "D:\\TempPics",
        volumeSupportsAds: true,
        totalImageCount: 2,
        nonImageCount: 0,
        readyCount: 1,
        alreadyOrganizedCount: 0,
        stayInPlaceCount: 1,
        conflictCount: 0,
        items: [
          {
            sourcePath: "D:\\TempPics\\tweet.png",
            fileName: "tweet.png",
            byteLength: 2048,
            modifiedMs: 1700000000000,
            fileIdKey: "1:2",
            contentSha256: "abcdef012345",
            zoneId: 3,
            sourceField: "host_url",
            detectedDomain: "pbs.twimg.com",
            mappedSiteName: "X (Twitter)",
            targetFolderName: "X (Twitter)",
            targetRelPath: "X (Twitter)\\tweet.png",
            status: "ready",
            action: "move",
            reason: null,
          },
          {
            sourcePath: "D:\\TempPics\\local.png",
            fileName: "local.png",
            byteLength: 1024,
            modifiedMs: 1700000000001,
            fileIdKey: null,
            contentSha256: null,
            zoneId: null,
            sourceField: null,
            detectedDomain: null,
            mappedSiteName: null,
            targetFolderName: null,
            targetRelPath: null,
            status: "no_source",
            action: "stay_in_place",
            reason: "No Zone.Identifier download source stream",
          },
        ],
      })
      .mockResolvedValueOnce({
        folderPath: "D:\\TempPics",
        volumeSupportsAds: true,
        totalImageCount: 2,
        nonImageCount: 0,
        readyCount: 0,
        alreadyOrganizedCount: 1,
        stayInPlaceCount: 1,
        conflictCount: 0,
        items: [
          {
            sourcePath: "D:\\TempPics\\X (Twitter)\\tweet.png",
            fileName: "tweet.png",
            byteLength: 2048,
            modifiedMs: 1700000000000,
            fileIdKey: null,
            contentSha256: null,
            zoneId: 3,
            sourceField: "host_url",
            detectedDomain: "pbs.twimg.com",
            mappedSiteName: "X (Twitter)",
            targetFolderName: "X (Twitter)",
            targetRelPath: "X (Twitter)\\tweet.png",
            status: "already_organized",
            action: "already_organized",
            reason: "Already in matching source folder",
          },
        ],
      });

    vi.mocked(tauriBridge.executeOrganizeDownloads).mockResolvedValue({
      folderPath: "D:\\TempPics",
      movedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      outcomes: [
        {
          sourcePath: "D:\\TempPics\\tweet.png",
          targetPath: "D:\\TempPics\\X (Twitter)\\tweet.png",
          fileName: "tweet.png",
          status: "moved",
          reason: null,
        },
      ],
    });

    renderWorkspace();

    // Must NOT auto-scan on open
    expect(tauriBridge.previewOrganizeDownloads).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "选择图片文件夹…" }));
    await waitFor(() => {
      expect(screen.getByText("X (Twitter)\\tweet.png")).toBeInTheDocument();
    });
    expect(screen.getByText("无来源（保持原位）")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始归档 (1 张)" }));
    await user.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() => {
      expect(screen.getByText("已移动 1 张 · 跳过 0 张 · 失败 0 张")).toBeInTheDocument();
    });

    const openBtns = screen.getAllByRole("button", { name: "打开目标文件夹" });
    await user.click(openBtns[0]!);
    expect(tauriBridge.openLocalDirectory).toHaveBeenCalledWith("D:\\TempPics");
  });
});
