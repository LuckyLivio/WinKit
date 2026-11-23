import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageResizeWorkspace } from "./ImageResizeWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    inspectBatchImages: vi.fn(),
    previewRotateImage: vi.fn(),
    resizeImagesBatch: vi.fn(),
    pickMultipleFiles: vi.fn(),
    pickMultipleDirectories: vi.fn(),
    pickSingleDirectory: vi.fn(),
    openLocalDirectory: vi.fn(),
    subscribeImageBatchProgress: vi.fn(async () => () => {}),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
    subscribeFileDrop: vi.fn(async () => () => {}),
  };
});

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <ImageResizeWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("ImageResizeWorkspace (I07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows live target dimensions on EXIF-oriented portrait photo and updates when aspect lock changes", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["D:\\Pics\\phone.jpg"]);
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [
        {
          path: "D:\\Pics\\phone.jpg",
          fileName: "phone.jpg",
          byteLength: 50000,
          format: "jpeg",
          rawWidth: 4000,
          rawHeight: 2000,
          exifOrientation: 6,
          displayWidth: 2000,
          displayHeight: 4000,
          hasAlpha: false,
          isAnimated: false,
          pageCount: 1,
          hasIccProfile: true,
          metadataFlags: {
            hasExif: true,
            hasGps: false,
            hasXmp: false,
            hasIptc: false,
            hasIcc: true,
            hasComments: false,
            hasCameraInfo: false,
            hasDatetime: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl: "data:image/jpeg;base64,AA==",
          warnings: [],
          error: null,
        },
      ],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: true,
        encodeAvailable: true,
        decodeNote: "ok",
        encodeNote: "ok",
      },
    });
    vi.mocked(tauriBridge.previewRotateImage).mockResolvedValue({
      previewDataUrl: "data:image/jpeg;base64,AA==",
      sourceExifOrientation: 6,
      displayWidth: 2000,
      displayHeight: 4000,
      outputWidth: 2000,
      outputHeight: 4000,
    });

    renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: "添加图片" })[0]!);

    // Default mode longest_edge = 1920 on 2000x4000 display dims -> 960x1920
    await waitFor(() => {
      expect(screen.getByText("2000×4000 → 960×1920")).toBeInTheDocument();
    });

    // Switch to exact mode (default 1280x720 with keepAspectRatio=true -> 360x720)
    await user.click(screen.getByRole("button", { name: "指定宽高" }));
    expect(screen.getByText("2000×4000 → 360×720")).toBeInTheDocument();

    // Uncheck keepAspectRatio -> updates live to 1280x720!
    await user.click(screen.getByRole("checkbox", { name: /保持原始纵横比/ }));
    expect(screen.getByText("2000×4000 → 1280×720")).toBeInTheDocument();
  });
});
