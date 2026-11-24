import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import { PdfDecryptWorkspace } from "./PdfDecryptWorkspace";

const mockInspectPdfSecurity = vi.fn();
const mockDecryptPdf = vi.fn();
const mockPickSingleFile = vi.fn();
const mockSuggestSafeSiblingPath = vi.fn();

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    inspectPdfSecurity: (...args: unknown[]) => mockInspectPdfSecurity(...args),
    decryptPdf: (...args: unknown[]) => mockDecryptPdf(...args),
    pickSingleFile: (...args: unknown[]) => mockPickSingleFile(...args),
    suggestSafeSiblingPath: (...args: unknown[]) => mockSuggestSafeSiblingPath(...args),
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribePdfTaskProgress: () => Promise.resolve(() => {}),
  };
});

describe("PdfDecryptWorkspace (P16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("differentiates wrong password cleanly and unlocks with valid password into C08 handoff", async () => {
    const user = userEvent.setup();
    const onNavigateReader = vi.fn();
    mockPickSingleFile.mockResolvedValue("C:\\Docs\\locked.pdf");
    mockInspectPdfSecurity.mockResolvedValue({
      path: "C:\\Docs\\locked.pdf",
      fileName: "locked.pdf",
      byteLength: 51200,
      status: "encrypted_password_required",
      isEncrypted: true,
      requiresOpenPassword: true,
      hasOwnerRestrictions: true,
      encryptionRevision: 6,
      encryptionLabel: "AES-256 (PDF 2.0 R6)",
      printPermission: "low",
      allowCopy: false,
      allowModify: false,
      pageCount: null,
      hasSignatures: false,
      signatureCount: 0,
      warnings: [],
    });
    mockSuggestSafeSiblingPath.mockResolvedValue("C:\\Docs\\locked_decrypted.pdf");

    mockDecryptPdf.mockRejectedValueOnce({
      code: "PDF_WRONG_PASSWORD",
      message: "The supplied password is incorrect.",
    });
    mockDecryptPdf.mockResolvedValueOnce({
      outputPath: "C:\\Docs\\locked_decrypted.pdf",
      byteLength: 49800,
      pageCount: 3,
      originalEncryption: "AES-256 (PDF 2.0 R6)",
      verifiedOpenWithoutPassword: true,
      hasTextLayer: true,
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={onNavigateReader} onNavigateToTool={() => {}}>
          <PdfDecryptWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择 PDF 文件/ }));
    await waitFor(() => {
      expect(screen.getByText("AES-256 (PDF 2.0 R6)")).toBeInTheDocument();
    });

    const pwInput = screen.getByLabelText("已知打开密码或权限密码");
    await user.type(pwInput, "wrong-pw");
    await user.click(screen.getByRole("button", { name: /解除密码并导出副本/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/密码不正确/);
    });

    await user.clear(pwInput);
    await user.type(pwInput, "right-pw");
    await user.click(screen.getByRole("button", { name: /解除密码并导出副本/ }));

    await waitFor(() => {
      expect(screen.getByText(/解密完成并已独立验证可无密码打开/)).toBeInTheDocument();
    });
    expect(pwInput).toHaveValue("");

    await user.click(screen.getByRole("button", { name: /在内置预览 \(C08\) 中打开/ }));
    expect(onNavigateReader).toHaveBeenCalledTimes(1);
  });
});
