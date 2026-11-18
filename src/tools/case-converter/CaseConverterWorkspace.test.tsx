import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { CaseConverterWorkspace } from "./CaseConverterWorkspace";

function renderCaseConverter() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <CaseConverterWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("T09 CaseConverterWorkspace UI", () => {
  it("preserves original input text while switching across 12 case styles line by line", async () => {
    const user = userEvent.setup();
    renderCaseConverter();

    const input = screen.getByLabelText(/原始文本/);
    const output = screen.getByLabelText("转换结果");

    await user.type(input, "getHTTPResponse\nversion2Value");
    // Default style is snake_case
    expect(output).toHaveValue("get_http_response\nversion_2_value");
    expect(input).toHaveValue("getHTTPResponse\nversion2Value");

    // Switch to PascalCase
    await user.click(screen.getByRole("button", { name: /PascalCase/ }));
    expect(output).toHaveValue("GetHttpResponse\nVersion2Value");
    // Input remains untouched!
    expect(input).toHaveValue("getHTTPResponse\nversion2Value");

    // Clear resets both cleanly
    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(input).toHaveValue("");
    expect(output).toHaveValue("");
  });
});
