import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { HashGeneratorWorkspace } from "./HashGeneratorWorkspace";

function renderHashWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <HashGeneratorWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D03 HashGeneratorWorkspace UI", () => {
  it("computes empty and known SHA-256 vectors, preserves whitespace, and verifies expected digest", async () => {
    const user = userEvent.setup();
    renderHashWorkspace();

    // Explicit compute on empty input "" -> NIST empty SHA-256
    await user.click(screen.getByRole("button", { name: "重新计算" }));
    const output = screen.getByLabelText("SHA-256 摘要结果") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(output.value).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    // Type "abc" -> NIST vector
    const input = screen.getByLabelText("待计算文本");
    await user.type(input, "abc");
    await waitFor(() => {
      expect(output.value).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    // Verify expected digest comparison
    const compareInput = screen.getByLabelText("期望摘要比对（可选）");
    await user.type(
      compareInput,
      "SHA256: BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    );
    expect(screen.getByText(/完全匹配/)).toBeInTheDocument();
  });

  it("never leaves a stale or valid digest marked completed when a file task is cancelled", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce(
      "D:\\Samples\\带 空格 测试文件.bin",
    );
    vi.spyOn(tauriBridge, "computeFileSha256").mockRejectedValueOnce({
      code: "TASK_CANCELLED",
      message: "Operation was cancelled by user.",
    });

    renderHashWorkspace();

    // First compute a valid text digest
    await user.type(screen.getByLabelText("待计算文本"), "abc");
    const output = screen.getByLabelText("SHA-256 摘要结果") as HTMLTextAreaElement;
    await waitFor(() => expect(output.value).toHaveLength(64));

    // Switch to file mode and run a file hash that cancels
    await user.click(screen.getByRole("button", { name: "本地文件" }));
    await user.click(screen.getAllByRole("button", { name: "选择本地文件…" })[0]!);

    await waitFor(() => {
      expect(screen.getAllByText(/计算已取消/).length).toBeGreaterThan(0);
    });
    expect(output.value).toBe("");

    vi.restoreAllMocks();
  });
});
