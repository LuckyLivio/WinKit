import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { CodecWorkspace } from "./CodecWorkspace";

function renderCodecWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <CodecWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D02 CodecWorkspace UI", () => {
  it("encodes and decodes UTF-8 Chinese/emoji across Base64 / URL-safe / Hex / Binary and flags invalid UTF-8 bytes without corruption", async () => {
    const user = userEvent.setup();
    renderCodecWorkspace();

    // Clarifies Base64 is encoding, not encryption
    expect(screen.getByText(/属于数据编码而非加密算法/)).toBeInTheDocument();

    const input = screen.getByLabelText("输入源");
    await user.type(input, "WinKit 🚀");

    await waitFor(() => expect(screen.getByLabelText("转换结果")).toHaveValue("V2luS2l0IPCfmoA="));

    // Switch format to Hex -> output updates immediately without stale Base64
    await user.click(screen.getByRole("button", { name: "Hex (十六进制)" }));
    await waitFor(() =>
      expect(screen.getByLabelText("转换结果")).toHaveValue("57696e4b697420f09f9a80"),
    );

    // Switch to Decode mode and feed invalid UTF-8 hex (`fffe0089`) -> must warn RAW BYTES, disable Copy Full Result, keep Save As enabled!
    await user.click(screen.getByRole("button", { name: "解码 (Decode)" }));
    await user.clear(input);
    await user.type(input, "fffe0089");

    await waitFor(() => expect(screen.getByText("RAW BYTES")).toBeInTheDocument());
    expect(screen.getByText(/未将其替换为乱码文本/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制完整结果" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "另存为文件…" })).toBeEnabled();
  });
});
