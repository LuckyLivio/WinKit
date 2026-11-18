import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { DiffCheckerWorkspace } from "./DiffCheckerWorkspace";

function renderDiffWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <DiffCheckerWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("D07 DiffCheckerWorkspace UI", () => {
  it("renders side-by-side and inline diffs with literal HTML text, preserves inputs under ignore filters, swaps sides, and expands collapsed context", async () => {
    const user = userEvent.setup();
    renderDiffWorkspace();

    const leftEditor = screen.getByLabelText("左侧原文 (A)") as HTMLTextAreaElement;
    const rightEditor = screen.getByLabelText("右侧新文 (B)") as HTMLTextAreaElement;

    const sampleA = [
      "header 1",
      "ctx 2",
      "ctx 3",
      "ctx 4",
      "ctx 5",
      "ctx 6",
      "ctx 7",
      "ctx 8",
      "<script>oldVal</script>",
    ].join("\n");
    const sampleB = [
      "header 1",
      "ctx 2",
      "ctx 3",
      "ctx 4",
      "ctx 5",
      "ctx 6",
      "ctx 7",
      "ctx 8",
      "<script>newVal</script>",
    ].join("\n");

    await user.click(leftEditor);
    await user.paste(sampleA);
    await user.click(rightEditor);
    await user.paste(sampleB);

    await waitFor(() =>
      expect(screen.getByTestId("diff-summary-banner")).toHaveTextContent(
        "共 1 处差异块 · 新增 +1 行 · 删除 -1 行",
      ),
    );

    // Literal HTML tags rendered safely as text, never executed; collapsed context button visible
    expect(screen.getByTestId("diff-sbs-view")).toHaveTextContent("<script>");
    const expandBtn = screen.getByRole("button", { name: /展开中间隐藏的/ });
    await user.click(expandBtn);
    expect(screen.getByTestId("diff-sbs-view")).toHaveTextContent("ctx 2");

    // Switch to Inline view
    await user.click(screen.getByRole("button", { name: "内联视图" }));
    expect(screen.getByTestId("diff-inline-view")).toBeInTheDocument();

    // Swap A <-> B preserves exact text on each side
    await user.click(screen.getByRole("button", { name: "交换 A ↔ B" }));
    expect(leftEditor.value).toBe(sampleB);
    expect(rightEditor.value).toBe(sampleA);

    // Ignore Case toggle does not mutate inputs and shows exact-patch notice
    await user.click(screen.getByLabelText("忽略大小写"));
    expect(screen.getByText(/Unified Diff 始终从原始 A\/B 生成/)).toBeInTheDocument();
    expect(leftEditor.value).toBe(sampleB);
  });
});
