import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { JsonFormatterWorkspace } from "./JsonFormatterWorkspace";

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <JsonFormatterWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D01 JsonFormatterWorkspace UI", () => {
  it("formats, minifies, preserves 64-bit integers, reports line/column errors, and clears cleanly", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const input = screen.getByLabelText("JSON 输入");
    const output = screen.getByLabelText("处理结果") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '{"id":9007199254740993,"items":[1,2]}' } });
    expect(output.value).toContain('"id": 9007199254740993');
    expect(screen.getByText(/无损词法保真/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "单行压缩" }));
    expect(output.value).toBe('{"id":9007199254740993,"items":[1,2]}');

    // Invalid JSON shows exact line and column
    fireEvent.change(input, { target: { value: '{\n  "broken": \n}' } });
    expect(screen.getByRole("alert")).toHaveTextContent("第 3 行，第 1 列");

    await user.click(screen.getByRole("button", { name: "清空" }));
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(output.value).toBe("");
  });
});
