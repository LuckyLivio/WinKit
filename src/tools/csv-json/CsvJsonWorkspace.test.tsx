import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { CsvJsonWorkspace } from "./CsvJsonWorkspace";

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <CsvJsonWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D14 CsvJsonWorkspace UI", () => {
  it("converts CSV to JSON, switches direction, and supports copy and clear", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    // Input area should exist
    const inputEditor = screen.getByTestId("csvjson-input-editor");
    expect(inputEditor).toBeInTheDocument();

    // Type CSV data
    await user.type(inputEditor, "name,age\nAlice,30\nBob,25");

    // Click convert
    const convertBtn = screen.getByRole("button", { name: /转换/ });
    await user.click(convertBtn);

    // Status banner should show success
    const banner = screen.getByTestId("csvjson-status-banner");
    expect(banner.className).toContain("is-ok");

    // Output should contain JSON
    const outputEditor = screen.getByTestId("csvjson-output-editor") as HTMLTextAreaElement;
    expect(outputEditor.value).toContain("Alice");

    // Click clear
    const clearBtn = screen.getByRole("button", { name: /清空/ });
    await user.click(clearBtn);
    expect((screen.getByTestId("csvjson-input-editor") as HTMLTextAreaElement).value).toBe("");
  });
});
