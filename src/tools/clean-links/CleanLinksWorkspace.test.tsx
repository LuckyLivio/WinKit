import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { CleanLinksWorkspace } from "./CleanLinksWorkspace";

describe("D09 CleanLinksWorkspace UI", () => {
  it("cleans batch links with in-place invalid-line feedback and leaves clipboard untouched when non-link text is present", async () => {
    const user = userEvent.setup();
    let fakeClipboard = "Plain paragraph note\nhttps://example.com/?utm_source=clip";

    const readSpy = vi
      .spyOn(tauriBridge, "readSystemClipboardText")
      .mockImplementation(async () => fakeClipboard);
    const writeSpy = vi
      .spyOn(tauriBridge, "writeSystemClipboardText")
      .mockImplementation(async (next) => {
        fakeClipboard = next;
      });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <CleanLinksWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    // 1. One-click replace refuses mixed non-link clipboard without modifying fakeClipboard
    await user.click(
      screen.getByRole("button", { name: "一步净化并写回剪贴板（仅纯链接时替换）" }),
    );
    expect(readSpy).toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("clean-links-clipboard-banner")).toHaveTextContent(
      "已保持系统剪贴板原样不变",
    );
    expect(screen.getByTestId("clean-links-valid-output")).toHaveValue("https://example.com/");

    // 2. Pure-link clipboard gets cleaned & written back on explicit button click
    fakeClipboard =
      "https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fdoc%3Fid%3D9%26fbclid%3DIw1&sa=D";
    await user.click(
      screen.getByRole("button", { name: "一步净化并写回剪贴板（仅纯链接时替换）" }),
    );
    expect(writeSpy).toHaveBeenCalledWith("https://example.org/doc?id=9");
    expect(fakeClipboard).toBe("https://example.org/doc?id=9");

    readSpy.mockRestore();
    writeSpy.mockRestore();
  });
});
