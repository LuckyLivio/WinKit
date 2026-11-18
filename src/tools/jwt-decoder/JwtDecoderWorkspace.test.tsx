import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { JwtDecoderWorkspace } from "./JwtDecoderWorkspace";

const RFC7515_A1_TOKEN =
  "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7515_A1_KEY_B64URL =
  "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow";

function renderJwtWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <JwtDecoderWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D05 JwtDecoderWorkspace UI", () => {
  it("separates structure, signature, and expired time statuses, masks secret by default, re-verifies on Base64 mode toggle, and clears cleanly", async () => {
    const user = userEvent.setup();
    const { unmount } = renderJwtWorkspace();

    const tokenInput = screen.getByLabelText("JWT / JWS 令牌输入");
    await user.click(tokenInput);
    await user.paste(RFC7515_A1_TOKEN);

    // 1. Structure is valid HS256, Signature is unverified (no secret yet), Time is expired (exp=1300819380 in 2011)
    expect(screen.getByTestId("jwt-status-structure")).toHaveTextContent(
      "三段式 JWS 解码成功（alg: HS256）",
    );
    await waitFor(() =>
      expect(screen.getByTestId("jwt-status-signature")).toHaveTextContent("签名未验证"),
    );
    expect(screen.getByTestId("jwt-status-time")).toHaveTextContent("已过期");

    // 2. Secret input is masked (`type="password"`) by default
    const secretField = screen.getByLabelText("共享密钥（默认遮挡）") as HTMLInputElement;
    expect(secretField.type).toBe("password");

    // Paste Base64url key while still in UTF-8 mode -> signature invalid
    await user.click(secretField);
    await user.paste(RFC7515_A1_KEY_B64URL);
    await waitFor(() =>
      expect(screen.getByTestId("jwt-status-signature")).toHaveTextContent("签名无效"),
    );

    // Switch secret mode to Base64 / Base64url -> immediately re-verifies as Valid (64 bytes), while Time stays Expired!
    await user.click(screen.getByRole("button", { name: "Base64 / Base64url 字节" }));
    await waitFor(() =>
      expect(screen.getByTestId("jwt-status-signature")).toHaveTextContent(
        "签名有效（HS256，密钥 64 字节）",
      ),
    );
    expect(screen.getByTestId("jwt-status-time")).toHaveTextContent("已过期");

    // Toggle secret visibility
    await user.click(screen.getByRole("button", { name: "显示密钥" }));
    expect(secretField.type).toBe("text");

    // Clear wipes token, secret, visibility, and verification status
    await user.click(screen.getByRole("button", { name: "清空令牌与密钥" }));
    expect((tokenInput as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("jwt-status-structure")).toHaveTextContent("等待输入令牌");
    expect(screen.getByTestId("jwt-status-signature")).toHaveTextContent("—");

    unmount();
  });
});
