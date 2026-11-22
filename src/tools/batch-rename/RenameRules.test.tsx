import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { RenameRules } from "./RenameRules";
import {
  DEFAULT_RENAME_RULE,
  DEFAULT_RENAME_SORT,
  type RenameRule,
  type RenameSort,
} from "./renameRulesModel";

function Form({ onRule }: { onRule: (rule: RenameRule) => void }) {
  const [rule, setRule] = useState(DEFAULT_RENAME_RULE);
  const [sort, setSort] = useState<RenameSort>(DEFAULT_RENAME_SORT);
  return (
    <I18nContext.Provider value={{ locale: "en-US", t: MESSAGES["en-US"], setLocale: () => {} }}>
      <RenameRules
        rule={rule}
        sort={sort}
        onRuleChange={(next) => {
          onRule(next);
          setRule(next);
        }}
        onSortChange={setSort}
      />
    </I18nContext.Provider>
  );
}

describe("F02 rule controls", () => {
  it("preserves literal replacement text, explains capture syntax in regex mode, and passes the selected scope", () => {
    const onRule = vi.fn();
    render(<Form onRule={onRule} />);
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "(img)([0-9]+)" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "$2-$1" } });
    expect(onRule).toHaveBeenLastCalledWith({
      kind: "replace",
      find: "(img)([0-9]+)",
      replacement: "$2-$1",
      regex: false,
      scope: "stem",
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use regular expression" }));
    expect(screen.getByText(/Use \$\{name\}/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Apply to"), { target: { value: "extension" } });
    expect(onRule).toHaveBeenLastCalledWith({
      kind: "replace",
      find: "(img)([0-9]+)",
      replacement: "$2-$1",
      regex: true,
      scope: "extension",
    });
  });

  it("accepts zero as a counter and validates padding without silently changing user input", () => {
    const onRule = vi.fn();
    render(<Form onRule={onRule} />);
    fireEvent.change(screen.getByLabelText("Rule"), { target: { value: "format" } });
    fireEvent.change(screen.getByLabelText("Starting number"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "modified" } });
    fireEvent.change(screen.getByLabelText("Number width"), { target: { value: "13" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 to 12");
    fireEvent.change(screen.getByLabelText("Number width"), { target: { value: "2" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onRule).toHaveBeenLastCalledWith({
      kind: "format",
      base: "",
      start: 0,
      padding: 2,
      separator: "-",
      date: "modified",
    });
    fireEvent.change(screen.getByLabelText("Sort by (ascending)"), {
      target: { value: "created" },
    });
    expect(screen.getByLabelText("Sort by (ascending)")).toHaveValue("created");
  });

  it("attaches the native regex parser error to the invalid pattern field", () => {
    render(
      <RenameRules
        rule={{ kind: "replace", find: "(", replacement: "", scope: "stem", regex: true }}
        sort="name"
        onRuleChange={() => {}}
        onSortChange={() => {}}
        regexError="正则表达式无效"
      />,
    );
    const input = screen.getByRole("textbox", { name: "查找" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("正则表达式无效");
  });
});
