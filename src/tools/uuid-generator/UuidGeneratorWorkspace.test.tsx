import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { UuidGeneratorWorkspace } from "./UuidGeneratorWorkspace";

function renderUuidWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <UuidGeneratorWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D04 UuidGeneratorWorkspace UI", () => {
  it("generates v4/v7 batches, invalidates stale batch on version switch, and inspects v7 timestamps without fabricating v4 time", async () => {
    const user = userEvent.setup();
    renderUuidWorkspace();

    // Generate default v4 batch (5 items)
    await user.click(screen.getByRole("button", { name: "生成 UUID" }));
    await waitFor(() => expect(screen.getByTestId("uuid-row-0")).toBeInTheDocument());

    // Switching from v4 to v7 clears old v4 list immediately
    await user.click(screen.getByRole("button", { name: /UUID v7/ }));
    expect(screen.queryByTestId("uuid-row-0")).not.toBeInTheDocument();

    // Inspect RFC 9562 Appendix A.6 v7 vector -> shows 2022-02-22T19:22:22.000Z
    const inspectBox = screen.getByLabelText("解析与校验 UUID");
    await user.type(inspectBox, "017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
    await waitFor(() =>
      expect(screen.getByTestId("uuid-inspected-ts")).toHaveTextContent("2022-02-22T19:22:22.000Z"),
    );

    // Inspect v4 vector -> must NOT display timestamp row, and must show v4 random-bits note
    await user.clear(inspectBox);
    await user.type(inspectBox, "919108f7-52d1-4320-9bac-f847db4148a8");
    await waitFor(() => expect(screen.getByText(/不包含生成时间信息/)).toBeInTheDocument());
    expect(screen.queryByTestId("uuid-inspected-ts")).not.toBeInTheDocument();
  });
});
