import { describe, expect, it } from "vitest";
import {
  convertTabularData,
  detectCsvDelimiter,
  MAX_TABULAR_INPUT_BYTES,
  parseCsvRecords,
} from "./csvJsonEngine";

describe("D14 csvJsonEngine", () => {
  it("auto-detects delimiters without being misled by delimiters inside quotes, and flags ambiguity honestly", () => {
    // Semicolon file whose quoted column contains multiple commas
    const semiWithQuotedCommas =
      '"Smith, Alice, Jr.";"Boston, MA";9007199254740993\r\n"Doe, Bob";"Austin, TX";9007199254740994';
    const det = detectCsvDelimiter(semiWithQuotedCommas);
    expect(det.delimiter).toBe(";");
    expect(det.ambiguous).toBe(false);

    // Single-column input has 0 delimiters -> ambiguous = true
    const singleCol = detectCsvDelimiter("header\nvalue1\nvalue2");
    expect(singleCol.ambiguous).toBe(true);

    // Tied comma and semicolon counts per row -> ambiguous = true
    const tied = detectCsvDelimiter("a,b;c\n1,2;3");
    expect(tied.ambiguous).toBe(true);
  });

  it("handles UTF-8 BOM before quoted headers, CRLF/LF, trailing empty fields, whitespace cells, empty input, and header-only files", () => {
    const validBomCsv = '\uFEFF"id",code,note,trailing\r\n1,  ,"a""b\r\nc",';
    const parsed = parseCsvRecords(validBomCsv, ",");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.hadLeadingBom).toBe(true);
    expect(parsed.data.rows).toEqual([
      ["id", "code", "note", "trailing"],
      ["1", "  ", 'a"b\r\nc', ""],
    ]);

    // Empty & BOM-only input
    expect(
      convertTabularData("\uFEFF", {
        direction: "csv_to_json",
        delimiter: "auto",
        firstRowHeaders: true,
        detectTypes: false,
        formulaProtection: false,
      }).status,
    ).toBe("empty");

    // Header-only file -> valid empty JSON array `[]` with 0 data rows & 3 columns
    const headerOnly = convertTabularData("col_a,col_b,col_c\r\n", {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(headerOnly.status).toBe("ok");
    if (headerOnly.status === "ok") {
      expect(headerOnly.fullOutput).toBe("[]");
      expect(headerOnly.rowCount).toBe(0);
      expect(headerOnly.columnCount).toBe(3);
    }
  });

  it("preserves 00123, >2^53 integers (9007199254740993), exact decimals (19.90), long decimals, booleans, null, and padded strings", () => {
    const csv = [
      "big_id,zip,price,pi,flag,nothing,padded",
      "9007199254740993,00123,19.90,3.141592653589793238462643,true,null, 42 ",
    ].join("\n");

    // 1. Default mode (`detectTypes: false`) -> EVERY cell is an exact JSON string
    const asStrings = convertTabularData(csv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(asStrings.status).toBe("ok");
    if (asStrings.status === "ok") {
      expect(asStrings.fullOutput).toBe(
        [
          "[",
          "  {",
          '    "big_id": "9007199254740993",',
          '    "zip": "00123",',
          '    "price": "19.90",',
          '    "pi": "3.141592653589793238462643",',
          '    "flag": "true",',
          '    "nothing": "null",',
          '    "padded": " 42 "',
          "  }",
          "]",
        ].join("\n"),
      );
    }

    // 2. Explicit `detectTypes: true` -> canonical JSON numbers emitted verbatim WITHOUT float rounding,
    // while `00123` and `" 42 "` remain strings!
    const typed = convertTabularData(csv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: true,
      formulaProtection: false,
    });
    expect(typed.status).toBe("ok");
    if (typed.status === "ok") {
      expect(typed.fullOutput).toBe(
        [
          "[",
          "  {",
          '    "big_id": 9007199254740993,',
          '    "zip": "00123",',
          '    "price": 19.90,',
          '    "pi": 3.141592653589793238462643,',
          '    "flag": true,',
          '    "nothing": null,',
          '    "padded": " 42 "',
          "  }",
          "]",
        ].join("\n"),
      );
    }
  });

  it("handles duplicate/empty headers, ragged rows (physical line vs record #), union of JSON keys, and __proto__/constructor safely", () => {
    // Duplicate & empty headers rejected by default, renamed cleanly when requested
    const dupHeaderCsv = "id,,id,__proto__,constructor\n1,a,2,safe_proto,safe_ctor";
    const errDefault = convertTabularData(dupHeaderCsv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(errDefault.status === "error" && errDefault.code).toBe("HEADER_CONFLICT");

    const renamed = convertTabularData(dupHeaderCsv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      headerIssuePolicy: "rename",
      formulaProtection: false,
    });
    expect(renamed.status).toBe("ok");
    if (renamed.status === "ok") {
      expect(renamed.renamedHeaders).toEqual([
        { columnIndex: 2, original: "", renamedTo: "column_2" },
        { columnIndex: 3, original: "id", renamedTo: "id_2" },
      ]);
      expect(renamed.fullOutput).toContain('"__proto__": "safe_proto"');
      expect(renamed.fullOutput).toContain('"constructor": "safe_ctor"');
    }

    // Multi-line record #2 spans physical lines 2..4; ragged record #3 is on physical line 5!
    const multiLineThenRagged = 'h1,h2\n"line2\nline3\nline4",ok\nonly_one_col';
    const raggedErr = convertTabularData(multiLineThenRagged, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(raggedErr.status).toBe("error");
    if (raggedErr.status === "error") {
      expect(raggedErr.recordNumber).toBe(3);
      expect(raggedErr.physicalLine).toBe(5);
    }

    // Pad & extend mode preserves extra columns rather than silently dropping them
    const extraColCsv = "a,b\n1\n2,3,4";
    const padded = convertTabularData(extraColCsv, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      raggedRowPolicy: "pad_and_extend",
      formulaProtection: false,
    });
    expect(padded.status).toBe("ok");
    if (padded.status === "ok") {
      expect(padded.paddedRowCount).toBe(1);
      expect(padded.extendedColumnCount).toBe(1);
      expect(padded.fullOutput).toContain('"extra_col_3": "4"');
    }

    // JSON union of keys across ALL records + __proto__ safety + lossless >2^53 integer
    const jsonUnion =
      '[{"id":9007199254740993,"__proto__":"p1"},{"id":9007199254740994,"only_in_second":19.90,"constructor":"c2"}]';
    const unionCsv = convertTabularData(jsonUnion, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(unionCsv.status).toBe("ok");
    if (unionCsv.status === "ok") {
      expect(unionCsv.fullOutput).toBe(
        [
          "id,__proto__,only_in_second,constructor",
          "9007199254740993,p1,,",
          "9007199254740994,,19.90,c2",
        ].join("\n"),
      );
    }
  });

  it("flattens nested objects, catches dot-key collisions, handles scalar arrays vs complex JSON cells, and preserves empty {} / []", () => {
    const nestedJson = [
      "[",
      '  {"user":"u1","address":{"city":"Shanghai","geo":{"lat":31.2304}},"meta":{},"tags":["a;b",null,9007199254740993],"events":[{"id":9007199254740995}]}',
      "]",
    ].join("");

    // Semicolon mode flags ambiguous scalar array (`a;b` & `null`) while keeping `events` & `meta` lossless
    const semiOut = convertTabularData(nestedJson, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      arrayMode: "semicolon",
      formulaProtection: false,
    });
    expect(semiOut.status).toBe("ok");
    if (semiOut.status === "ok") {
      expect(semiOut.ambiguousScalarArrayCount).toBe(1);
      expect(semiOut.fullOutput).toBe(
        [
          "user,address.city,address.geo.lat,meta,tags,events",
          'u1,Shanghai,31.2304,{},a;b;;9007199254740993,"[{""id"":9007199254740995}]"',
        ].join("\n"),
      );
    }

    // Compact JSON array mode preserves scalar arrays losslessly
    const jsonArrOut = convertTabularData(nestedJson, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      arrayMode: "compact_json",
      formulaProtection: false,
    });
    expect(jsonArrOut.status === "ok" && jsonArrOut.fullOutput).toContain(
      '"[""a;b"",null,9007199254740993]"',
    );

    // Literal `"address.city"` colliding with `{ address: { city: ... } }` errors by default, escapes with brackets when enabled
    const collidingJson = '[{"address.city":"literal","address":{"city":"nested"}}]';
    const colErr = convertTabularData(collidingJson, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      pathConflictPolicy: "error",
      formulaProtection: false,
    });
    expect(colErr.status === "error" && colErr.code).toBe("PATH_COLLISION");

    const colEscaped = convertTabularData(collidingJson, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      pathConflictPolicy: "bracket_escape",
      formulaProtection: false,
    });
    expect(colEscaped.status).toBe("ok");
    if (colEscaped.status === "ok") {
      expect(colEscaped.fullOutput).toBe('"[""address.city""]",address.city\nliteral,nested');
    }
  });

  it("distinguishes formula-like strings from genuine negative numbers and escapes Markdown pipes, backslashes, and newlines", () => {
    const formulaJson =
      '[{"delta":-42.50,"neg_str":"-19.90","expr":"-2+3","sum":"=SUM(A1:A2)","tab":"\\t=1+1"}]';

    // Raw mode (`formulaProtection: false`): counts 3 risky cells (`-2+3`, `=SUM...`, `\t=1+1`),
    // leaves `-42.50` and `"-19.90"` unflagged, and does NOT mutate output!
    const rawCsv = convertTabularData(formulaJson, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(rawCsv.status).toBe("ok");
    if (rawCsv.status === "ok") {
      expect(rawCsv.formulaLikeCellCount).toBe(3);
      expect(rawCsv.formulaProtectedCount).toBe(0);
      expect(rawCsv.fullOutput).toBe(
        "delta,neg_str,expr,sum,tab\n-42.50,-19.90,-2+3,=SUM(A1:A2),\t=1+1",
      );
    }

    // Protected mode (`formulaProtection: true`): prefixes ONLY the 3 formula-like strings, keeps `-42.50` & `-19.90`!
    const safeCsv = convertTabularData(formulaJson, {
      direction: "json_to_csv",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: true,
    });
    expect(safeCsv.status).toBe("ok");
    if (safeCsv.status === "ok") {
      expect(safeCsv.formulaProtectedCount).toBe(3);
      expect(safeCsv.fullOutput).toBe(
        "delta,neg_str,expr,sum,tab\n-42.50,-19.90,'-2+3,'=SUM(A1:A2),'\t=1+1",
      );
    }

    // Markdown escapes `\`, `|`, cell newlines (`<br>`), and keeps raw HTML inert text
    const mdCsv = 'col,detail\n"a|b\\c","line1\r\n<script>alert(1)</script>"';
    const mdRes = convertTabularData(mdCsv, {
      direction: "csv_to_md",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(mdRes.status).toBe("ok");
    if (mdRes.status === "ok") {
      expect(mdRes.fullOutput).toContain("a\\|b\\\\c");
      expect(mdRes.fullOutput).toContain("line1<br><script>alert(1)</script>");
    }

    // Input budget check (`> 8 MiB`)
    const tooBig = "a".repeat(MAX_TABULAR_INPUT_BYTES + 1);
    const limitRes = convertTabularData(tooBig, {
      direction: "csv_to_json",
      delimiter: ",",
      firstRowHeaders: true,
      detectTypes: false,
      formulaProtection: false,
    });
    expect(limitRes.status === "error" && limitRes.code).toBe("SIZE_LIMIT_EXCEEDED");
  });
});
