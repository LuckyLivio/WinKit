import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageRedactWorkspace } from "../image-redact/ImageRedactWorkspace";
import { BlurFacesWorkspace } from "./BlurFacesWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    pickMultipleFiles: vi.fn(),
    pickSingleFile: vi.fn(),
    pickSingleDirectory: vi.fn(),
    pickSaveFilePath: vi.fn(),
    inspectBatchImages: vi.fn(),
    loadFileAsImageAsset: vi.fn(),
    readClipboardImageAsAsset: vi.fn(),
    detectFacesInAsset: vi.fn(),
    detectFacesInFile: vi.fn(),
    applyImageRedactionsToAsset: vi.fn(),
    exportRedactedImageFile: vi.fn(),
    copyImageAssetToClipboard: vi.fn(),
    blurFacesBatch: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeImageBatchProgress: vi.fn(async () => () => {}),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
    openLocalDirectory: vi.fn(),
  };
});

function renderWithProviders(ui: React.ReactElement, onNavigateToTool?: (id: string) => void) {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider onNavigateToTool={onNavigateToTool}>{ui}</SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("I02 BlurFacesWorkspace & I11 Detect Faces integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("distinguishes detected faces, no-faces, and failed files, supports per-face toggle, undo, compare, handoff, and separate batch counts", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue([
      "C:\\Temp\\group.jpg",
      "C:\\Temp\\landscape.jpg",
      "C:\\Temp\\corrupt.jpg",
    ]);
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [
        {
          path: "C:\\Temp\\group.jpg",
          fileName: "group.jpg",
          byteLength: 120000,
          format: "jpeg",
          rawWidth: 800,
          rawHeight: 600,
          exifOrientation: 1,
          displayWidth: 800,
          displayHeight: 600,
          hasAlpha: false,
          isAnimated: false,
          pageCount: 1,
          hasIccProfile: false,
          metadataFlags: {
            hasExif: false,
            hasGps: false,
            hasXmp: false,
            hasIptc: false,
            hasIcc: false,
            hasComments: false,
            hasCameraInfo: false,
            hasDatetime: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          warnings: [],
          error: null,
        },
        {
          path: "C:\\Temp\\landscape.jpg",
          fileName: "landscape.jpg",
          byteLength: 80000,
          format: "jpeg",
          rawWidth: 640,
          rawHeight: 480,
          exifOrientation: 1,
          displayWidth: 640,
          displayHeight: 480,
          hasAlpha: false,
          isAnimated: false,
          pageCount: 1,
          hasIccProfile: false,
          metadataFlags: {
            hasExif: false,
            hasGps: false,
            hasXmp: false,
            hasIptc: false,
            hasIcc: false,
            hasComments: false,
            hasCameraInfo: false,
            hasDatetime: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          warnings: [],
          error: null,
        },
        {
          path: "C:\\Temp\\corrupt.jpg",
          fileName: "corrupt.jpg",
          byteLength: 24,
          format: "unknown",
          rawWidth: 0,
          rawHeight: 0,
          exifOrientation: 1,
          displayWidth: 0,
          displayHeight: 0,
          hasAlpha: false,
          isAnimated: false,
          pageCount: 0,
          hasIccProfile: false,
          metadataFlags: {
            hasExif: false,
            hasGps: false,
            hasXmp: false,
            hasIptc: false,
            hasIcc: false,
            hasComments: false,
            hasCameraInfo: false,
            hasDatetime: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl: null,
          warnings: [],
          error: "Corrupted JPEG header",
        },
      ],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: false,
        encodeAvailable: false,
        decodeNote: "",
        encodeNote: "",
      },
    });

    vi.mocked(tauriBridge.loadFileAsImageAsset).mockResolvedValue({
      assetId: "mem-group-1",
      label: "group.jpg",
      width: 800,
      height: 600,
      hasAlpha: false,
      byteLength: 50000,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });

    vi.mocked(tauriBridge.detectFacesInAsset).mockResolvedValue({
      status: "detected",
      faces: [
        { x: 100, y: 80, width: 90, height: 110, confidence: 0.94 },
        { x: 340, y: 95, width: 88, height: 105, confidence: 0.89 },
      ],
      imageWidth: 800,
      imageHeight: 600,
      elapsedMs: 42,
      modelName: "YuNet 2023mar (MIT, CPU)",
    });

    vi.mocked(tauriBridge.detectFacesInFile).mockResolvedValue({
      status: "no_faces",
      faces: [],
      imageWidth: 640,
      imageHeight: 480,
      elapsedMs: 31,
      modelName: "YuNet 2023mar (MIT, CPU)",
    });

    renderWithProviders(<BlurFacesWorkspace />, onNavigate);

    // Add 3 photos
    await user.click(screen.getAllByRole("button", { name: "添加图片" })[0]!);

    // Active photo auto-detects 2 faces; corrupt photo immediately shows 检测失败
    await waitFor(() => {
      expect(screen.getByText("检测到 2 张脸")).toBeInTheDocument();
    });
    expect(screen.getByText("检测失败")).toBeInTheDocument();
    expect(screen.getByText("人脸选区 (2/2)")).toBeInTheDocument();

    // Detect remaining pending photo (landscape.jpg -> 未检测到人脸)
    await user.click(screen.getByRole("button", { name: /全部检测/ }));
    await waitFor(() => {
      expect(screen.getByText("未检测到人脸")).toBeInTheDocument();
    });

    // Uncheck face #2 -> only 1 face enabled
    await user.click(screen.getByRole("checkbox", { name: "Toggle face #2" }));
    expect(screen.getByText("人脸选区 (1/2)")).toBeInTheDocument();

    // Switch redaction mode to Solid Cover & test Before/After compare toggle
    await user.click(screen.getByRole("button", { name: "实色遮盖" }));
    await user.click(screen.getByRole("button", { name: "前后对照" }));
    expect(screen.getByText("正在查看原图（未打码）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "前后对照" }));

    // Batch export with exportUntouchedCopies checked -> passes edited 1-face override for group.jpg
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("C:\\Temp\\out");
    vi.mocked(tauriBridge.blurFacesBatch).mockResolvedValue({
      taskId: "i02-task",
      toolId: "I02",
      outputDir: "C:\\Temp\\out",
      cancelled: false,
      succeededCount: 1,
      keptOriginalCount: 1,
      skippedCount: 0,
      failedCount: 1,
      totalOriginalBytes: 200000,
      totalOutputBytes: 180000,
      items: [],
    });

    await user.click(screen.getByRole("button", { name: "选择目录" }));
    await user.click(screen.getByRole("checkbox", { name: /原样副本/ }));
    await user.click(screen.getByRole("button", { name: "批量导出 (3)" }));

    await waitFor(() => {
      expect(tauriBridge.blurFacesBatch).toHaveBeenCalledTimes(1);
    });
    const batchCall = vi.mocked(tauriBridge.blurFacesBatch).mock.calls[0]!;
    expect(batchCall[1].exportUntouchedCopies).toBe(true);
    expect(batchCall[1].items[0]?.overrideRegions).toHaveLength(1);
    expect(batchCall[1].items[0]?.overrideRegions?.[0]?.kind).toBe("solid");
    expect(
      screen.getByText(/已打码 1 张 · 原样副本 1 张 · 未检出跳过 0 张 · 失败 1 张/),
    ).toBeInTheDocument();

    // Handoff to I12 bakes the 1 enabled solid region destructively before switching tool
    vi.mocked(tauriBridge.applyImageRedactionsToAsset).mockResolvedValue({
      assetId: "mem-baked-2",
      label: "group.jpg",
      width: 800,
      height: 600,
      hasAlpha: false,
      byteLength: 51000,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    await user.click(screen.getByRole("button", { name: "送往批注 (I12)" }));
    await waitFor(() => {
      expect(tauriBridge.applyImageRedactionsToAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "mem-group-1",
          regions: [expect.objectContaining({ kind: "solid", x: 100, y: 80 })],
        }),
      );
      expect(onNavigate).toHaveBeenCalledWith("I12");
    });
  });

  it("allows I11 ImageRedactWorkspace to run Detect Faces and append editable regions", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.readClipboardImageAsAsset).mockResolvedValue({
      assetId: "mem-i11-1",
      label: "clip.png",
      width: 600,
      height: 400,
      hasAlpha: false,
      byteLength: 30000,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    vi.mocked(tauriBridge.detectFacesInAsset).mockResolvedValue({
      status: "detected",
      faces: [{ x: 120, y: 60, width: 80, height: 95, confidence: 0.91 }],
      imageWidth: 600,
      imageHeight: 400,
      elapsedMs: 36,
      modelName: "YuNet 2023mar (MIT, CPU)",
    });

    renderWithProviders(<ImageRedactWorkspace />);

    await user.click(screen.getAllByRole("button", { name: "粘贴图片" })[0]!);
    await waitFor(() => {
      expect(screen.getByTestId("i11-detect-faces-btn")).not.toBeDisabled();
    });

    await user.click(screen.getByTestId("i11-detect-faces-btn"));
    await waitFor(() => {
      expect(screen.getByText(/离线检测到 1 张人脸/)).toBeInTheDocument();
      expect(screen.getByText(/1 处遮盖/)).toBeInTheDocument();
    });
  });
});
