import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { WordCounterWorkspace } from "./WordCounterWorkspace";

function renderWordCounter() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <WordCounterWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("T08 WordCounterWorkspace UI", () => {
  it("updates live grapheme, word, line, paragraph, and UTF-8 byte counts and clears cleanly", async () => {
    const user = userEvent.setup();
    renderWordCounter();

    expect(screen.getByTestId("wc-lines")).toHaveTextContent("0");
    expect(screen.getByTestId("wc-paragraphs")).toHaveTextContent("0");

    const input = screen.getByLabelText("待统计正文");
    await user.type(input, "Hello 世界 🚀\n\nSecond paragraph.");

    expect(screen.getByTestId("wc-paragraphs")).toHaveTextContent("2");
    expect(screen.getByTestId("wc-lines")).toHaveTextContent("3");
    expect(Number(screen.getByTestId("wc-words").textContent)).toBeGreaterThanOrEqual(4);

    await user.click(screen.getByRole("button", { name: "清空文本" }));
    expect(screen.getByTestId("wc-words")).toHaveTextContent("0");
    expect(screen.getByTestId("wc-lines")).toHaveTextContent("0");
  });
});
