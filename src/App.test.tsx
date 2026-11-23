import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useSessionStore } from "./lib/sessionStore";
import { filterTools, REGISTERED_TOOLS, type RegisteredTool } from "./registry/tools";

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

  it("registers all 60 active tools with unique IDs, complete bilingual metadata, and search aliases", () => {
    const ids = REGISTERED_TOOLS.map((t) => t.id);
    expect(ids).toEqual([
      "D01",
      "D02",
      "D03",
      "D04",
      "D05",
      "D06",
      "D07",
      "D08",
      "D09",
      "D10",
      "D11",
      "D12",
      "D13",
      "D14",
      "T08",
      "T09",
      "I01",
      "I02",
      "I03",
      "I05",
      "I06",
      "I07",
      "I08",
      "I09",
      "I10",
      "I11",
      "I12",
      "I13",
      "F01",
      "F02",
      "F03",
      "F04",
      "F05",
      "V01",
      "V02",
      "V03",
      "V04",
      "V05",
      "V06",
      "V07",
      "V08",
      "V09",
      "V10",
      "V11",
      "V12",
      "V13",
      "V14",
      "V15",
      "A01",
      "A02",
      "A03",
      "A04",
      "A05",
      "P07",
      "P08",
      "P09",
      "P10",
      "P11",
      "P12",
      "P17",
    ]);
    for (const query of ["图片合成 PDF", "images to pdf", "图片转pdf"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P12"]);
    }
    for (const query of ["PDF 导出为图片", "pdf to images", "pdf转图片"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P17"]);
    }
    for (const query of ["PDF 合并", "merge pdf", "bookmarks"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P07"]);
    }
    for (const query of ["PDF 拆分", "split pdf", "分割pdf"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P08"]);
    }
    for (const query of ["页面重排", "organize pdf", "pdf旋转"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P09"]);
    }
    for (const query of ["删除 PDF 页面", "delete pdf pages", "删页"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P10"]);
    }
    for (const query of ["提取 PDF 页面", "extract pdf pages", "抽取页面"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "pdf" }).map((tool) => tool.id),
      ).toEqual(["P11"]);
    }
    for (const query of ["视频下载", "video download", "yt-dlp"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "video" }).map((tool) => tool.id),
      ).toEqual(["V01"]);
    }
    for (const query of ["屏幕录制", "screen record", "wasapi"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "video" }).map((tool) => tool.id),
      ).toEqual(["V05"]);
    }
    for (const query of ["录音机", "microphone", "record audio"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "audio" }).map((tool) => tool.id),
      ).toEqual(["A02"]);
    }
    for (const query of ["二维码", "barcode", "Wi-Fi"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "file" }).map((tool) => tool.id),
      ).toEqual(["F01"]);
    }
    for (const query of ["批量重命名", "batch rename", "前后缀"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "file" }).map((tool) => tool.id),
      ).toEqual(["F02"]);
    }
    for (const query of ["重复文件", "find duplicates", "查重"]) {
      expect(
        filterTools(REGISTERED_TOOLS, { query, category: "file" }).map((tool) => tool.id),
      ).toEqual(["F03"]);
    }
    for (const tool of REGISTERED_TOOLS) {
      expect(tool.name["zh-CN"].length).toBeGreaterThan(0);
      expect(tool.name["en-US"].length).toBeGreaterThan(0);
      expect(tool.summary["zh-CN"].length).toBeGreaterThan(0);
      expect(tool.summary["en-US"].length).toBeGreaterThan(0);
    }

    expect(
      filterTools(REGISTERED_TOOLS, { query: "Coordinate Picker", category: "all" }).map(
        (t) => t.id,
      ),
    ).toContain("D10");
    expect(
      filterTools(REGISTERED_TOOLS, { query: "地图坐标", category: "all" }).map((t) => t.id),
    ).toContain("D10");
  });
});
