import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { PasswordGeneratorWorkspace } from "./PasswordGeneratorWorkspace";

describe("D13 PasswordGeneratorWorkspace UI", () => {
  it("masks generated secrets by default, copies plaintext only on explicit click, marks stale on config edit, and supports passphrase mode", async () => {
    const user = userEvent.setup();
    let clipboardValue = "";
    const writeSpy = vi
      .spyOn(tauriBridge, "writeSystemClipboardText")
      .mockImplementation(async (val) => {
        clipboardValue = val;
      });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <PasswordGeneratorWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    // 1. Generate default password batch -> masked by default, clipboard untouched
    await user.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(screen.getByTestId("secret-item-0")).toBeInTheDocument());
    expect(screen.getByTestId("secret-item-0").textContent).toMatch(/^•+$/);
    expect(writeSpy).not.toHaveBeenCalled();

    // 2. Explicit single-item copy writes real unmasked password to clipboard
    const copyButtons = screen.getAllByRole("button", { name: "复制" });
    await user.click(copyButtons[0]!);
    expect(clipboardValue.length).toBe(16);
    expect(clipboardValue).not.toContain("•");

    // 3. Reveal toggle displays plaintext, and editing length marks previous batch stale & disables copy
    await user.click(screen.getByRole("button", { name: "显示明文" }));
    expect(screen.getByTestId("secret-item-0").textContent).toBe(clipboardValue);

    const lenInput = screen.getByLabelText("密码长度 (8–128)");
    await user.clear(lenInput);
    await user.type(lenInput, "24");
    expect(screen.getByTestId("password-stale-banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /复制本批/ })).toBeDisabled();

    // 4. Switch to Passphrase mode, enable capitalize + 2-digit number, and regenerate
    await user.click(screen.getByRole("button", { name: "口令短语 (Passphrase)" }));
    await user.click(screen.getByLabelText("词首字母大写"));
    await user.click(screen.getByLabelText("末尾附加两位随机数字 (00–99)"));
    await user.click(screen.getByRole("button", { name: "重新生成" }));

    await waitFor(() =>
      expect(screen.queryByTestId("password-stale-banner")).not.toBeInTheDocument(),
    );
    const phrase = screen.getByTestId("secret-item-0").textContent ?? "";
    expect(phrase).toMatch(/^([A-Z][a-z]+-){6}\d{2}$/);

    writeSpy.mockRestore();
  });
});
