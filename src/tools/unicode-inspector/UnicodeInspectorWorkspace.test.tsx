import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import { UnicodeInspectorWorkspace } from "./UnicodeInspectorWorkspace";
import { DEFAULT_UNICODE_SANITIZE_OPTIONS, inspectUnicodeClientFallback } from "./unicodeEngine";

describe("D11 UnicodeInspector engine & UI", () => {
  it("distinguishes code points, UTF-16 offsets, and graphemes across CJK, Cyrillic confusable, BOM, ZWSP, NBSP, RLO, ZWJ family emoji, combining marks, and Persian ZWNJ", () => {
    const sample = "\uFEFFa\u0430中\u00A0\u200B\u202Ee\u0301👨‍👩‍👧‍👦می\u200Cخواهم";
    const res = inspectUnicodeClientFallback(sample, DEFAULT_UNICODE_SANITIZE_OPTIONS);

    // Leading BOM + Latin 'a' + Cyrillic 'а'
    expect(res.entries[0]?.codePointHex).toBe("U+FEFF");
    expect(res.entries[1]?.name).toBe("LATIN SMALL LETTER A");
    expect(res.entries[2]?.codePointHex).toBe("U+0430");
    expect(res.entries[2]?.flags).toContain("potential_confusable");
    expect(res.entries[2]?.confusablePrototype).toBe("'a' (U+0061)");

    // CJK name & UTF-8 hex
    expect(res.entries[3]?.name).toBe("CJK UNIFIED IDEOGRAPH-4E2D");
    expect(res.entries[3]?.utf8BytesHex).toBe("E4 B8 AD");

    // Combining sequence e + U+0301 shares graphemeIndex
    expect(res.entries[7]?.graphemeIndex).toBe(res.entries[8]?.graphemeIndex);

    // Family ZWJ emoji 👨‍👩‍👧‍👦 (entries 9..15) shares a single graphemeIndex and advances UTF-16 by +2/+1
    expect(res.entries[9]?.codePointHex).toBe("U+1F468");
    expect(res.entries[9]?.utf16Length).toBe(2);
    expect(res.entries[10]?.codePointHex).toBe("U+200D");
    expect(res.entries[9]?.graphemeIndex).toBe(res.entries[15]?.graphemeIndex);

    // Default sanitizer removes BOM & ZWSP and normalizes NBSP -> ' ', while preserving Cyrillic 'а', RLO (until opted-in), combining accent, ZWJ family emoji, and Persian ZWNJ!
    expect(res.sanitizedText).toBe("a\u0430中 \u202Ee\u0301👨‍👩‍👧‍👦می\u200Cخواهم");
  });

  it("supports attention-only filtering, bidirectional row-to-textarea selection, and opt-in confusable replacement in UI", async () => {
    const user = userEvent.setup();
    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <UnicodeInspectorWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    // Load comprehensive diagnostic sample
    await user.click(screen.getByRole("button", { name: "填入综合测试样例" }));

    await waitFor(() =>
      expect(screen.getByTestId("unicode-codepoints-table")).toHaveTextContent(
        "CYRILLIC SMALL LETTER A",
      ),
    );

    // Default preview preserves family ZWJ emoji and Persian ZWNJ while stripping BOM & ZWSP
    const preview = screen.getByTestId("unicode-sanitized-preview");
    expect(preview.textContent).toContain("👨‍👩‍👧‍👦");
    expect(preview.textContent).toContain("می\u200Cخواهم");
    expect(preview.textContent).not.toContain("\uFEFF");
    expect(preview.textContent).not.toContain("\u200B");

    // Filter to Attention Items Only -> ASCII 'W' disappears while U+0430 remains
    await user.click(screen.getByLabelText(/仅显示需注意项/));
    expect(screen.getByTestId("unicode-codepoints-table")).not.toHaveTextContent(
      "LATIN CAPITAL LETTER W",
    );
    expect(screen.getByTestId("unicode-codepoints-table")).toHaveTextContent("U+0430");

    // Click U+0430 row -> selects exact UTF-16 range in source textarea without mutating source
    await user.click(screen.getByText("U+0430"));
    const textarea = screen.getByLabelText(
      "待检查原始文本（点击字符或表格行可双向定位）",
    ) as HTMLTextAreaElement;
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe("\u0430");

    // Opt-in confusable replacement converts pаypal -> paypal in preview while keeping source untouched
    await user.click(screen.getByLabelText(/将 UTS #39 相似字符替换为 ASCII 原型/));
    await waitFor(() => expect(preview.textContent).toContain("paypal"));
    expect(textarea.value).toContain("p\u0430ypal");
  });
});
