import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ArchiveWorkspace } from "./ArchiveWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    pickMultipleFiles: vi.fn(),
    pickMultipleDirectories: vi.fn(),
    pickSingleDirectory: vi.fn(),
    pickSaveFilePath: vi.fn(),
    inspectArchive: vi.fn(),
    extractArchivesBatch: vi.fn(),
    createArchive: vi.fn(),
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
        <ArchiveWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("ArchiveWorkspace (F04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inspects added encrypted archive, retries password, extracts, and opens output folder", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["D:\\Packs\\secret.zip"]);
    vi.mocked(tauriBridge.inspectArchive).mockResolvedValue({
      archivePath: "D:\\Packs\\secret.zip",
      archiveName: "secret.zip",
      format: "zip",
      archiveByteLength: 4096,
      needsPassword: true,
      encryptedEntryCount: 1,
      totalEntries: 1,
      totalUncompressedBytes: 120,
      entriesTruncated: false,
      entries: [
        {
          path: "资料/报告.txt",
          isDir: false,
          isSymlink: false,
          isMacosMetadata: false,
          compressedSize: 90,
          uncompressedSize: 120,
          encrypted: true,
        },
      ],
    });
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("D:\\Out");
    vi.mocked(tauriBridge.extractArchivesBatch)
      .mockResolvedValueOnce({
        taskId: "t1",
        outputParentDir: "D:\\Out",
        cancelled: false,
        succeededCount: 0,
        failedCount: 1,
        items: [
          {
            archivePath: "D:\\Packs\\secret.zip",
            archiveName: "secret.zip",
            format: "zip",
            status: "wrong_password",
            outputDir: null,
            extractedFiles: 0,
            extractedDirs: 0,
            skippedEntries: 0,
            writtenBytes: 0,
            message: "Incorrect password",
          },
        ],
      })
      .mockResolvedValueOnce({
        taskId: "t2",
        outputParentDir: "D:\\Out",
        cancelled: false,
        succeededCount: 1,
        failedCount: 0,
        items: [
          {
            archivePath: "D:\\Packs\\secret.zip",
            archiveName: "secret.zip",
            format: "zip",
            status: "extracted",
            outputDir: "D:\\Out\\secret",
            extractedFiles: 1,
            extractedDirs: 1,
            skippedEntries: 0,
            writtenBytes: 120,
            message: null,
          },
        ],
      });

    renderWorkspace();

    await user.click(screen.getByRole("button", { name: "添加压缩包" }));
    await waitFor(() => {
      expect(screen.getByText("资料/报告.txt")).toBeInTheDocument();
    });

    const pwdInput = screen.getByLabelText("secret.zip password");
    await user.type(pwdInput, "wrong-pwd");

    await user.click(screen.getByRole("button", { name: "选择输出目录…" }));
    await user.click(screen.getByRole("button", { name: "开始解压" }));

    await waitFor(() => {
      expect(screen.getByText("密码错误")).toBeInTheDocument();
    });

    // Retry with corrected password
    await user.clear(pwdInput);
    await user.type(pwdInput, "RightPwd2026!");
    await user.click(screen.getByRole("button", { name: /重试密码\/失败项/ }));

    await waitFor(() => {
      expect(screen.getByText("已解压")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "打开输出目录" }));
    expect(tauriBridge.openLocalDirectory).toHaveBeenCalledWith("D:\\Out\\secret");
  });

  it("validates encrypted ZIP password match and creates archive in Create tab", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["D:\\Docs\\notes.txt"]);
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue("D:\\Out\\notes.zip");
    vi.mocked(tauriBridge.createArchive).mockResolvedValue({
      taskId: "c1",
      outputPath: "D:\\Out\\notes.zip",
      outputParentDir: "D:\\Out",
      format: "zip",
      entryCount: 1,
      skippedCount: 0,
      outputByteLength: 512,
    });

    renderWorkspace();
    await user.click(screen.getByRole("tab", { name: "创建压缩包" }));
    await user.click(screen.getByRole("button", { name: "添加文件" }));

    await user.selectOptions(screen.getByLabelText("压缩格式"), "zip_aes256");
    await user.type(screen.getByLabelText(/加密密码/), "Secret#2026");
    await user.type(screen.getByLabelText("确认密码"), "Mismatch");
    expect(screen.getByText("两次输入的密码不一致。")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("确认密码"));
    await user.type(screen.getByLabelText("确认密码"), "Secret#2026");

    await user.click(screen.getByRole("button", { name: "选择保存路径…" }));
    await user.click(screen.getByRole("button", { name: "开始创建压缩包" }));

    await waitFor(() => {
      expect(screen.getByText("压缩包创建完成")).toBeInTheDocument();
    });
    expect(tauriBridge.createArchive).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        format: "zip_aes256",
        password: "Secret#2026",
        overwrite: false,
      }),
    );
  });
});
