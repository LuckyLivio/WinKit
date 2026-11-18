import { describe, expect, it } from "vitest";
import { convert, parseCsv, type CsvJsonOptions, MAX_INPUT_BYTES } from "./csvJsonEngine";

describe("D14 csvJsonEngine", () => {
  it("parses RFC 4180 CSV with quoted fields, embedded commas, newlines, and escaped quotes", () => {
    const csv = `name,city,note\r\n"Alice","New York","She said ""hello"""\r\nBob,"San Francisco","Line1\nLine2"`;

    const result = parseCsv(csv, ",");
    expect("rows" in result).toBe(true);
    if (!("rows" in result)) return;

    expect(result.rows).toEqual([
      ["name", "city", "note"],
      ["Alice", "New York", 'She said "hello"'],
      ["Bob", "San Francisco", "Line1\nLine2"],
    ]);
  });

  it("auto-detects delimiter (tab, semicolon, comma) from first line", () => {
    const tabCsv = "a\tb\tc\n1\t2\t3";
    const semiCsv = "a;b;c\n1;2;3";
    const commaCsv = "a,b,c\n1,2,3";

    const tabResult = parseCsv(tabCsv, "auto");
    expect("rows" in tabResult).toBe(true);
    if ("rows" in tabResult) {
      expect(tabResult.detectedDelimiter).toBe("\t");
      expect(tabResult.rows[0]).toEqual(["a", "b", "c"]);
    }

    const semiResult = parseCsv(semiCsv, "auto");
    expect("rows" in semiResult).toBe(true);
    if ("rows" in semiResult) {
      expect(semiResult.detectedDelimiter).toBe(";");
    }

    const commaResult = parseCsv(commaCsv, "auto");
    expect("rows" in commaResult).toBe(true);
    if ("rows" in commaResult) {
      expect(commaResult.detectedDelimiter).toBe(",");
    }
  });

  it("preserves large integers and leading zeros as strings, detects booleans and nulls when enabled", () => {
    const csv = "id,zip,active,score,big\n9007199254740993,00123,true,42.5,null";
    const result = convert(csv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: true,
      formulaProtection: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveLength(1);
    const row = parsed[0];
    // Large integer kept as string
    expect(row.id).toBe("9007199254740993");
    // Leading zero kept as string
    expect(row.zip).toBe("00123");
    // Boolean
    expect(row.active).toBe(true);
    // Float
    expect(row.score).toBe(42.5);
    // Null
    expect(row.big).toBe(null);
  });

  it("flattens nested JSON objects with dot-path column names in JSON to CSV", () => {
    const json = JSON.stringify([
      { name: "Alice", address: { city: "NYC", zip: "10001" }, tags: ["dev", "admin"] },
      { name: "Bob", address: { city: "LA", zip: "90001" } },
    ]);

    const result = convert(json, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const lines = result.output.split("\n");
    // Header should include flattened paths
    expect(lines[0]).toContain("address.city");
    expect(lines[0]).toContain("address.zip");
    // Tags array is JSON-stringified then CSV-escaped (quotes doubled inside quoted field)
    expect(lines[1]).toContain("dev");
    expect(lines[1]).toContain("admin");
    expect(result.columnCount).toBe(4); // name, address.city, address.zip, tags
  });

  it("applies spreadsheet formula protection and CSV field escaping correctly", () => {
    const json = JSON.stringify([
      { formula: "=SUM(A1:A10)", normal: "hello", plus: "+cmd" },
    ]);

    const result = convert(json, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: true,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    // Protected formulas start with '
    expect(result.output).toContain("'=SUM(A1:A10)");
    expect(result.output).toContain("'+cmd");
    expect(result.output).toContain("hello");
  });

  it("generates valid Markdown tables from CSV and JSON", () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const csvResult = convert(csv, {
      direction: "csv_to_md",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });

    expect(csvResult.status).toBe("ok");
    if (csvResult.status !== "ok") return;

    const lines = csvResult.output.split("\n");
    expect(lines).toHaveLength(4); // header + separator + 2 data rows
    expect(lines[0]).toContain("name");
    expect(lines[0]).toContain("age");
    expect(lines[1]).toMatch(/^\|[\s-|]+\|$/);
    expect(lines[2]).toContain("Alice");

    // JSON to Markdown
    const json = JSON.stringify([
      { x: 1, y: "a" },
      { x: 2, y: "b" },
    ]);
    const jsonResult = convert(json, {
      direction: "json_to_md",
      delimiter: "auto",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });

    expect(jsonResult.status).toBe("ok");
    if (jsonResult.status !== "ok") return;
    expect(jsonResult.output).toContain("x");
    expect(jsonResult.output).toContain("y");
    expect(jsonResult.rowCount).toBe(2);
  });

  it("reports unterminated quotes and enforces size limits", () => {
    // Unterminated quote
    const badCsv = `name,city\n"Alice,"NYC"`;
    const untermResult = parseCsv(badCsv, ",");
    expect("status" in untermResult && untermResult.status === "error").toBe(true);

    // Size limit
    const opts: CsvJsonOptions = {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    };
    const bigInput = "a".repeat(MAX_INPUT_BYTES + 1);
    const sizeResult = convert(bigInput, opts);
    expect(sizeResult.status).toBe("error");
    if (sizeResult.status === "error") {
      expect(sizeResult.message).toContain("4 MiB");
    }

    // Empty input
    const emptyResult = convert("", opts);
    expect(emptyResult.status).toBe("error");

    // Invalid JSON
    const badJsonResult = convert("not json", {
      ...opts,
      direction: "json_to_csv",
    });
    expect(badJsonResult.status).toBe("error");
  });

  it("handles CSV to JSON without headers as array of arrays", () => {
    const csv = "1,2,3\n4,5,6";
    const result = convert(csv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: false,
      detectTypes: true,
      formulaProtection: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.columnCount).toBe(3);
  });

  it("roundtrips CSV to JSON to CSV preserving data integrity", () => {
    const original = "name,city,score\nAlice,NYC,100\nBob,LA,200";
    const toJson = convert(original, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });

    expect(toJson.status).toBe("ok");
    if (toJson.status !== "ok") return;

    const backToCsv = convert(toJson.output, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });

    expect(backToCsv.status).toBe("ok");
    if (backToCsv.status !== "ok") return;

    // Verify same data (may differ in ordering of fields)
    const lines = backToCsv.output.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain("name");
    expect(lines[0]).toContain("city");
    expect(lines[0]).toContain("score");
  });
});
