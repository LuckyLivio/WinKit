import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import type { BatchImageJobResponse, InspectedImageItem } from "../image-batch/imageBatchModel";
import { ImageMetadataWorkspace } from "./ImageMetadataWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...orig,
    pickMultipleFiles: vi.fn(),
    pickMultipleDirectories: vi.fn(),
    pickSingleDirectory: vi.fn(),
    inspectBatchImages: vi.fn(),
    stripImagesMetadataBatch: vi.fn(),
    cancelBackendTask: vi.fn(),
    openLocalDirectory: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeImageBatchProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeTaskProgress: vi.fn(async () => () => {}),
    subscribeNativeCloseRequest: vi.fn(async () => () => {}),
  };
});

const DIRTY_JPEG: InspectedImageItem = {
  path: "C:\\Temp\\WinKitDemo\\gps_photo.jpg",
  fileName: "gps_photo.jpg",
  byteLength: 245760,
  format: "jpeg",
  rawWidth: 4032,
  rawHeight: 3024,
  exifOrientation: 6,
  displayWidth: 3024,
  displayHeight: 4032,
  hasAlpha: false,
  isAnimated: false,
  pageCount: 1,
  hasIccProfile: true,
  metadataFlags: {
    hasExif: true,
    hasGps: true,
    hasXmp: true,
    hasIptc: true,
    hasIcc: true,
    hasComments: false,
    hasCameraInfo: true,
    hasDatetime: true,
    duplicateSegmentCount: 2,
    tagHighlights: ["GPS", "Camera", "DateTime", "EXIF", "XMP", "IPTC"],
  },
  thumbnailDataUrl: "data:image/jpeg;base64,/9j/4AAQ",
  warnings: [],
  error: null,
};

const UNSUPPORTED_HEIC: InspectedImageItem = {
  path: "C:\\Temp\\WinKitDemo\\phone.heic",
  fileName: "phone.heic",
  byteLength: 180000,
  format: "heic",
  rawWidth: 1200,
  rawHeight: 900,
  exifOrientation: 1,
  displayWidth: 1200,
  displayHeight: 900,
  hasAlpha: false,
  isAnimated: false,
  pageCount: 1,
  hasIccProfile: false,
  metadataFlags: {
    hasExif: true,
    hasGps: false,
    hasXmp: false,
    hasIptc: false,
    hasIcc: false,
    hasComments: false,
    hasCameraInfo: true,
    hasDatetime: false,
    duplicateSegmentCount: 0,
    tagHighlights: ["Camera", "EXIF"],
  },
  thumbnailDataUrl: "data:image/jpeg;base64,/9j/4AAQ",
  warnings: [],
  error: null,
};

