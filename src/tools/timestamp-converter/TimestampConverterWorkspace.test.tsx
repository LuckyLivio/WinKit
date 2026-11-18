import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { TimestampConverterWorkspace } from "./TimestampConverterWorkspace";

function renderTimestampWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <TimestampConverterWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D06 TimestampConverterWorkspace UI", () => {
  it("converts nanosecond BigInt values without rounding and rejects ambiguous/nonexistent DST inputs", async () => {
    const user = userEvent.setup();
    renderTimestampWorkspace();

    await user.click(screen.getByRole("button", { name: "纳秒 (ns)" }));
    const tsInput = screen.getByLabelText("Unix 时间戳整数");
    await user.type(tsInput, "1700000000123456789");

    await waitFor(() =>
      expect(screen.getByTestId("utc-iso")).toHaveTextContent("2023-11-14T22:13:20.123456789Z"),
    );
    expect(screen.getByTestId("epoch-ns")).toHaveTextContent("1700000000123456789");
    expect(screen.getByText(/\+456 µs 789 ns/)).toBeInTheDocument();

    // Switch to Date -> Timestamp and test DST gap rejection in America/New_York
    await user.click(screen.getByRole("button", { name: "日期时间 → 时间戳" }));
    const interpretTz = screen.getByLabelText("无偏移日期的解释时区");
    await user.clear(interpretTz);
    await user.type(interpretTz, "America/New_York");

    const dateBox = screen.getByLabelText("日期时间输入");
    await user.type(dateBox, "2026-03-08 02:30:00");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/spring-forward gap/));
  });
});
