import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as bridge from "../../lib/tauriBridge";
import type { MattingModelStatus, RemoveBackgroundResult } from "../../lib/tauriBridge";
import { RemoveBackgroundWorkspace } from "./RemoveBackgroundWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMattingModelStatus: vi.fn(),
    installManagedMattingModel: vi.fn(),
    setMattingModelCustomDir: vi.fn(),
    removeManagedMattingModel: vi.fn(),
    subscribeMattingSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeMattingProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    pickSingleFile: vi.fn(),
    pickSingleDirectory: vi.fn(),
    pickSaveFilePath: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    inspectBeautifierSourceImage: vi.fn(),
    removeImageBackground: vi.fn(),
    exportMattingResult: vi.fn(),
    copyMattingResultToClipboard: vi.fn(),
    cancelBackendTask: vi.fn().mockResolvedValue(true),
    readClipboardImageAsAsset: vi.fn(),
    getImageAsset: vi.fn(),
    openLocalDirectory: vi.fn(),
  };
});

const PINNED_SPEC = {
  modelId: "birefnet-lite-512-fp16-v1",
  displayName: "BiRefNet_lite 512 FP16 (Offline CPU)",
  version: "BiRefNet_lite 512 FP16 (962e679)",
  sourceName: "ZhengPeng7/BiRefNet_lite -> studioludens/birefnet-lite-512 (ONNX FP16)",
  releaseUrl: "https://huggingface.co/studioludens/birefnet-lite-512",
  modelUrl:
    "https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model_fp16.onnx",
  modelFileName: "birefnet-lite-512-fp16.onnx",
  modelBytes: 98_484_532,
  modelSha256: "eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516",
  licenseSummary: "BiRefNet_lite (Code & Weights): MIT; ONNX Runtime: MIT",
};

const MISSING_STATUS: MattingModelStatus = {
  ready: false,
  runtimeReady: true,
  source: "missing",
  mode: "managed",
  customDir: null,
  installDir: "C:\\Users\\Test\\matting-models\\birefnet-lite-512-fp16-v1",
  activeModelDir: null,
  installedBytes: null,
  licensePath: null,
  error: null,
  spec: PINNED_SPEC,
};

const READY_STATUS: MattingModelStatus = {
  ...MISSING_STATUS,
  ready: true,
  source: "managed",
  activeModelDir: MISSING_STATUS.installDir,
  installedBytes: 98_484_532,
  licensePath: `${MISSING_STATUS.installDir}\\LICENSE-birefnet-lite.txt`,
};