describe("I09 ImageMetadataWorkspace & Cross-tool batch persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("displays detected GPS/XMP/IPTC/duplicate tags, defaults to keeping Orientation+ICC, warns on unsupported formats, and dispatches strip batch", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue([
      DIRTY_JPEG.path,
      UNSUPPORTED_HEIC.path,
    ]);
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("C:\\Temp\\WinKitDemo\\cleaned");
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [DIRTY_JPEG, UNSUPPORTED_HEIC],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: true,
        encodeAvailable: true,
        decodeNote: "OK",
        encodeNote: "OK",
      },
    });
    vi.mocked(tauriBridge.stripImagesMetadataBatch).mockResolvedValue({
      taskId: "i09-test",
      toolId: "I09",
      outputDir: "C:\\Temp\\WinKitDemo\\cleaned",
      cancelled: false,
      succeededCount: 1,
      keptOriginalCount: 0,
      skippedCount: 0,
      failedCount: 1,
      totalOriginalBytes: 425760,
      totalOutputBytes: 240000,
      items: [
        {
          sourcePath: DIRTY_JPEG.path,
          fileName: DIRTY_JPEG.fileName,
          outputPath: "C:\\Temp\\WinKitDemo\\cleaned\\gps_photo.jpg",
          status: "ok",
          originalBytes: 245760,
          outputBytes: 240000,
          savedPercent: 2.3,
          outputWidth: 4032,
          outputHeight: 3024,
          codecNote: "Kept: Orientation=6, ICC Profile",
          message: "Removed: EXIF (2), XMP (2), IPTC (1)",
        },
        {
          sourcePath: UNSUPPORTED_HEIC.path,
          fileName: UNSUPPORTED_HEIC.fileName,
          outputPath: null,
          status: "error",
          originalBytes: 180000,
          outputBytes: 0,
          savedPercent: 0,
          outputWidth: null,
          outputHeight: null,
          codecNote: null,
          message: "Container metadata stripping supports JPEG, PNG, WebP, and classic TIFF",
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <ImageMetadataWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getAllByRole("button", { name: "添加图片" })[0]!);
    await waitFor(() => expect(screen.getByText("含 2 处重复元数据段")).toBeInTheDocument());
    expect(screen.getByText("GPS 位置")).toBeInTheDocument();
    expect(screen.getByText("方向 Orientation=6")).toBeInTheDocument();
    expect(screen.getByText("含 ICC 色彩配置")).toBeInTheDocument();
    expect(screen.getByText("格式不支持")).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();

    await user.click(screen.getByRole("button", { name: "选择目录…" }));
    await user.click(screen.getByRole("button", { name: "批量清除并导出 (2 张)" }));

    await waitFor(() => expect(tauriBridge.stripImagesMetadataBatch).toHaveBeenCalledTimes(1));
    expect(tauriBridge.stripImagesMetadataBatch).toHaveBeenCalledWith(
      expect.stringMatching(/^i09-metadata-/),
      {
        sourcePaths: [DIRTY_JPEG.path, UNSUPPORTED_HEIC.path],
        outputDir: "C:\\Temp\\WinKitDemo\\cleaned",
        keepOrientation: true,
        keepColorProfile: true,
      },
    );
    expect(await screen.findByText(/成功 1/)).toBeInTheDocument();
    expect(screen.getByText(/失败 1/)).toBeInTheDocument();
  });

  it("preserves live image batch progress and cancel controls across tool navigation", async () => {
    const user = userEvent.setup();
    let resolveBatch!: (res: BatchImageJobResponse) => void;
    const pendingBatch = new Promise<BatchImageJobResponse>((resolve) => {
      resolveBatch = resolve;
    });

    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue([DIRTY_JPEG.path]);
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("C:\\Temp\\WinKitDemo\\cleaned");
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [DIRTY_JPEG],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: true,
        encodeAvailable: true,
        decodeNote: "OK",
        encodeNote: "OK",
      },
    });
    vi.mocked(tauriBridge.stripImagesMetadataBatch).mockReturnValue(pendingBatch);

    render(<App />);

    // Open I09 from sidebar
    await user.click(screen.getAllByRole("button", { name: /图片元数据清除/ })[0]!);
    await user.click(screen.getAllByRole("button", { name: "添加图片" })[0]!);
    await waitFor(() => expect(screen.getByText("GPS 位置")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "选择目录…" }));
    await user.click(screen.getByRole("button", { name: "批量清除并导出 (1 张)" }));

    // Running state visible with Cancel button
    expect(await screen.findByRole("button", { name: "取消任务" })).toBeInTheDocument();

    // Switch away to D01 JSON Formatter and return to I09
    await user.click(screen.getAllByRole("button", { name: /JSON 格式化与校验/ })[0]!);
    await user.click(screen.getAllByRole("button", { name: /图片元数据清除/ })[0]!);

    // Live running state and cancel button survived navigation!
    expect(screen.getByRole("button", { name: "取消任务" })).toBeInTheDocument();

    // Clicking cancel invokes cancelBackendTask with the active I09 task ID
    await user.click(screen.getByRole("button", { name: "取消任务" }));
    expect(tauriBridge.cancelBackendTask).toHaveBeenCalledWith(
      expect.stringMatching(/^i09-metadata-/),
    );

    // Cleanly settle promise
    resolveBatch({
      taskId: "i09-test",
      toolId: "I09",
      outputDir: "C:\\Temp\\WinKitDemo\\cleaned",
      cancelled: true,
      succeededCount: 0,
      keptOriginalCount: 0,
      skippedCount: 1,
      failedCount: 0,
      totalOriginalBytes: 0,
      totalOutputBytes: 0,
      items: [],
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull());
  });
});
