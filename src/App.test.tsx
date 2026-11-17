import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useSessionStore } from "./lib/sessionStore";
import type { RegisteredTool } from "./registry/tools";

function MockStatefulTool() {
  const { session, updateJsonSession } = useSessionStore();
  return (
    <div>
      <label htmlFor="mock-editor">Editor</label>
      <input
        id="mock-editor"
        value={session.json.inputText}
        onChange={(e) => updateJsonSession({ inputText: e.target.value })}
      />
    </div>
  );
}

const SAMPLE_TOOLS: RegisteredTool[] = [
  {
    id: "D01",
    category: "developer",
    name: { "zh-CN": "JSON 格式化与校验", "en-US": "JSON Formatter" },
    summary: { "zh-CN": "格式化与校验 JSON", "en-US": "Format and validate JSON" },
    keywords: ["json", "format"],
    icon: "braces",
    implementationStatus: "full",
    component: MockStatefulTool,
  },
  {
    id: "I03",
    category: "image",
    name: { "zh-CN": "截图美化", "en-US": "Beautify Screenshot" },
    summary: { "zh-CN": "添加留白圆角阴影", "en-US": "Frame screenshots cleanly" },
    keywords: ["screenshot", "frame", "png"],
    icon: "frame",
    implementationStatus: "partial",
    component: () => <div>Image Workspace</div>,
  },
];

describe("WinKit desktop workbench shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("supports tool search, favorites, recents, language/theme switching, and in-session state retention without persisting content", async () => {
    const user = userEvent.setup();
    render(<App toolsOverride={SAMPLE_TOOLS} />);

    // Default zh-CN light mode
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("lang")).toBe("zh-CN");
    expect(screen.getByRole("heading", { name: "可用工具" })).toBeInTheDocument();

    // Filter by search keyword
    const searchBox = screen.getByRole("searchbox");
    await user.type(searchBox, "I03");
    expect(screen.getAllByText("截图美化").length).toBeGreaterThan(0);
    expect(screen.queryByRole("listitem")?.textContent).toContain("I03");
    await user.clear(searchBox);

    // Pin D01 to favorites
    const favButtons = screen.getAllByRole("button", { name: "加入收藏" });
    await user.click(favButtons[0]!);
    await user.click(screen.getByRole("button", { name: /收藏夹/ }));
    expect(screen.getByRole("listitem")).toHaveTextContent("D01");

    // Open D01, type session text, switch away to Settings, switch theme & language, and return
    await user.click(screen.getByRole("button", { name: /打开/ }));
    const editor = screen.getByLabelText("Editor");
    await user.type(editor, "secret-session-payload");

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(document.documentElement.getAttribute("lang")).toBe("en-US");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();

    // Return to D01 via sidebar and verify session input survived navigation
    await user.click(screen.getByRole("button", { name: /JSON Formatter/ }));
    expect(screen.getByLabelText("Editor")).toHaveValue("secret-session-payload");

    // Verify localStorage never contains user session content
    const storedRaw = window.localStorage.getItem("winkit.preferences.v1") ?? "";
    expect(storedRaw).not.toContain("secret-session-payload");
    expect(storedRaw).toContain('"D01"');
  });
});