const SAMPLE_RESULT: RemoveBackgroundResult = {
  resultId: "matting-1",
  cutoutAssetId: "mem-img-10",
  fileName: "portrait.jpg",
  sourcePath: "C:\\Photos\\portrait.jpg",
  width: 1200,
  height: 1600,
  rawWidth: 1600,
  rawHeight: 1200,
  exifOrientation: 6,
  sourceHasAlpha: false,
  preservedSourceAlpha: false,
  subjectBbox: { x: 200, y: 100, width: 800, height: 1400 },
  foregroundRatio: 0.42,
  softEdgeRatio: 0.015,
  elapsedMs: 2450,
  originalPreviewDataUrl: "data:image/jpeg;base64,orig",
  cutoutPreviewDataUrl: "data:image/png;base64,cutout",
  warnings: [],
};

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <RemoveBackgroundWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("RemoveBackgroundWorkspace (I04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.subscribeMattingSetupProgress).mockResolvedValue(() => {});
    vi.mocked(bridge.subscribeMattingProgress).mockResolvedValue(() => {});
    vi.mocked(bridge.subscribeFileDrop).mockResolvedValue(() => {});
    vi.mocked(bridge.cancelBackendTask).mockResolvedValue(true);
  });

  it("shows first-run missing-model guidance with zero auto-download and disables start", async () => {
    vi.mocked(bridge.getMattingModelStatus).mockResolvedValue(MISSING_STATUS);

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByTestId("matting-model-setup-card")).toBeInTheDocument();
    });
    expect(bridge.installManagedMattingModel).not.toHaveBeenCalled();
    expect(screen.getByTestId("matting-download-model-btn")).toBeEnabled();
    expect(screen.getByTestId("i04-start-btn")).toBeDisabled();
  });

  it("runs offline matting, toggles solid color & tight crop dimensions, and binds overwrite confirmation to the exact request", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.getMattingModelStatus).mockResolvedValue(READY_STATUS);
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Photos\\portrait.jpg");
    vi.mocked(bridge.inspectBeautifierSourceImage).mockResolvedValue({
      path: "C:\\Photos\\portrait.jpg",
      fileName: "portrait.jpg",
      width: 1200,
      height: 1600,
      hasAlpha: false,
      previewDataUrl: "data:image/jpeg;base64,orig",
    });
    vi.mocked(bridge.removeImageBackground).mockResolvedValue(SAMPLE_RESULT);
    vi.mocked(bridge.suggestSafeSiblingPath).mockResolvedValue("C:\\Photos\\portrait_cutout.png");
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("C:\\Photos\\existing.png");
    vi.mocked(bridge.exportMattingResult)
      .mockRejectedValueOnce({ code: "TARGET_ALREADY_EXISTS", message: "Target exists" })
      .mockRejectedValueOnce({ code: "TARGET_ALREADY_EXISTS", message: "Target exists" })
      .mockResolvedValueOnce({
        outputPath: "C:\\Photos\\existing.png",
        width: 832,
        height: 1432,
        byteLength: 123_456,
        hasAlpha: false,
        cropped: true,
        format: "jpeg",
      });

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByTestId("matting-model-compact-bar")).toBeInTheDocument();
    });

    // Pick image & run offline cutout
    await user.click(screen.getByTestId("i04-pick-image-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i04-start-btn")).toBeEnabled();
    });
    await user.click(screen.getByTestId("i04-start-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("i04-split-slider")).toBeInTheDocument();
    });
    expect(screen.getByTestId("i04-output-dims")).toHaveTextContent("1200 × 1600");
    // Transparent mode disables JPEG
    expect(screen.getByTestId("i04-fmt-jpeg")).toBeDisabled();

    // Switch to Solid Color + JPEG + Tight Crop with 16px padding
    await user.click(screen.getByTestId("i04-bg-solid"));
    expect(screen.getByTestId("i04-fmt-jpeg")).toBeEnabled();
    await user.click(screen.getByTestId("i04-fmt-jpeg"));
    await user.click(screen.getByTestId("i04-crop-toggle"));
    await user.click(screen.getByRole("button", { name: "16px" }));
    expect(screen.getByTestId("i04-output-dims")).toHaveTextContent("832 × 1432");
    expect(screen.getByTestId("i04-crop-overlay")).toBeInTheDocument();

    // Export hits existing file -> opens overwrite ConfirmDialog
    await user.click(screen.getByTestId("i04-export-btn"));
    await waitFor(() => {
      expect(screen.getByText("覆盖已存在的文件？")).toBeInTheDocument();
    });

    // Changing background color while dialog is open invalidates stale confirmation
    await user.click(screen.getByTestId("i04-swatch-2563EB"));
    await waitFor(() => {
      expect(screen.queryByText("覆盖已存在的文件？")).not.toBeInTheDocument();
    });

    // Re-export and confirm overwrite with exact request
    await user.click(screen.getByTestId("i04-export-btn"));
    await waitFor(() => {
      expect(screen.getByText("覆盖已存在的文件？")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "确认覆盖" }));

    await waitFor(() => {
      expect(screen.getByTestId("i04-saved-banner")).toBeInTheDocument();
    });
    const lastCall = vi.mocked(bridge.exportMattingResult).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({
      resultId: "matting-1",
      outputPath: "C:\\Photos\\existing.png",
      overwrite: true,
      backgroundMode: "solid_color",
      backgroundHex: "#2563EB",
      format: "jpeg",
      cropToSubject: true,
      cropPaddingPx: 16,
    });
  });

  it("cancels in-flight matting and recovers cleanly for immediate retry", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.getMattingModelStatus).mockResolvedValue(READY_STATUS);
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Photos\\portrait.jpg");
    vi.mocked(bridge.inspectBeautifierSourceImage).mockResolvedValue({
      path: "C:\\Photos\\portrait.jpg",
      fileName: "portrait.jpg",
      width: 1200,
      height: 1600,
      hasAlpha: false,
      previewDataUrl: "data:image/jpeg;base64,orig",
    });

    let rejectFirst!: (reason?: unknown) => void;
    vi.mocked(bridge.removeImageBackground)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(SAMPLE_RESULT);

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("matting-model-compact-bar")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("i04-pick-image-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i04-start-btn")).toBeEnabled();
    });

    await user.click(screen.getByTestId("i04-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i04-cancel-btn")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("i04-cancel-btn"));
    expect(bridge.cancelBackendTask).toHaveBeenCalledTimes(1);
    rejectFirst({ code: "TASK_CANCELLED", message: "Cancelled" });

    await waitFor(() => {
      expect(screen.getByTestId("i04-start-btn")).toBeEnabled();
    });

    // Immediate retry succeeds
    await user.click(screen.getByTestId("i04-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i04-split-slider")).toBeInTheDocument();
    });
  });

  it("preserves loaded cutout result and export settings across tool navigation unmount/remount", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.getMattingModelStatus).mockResolvedValue(READY_STATUS);
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Photos\\portrait.jpg");
    vi.mocked(bridge.inspectBeautifierSourceImage).mockResolvedValue({
      path: "C:\\Photos\\portrait.jpg",
      fileName: "portrait.jpg",
      width: 1200,
      height: 1600,
      hasAlpha: false,
      previewDataUrl: "data:image/jpeg;base64,orig",
    });
    vi.mocked(bridge.removeImageBackground).mockResolvedValue(SAMPLE_RESULT);

    let showTool = true;
    const { rerender } = render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          {showTool ? <RemoveBackgroundWorkspace /> : <div>Other Tool</div>}
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("matting-model-compact-bar")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("i04-pick-image-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i04-start-btn")).toBeEnabled();
    });
    await user.click(screen.getByTestId("i04-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i04-split-slider")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("i04-crop-toggle"));

    // Navigate away and return
    showTool = false;
    rerender(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          {showTool ? <RemoveBackgroundWorkspace /> : <div>Other Tool</div>}
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );
    expect(screen.getByText("Other Tool")).toBeInTheDocument();

    showTool = true;
    rerender(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          {showTool ? <RemoveBackgroundWorkspace /> : <div>Other Tool</div>}
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("i04-split-slider")).toBeInTheDocument();
    });
    expect(screen.getByTestId("i04-crop-toggle")).toBeChecked();
  });
});
