import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { LoremIpsumWorkspace } from "./LoremIpsumWorkspace";

describe("D12 LoremIpsumWorkspace UI", () => {
  it("updates output on unit/format changes, copies exact selected format, and disables stale copy on invalid count or clear", async () => {
    const user = userEvent.setup();
    let copiedText = "";
    const writeSpy = vi
      .spyOn(tauriBridge, "writeSystemClipboardText")
      .mockImplementation(async (val) => {
        copiedText = val;
      });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <LoremIpsumWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "按词 (Words)" }));
    const countInput = screen.getByLabelText("数量 (1–5000)");
    await user.clear(countInput);
    await user.type(countInput, "8");
    await user.click(screen.getByRole("button", { name: "HTML (<p>)" }));

    expect(screen.getByTestId("lorem-output-editor")).toHaveValue(
      "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>",
    );

    await user.click(screen.getByRole("button", { name: "复制文本" }));
    expect(copiedText).toBe("<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>");

    // Invalid input `0` must hide previous output and disable Copy
    await user.clear(countInput);
    await user.type(countInput, "0");
    expect(screen.queryByTestId("lorem-output-editor")).toBeNull();
    expect(screen.getByRole("button", { name: "复制文本" })).toBeDisabled();

    writeSpy.mockRestore();
  });
});
