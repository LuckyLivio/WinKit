import { describe, expect, it } from "vitest";
import { ALL_CASE_STYLES, convertCaseText, tokenizeIdentifierWords } from "./caseConverterEngine";

describe("T09 12-style Case & Naming Converter Engine", () => {
  it("splits acronym runs, camelCase, digit boundaries, and repeated delimiters consistently", () => {
    expect(tokenizeIdentifierWords("getHTTPResponse")).toEqual(["get", "HTTP", "Response"]);
    expect(tokenizeIdentifierWords("HTTPRequest")).toEqual(["HTTP", "Request"]);
    expect(tokenizeIdentifierWords("version2Value")).toEqual(["version", "2", "Value"]);
    expect(tokenizeIdentifierWords("foo--__..bar")).toEqual(["foo", "bar"]);

    expect(convertCaseText("getHTTPResponse", "snake")).toBe("get_http_response");
    expect(convertCaseText("HTTPRequest", "kebab")).toBe("http-request");
    expect(convertCaseText("version2Value", "constant")).toBe("VERSION_2_VALUE");
    expect(convertCaseText("version_2_value", "camel")).toBe("version2Value");
    expect(convertCaseText("version_2_value", "pascal")).toBe("Version2Value");
    expect(convertCaseText("foo--__..bar", "dot")).toBe("foo.bar");
  });

  it("produces verified outputs across all 12 styles and preserves line boundaries", () => {
    const multiLine = "getHTTPResponse\r\nversion2Value";
    expect(convertCaseText(multiLine, "snake")).toBe("get_http_response\r\nversion_2_value");

    // Verify all 12 styles produce distinct/expected outputs on sample text
    expect(ALL_CASE_STYLES).toHaveLength(12);
    expect(convertCaseText("hello world", "uppercase")).toBe("HELLO WORLD");
    expect(convertCaseText("HELLO WORLD", "lowercase")).toBe("hello world");
    expect(convertCaseText("a guide to macos and iphone in winkit", "title")).toBe(
      "A Guide to macOS and iPhone in WinKit",
    );
    expect(convertCaseText("HELLO WORLD. SECOND SENTENCE!", "sentence")).toBe(
      "Hello world. Second sentence!",
    );
    expect(convertCaseText("hello world", "camel")).toBe("helloWorld");
    expect(convertCaseText("hello world", "pascal")).toBe("HelloWorld");
    expect(convertCaseText("hello world", "snake")).toBe("hello_world");
    expect(convertCaseText("hello world", "constant")).toBe("HELLO_WORLD");
    expect(convertCaseText("hello world", "kebab")).toBe("hello-world");
    expect(convertCaseText("hello world", "dot")).toBe("hello.world");
    expect(convertCaseText("hello!", "alternating")).toBe("hElLo!");
    expect(convertCaseText("Hello WinKit 123 🚀", "inverse")).toBe("hELLO wINkIT 123 🚀");
  });

  it("handles Chinese, accented characters, combining marks, and emojis safely without corruption", () => {
    expect(convertCaseText("café_naïve 🚀 中文", "pascal")).toBe("CaféNaïve🚀中文");
    const combining = "e\u0301cole";
    expect(convertCaseText(combining, "uppercase")).toBe("E\u0301COLE");
  });
});
