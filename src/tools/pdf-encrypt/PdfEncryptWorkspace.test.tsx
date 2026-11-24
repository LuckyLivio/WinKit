import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import { PdfEncryptWorkspace } from "./PdfEncryptWorkspace";

const mockInspectPdfSecurity = vi.fn();
const mockEncryptPdf = vi.fn();
const mockPickSingleFile = vi.fn();
const mockSuggestSafeSiblingPath = vi.fn();

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    inspectPdfSecurity: (...args: unknown[]) => mockInspectPdfSecurity(...args),
    encryptPdf: (...args: unknown[]) => mockEncryptPdf(...args),
    pickSingleFile: (...args: unknown[]) => mockPickSingleFile(...args),
    suggestSafeSiblingPath: (...args: unknown[]) => mockSuggestSafeSiblingPath(...args),
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribePdfTaskProgress: () => Promise.resolve(() => {}),
  };
});

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
        <PdfEncryptWorkspace />
      </PdfSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("PdfEncryptWorkspace (P15)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates matching passwords, encrypts via AES-256, and clears local password inputs after export", async () => {
    const user = userEvent.setup();
    mockPickSingleFile.mockResolvedValue("C:\\Docs\\contract.pdf");
    mockInspectPdfSecurity.mockResolvedValue({
      path: "C:\\Docs\\contract.pdf",
      fileName: "contract.pdf",
      byteLength: 42000,
      status: "unencrypted",
      isEncrypted: false,
      requiresOpenPassword: false,
      hasOwnerRestrictions: false,
      encryptionRevision: null,
      encryptionLabel: null,
      printPermission: null,
      allowCopy: null,
      allowModify: null,
      pageCount: 3,
      hasSignatures: false,
      signatureCount: 0,
      warnings: [],
    });
    mockSuggestSafeSiblingPath.mockResolvedValue("C:\\Docs\\contract_encrypted.pdf");
    mockEncryptPdf.mockResolvedValue({
      outputPath: "C:\\Docs\\contract_encrypted.pdf",
      byteLength: 44100,
      pageCount: 3,
      algorithm: "AES-256 (PDF 2.0 R6)",
      hasOpenPassword: true,
      usedGeneratedOwnerPassword: true,
      printPermission: "low",
      allowCopy: false,
      allowModify: "none",
      signatureInvalidated: false,
      warnings: [],
    });

    renderWorkspace();
    await user.click(screen.getByRole("button", { name: /选择 PDF 文件/ }));

    await waitFor(() => {
      expect(screen.getByText("contract.pdf")).toBeInTheDocument();
    });

    const pwInput = screen.getByLabelText("打开密码（User Password）");
    const confirmInput = screen.getByLabelText("确认打开密码");
    await user.type(pwInput, "中文密码#2026");
    await user.type(confirmInput, "mismatch");
    expect(screen.getByRole("button", { name: /加密并导出 PDF/ })).toBeDisabled();

    await user.clear(confirmInput);
    await user.type(confirmInput, "中文密码#2026");
    await user.selectOptions(screen.getByLabelText("打印权限"), "low");
    await user.click(screen.getByLabelText("允许复制文本与图像"));

    const submitBtn = screen.getByRole("button", { name: /加密并导出 PDF/ });
    expect(submitBtn).toBeEnabled();
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockEncryptPdf).toHaveBeenCalledWith(
        expect.stringMatching(/^p15-/),
        expect.objectContaining({
          inputPath: "C:\\Docs\\contract.pdf",
          outputPath: "C:\\Docs\\contract_encrypted.pdf",
          userPassword: "中文密码#2026",
          ownerPassword: null,
          printPermission: "low",
          allowCopy: false,
        }),
      );
    });

    expect(screen.getByText(/加密完成并已通过独立校验/)).toBeInTheDocument();
    expect(pwInput).toHaveValue("");
    expect(confirmInput).toHaveValue("");
  });
});
