export type JsonRootKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export type JsonAstNode =
  | { kind: "object"; entries: Array<{ keyDecoded: string; keyRaw: string; value: JsonAstNode }> }
  | { kind: "array"; items: JsonAstNode[] }
  | { kind: "string"; rawLiteral: string; decoded: string }
  | { kind: "number"; rawLiteral: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

export interface JsonSyntaxErrorInfo {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export type JsonProcessResult =
  | {
      status: "empty";
    }
  | {
      status: "valid";
      rootKind: JsonRootKind;
      formatted: string;
      minified: string;
      hasPrecisionSensitiveNumbers: boolean;
      duplicateKeyCount: number;
    }
  | {
      status: "invalid";
      error: JsonSyntaxErrorInfo;
    };

export interface JsonFormatOptions {
  indent: "2" | "4" | "tab";
  sortKeys: boolean;
}

const MAX_NESTING_DEPTH = 512;
const MAX_SAFE_BIGINT = 9007199254740991n;
const MIN_SAFE_BIGINT = -9007199254740991n;

class JsonSyntaxException extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

export function computeLineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0d) {
      // CR or CRLF
      if (i + 1 < clamped && source.charCodeAt(i + 1) === 0x0a) {
        i++;
      }
      line++;
      column = 1;
    } else if (ch === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isNumberPrecisionSensitive(raw: string): boolean {
  if (/^-?\d+$/.test(raw)) {
    if (raw === "-0") return true;
    try {
      const bi = BigInt(raw);
      return bi > MAX_SAFE_BIGINT || bi < MIN_SAFE_BIGINT;
    } catch {
      return true;
    }
  }
  const asNum = Number(raw);
  if (!Number.isFinite(asNum)) {
    return true;
  }
  return String(asNum) !== raw;
}

class LosslessJsonParser {
  private readonly src: string;
  private pos = 0;
  public hasPrecisionSensitiveNumbers = false;
  public duplicateKeyCount = 0;

  constructor(source: string) {
    this.src = source;
    if (this.src.charCodeAt(0) === 0xfeff) {
      this.pos = 1;
    }
  }

  public parseRoot(): JsonAstNode {
    this.skipWhitespace();
    if (this.pos >= this.src.length) {
      throw new JsonSyntaxException("Unexpected end of JSON input", this.pos);
    }
    const root = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos < this.src.length) {
      throw new JsonSyntaxException(
        `Unexpected trailing token '${this.src[this.pos]}' after root JSON value`,
        this.pos,
      );
    }
    return root;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && isWhitespace(this.src.charCodeAt(this.pos))) {
      this.pos++;
    }
  }

  private parseValue(depth: number): JsonAstNode {
    if (depth > MAX_NESTING_DEPTH) {
      throw new JsonSyntaxException(
        `JSON nesting depth exceeds maximum safety limit (${MAX_NESTING_DEPTH})`,
        this.pos,
      );
    }
    if (this.pos >= this.src.length) {
      throw new JsonSyntaxException("Unexpected end of JSON input", this.pos);
    }

    const code = this.src.charCodeAt(this.pos);
    switch (code) {
      case 0x7b: // '{'
        return this.parseObject(depth + 1);
      case 0x5b: // '['
        return this.parseArray(depth + 1);
      case 0x22: // '"'
        return this.parseString();
      case 0x74: // 't'
        return this.parseKeyword("true", { kind: "boolean", value: true });
      case 0x66: // 'f'
        return this.parseKeyword("false", { kind: "boolean", value: false });
      case 0x6e: // 'n'
        return this.parseKeyword("null", { kind: "null" });
      default:
        if (code === 0x2d || isDigit(code)) {
          return this.parseNumber();
        }
        throw new JsonSyntaxException(`Unexpected token '${this.src[this.pos]}'`, this.pos);
    }
  }

  private parseKeyword(word: string, node: JsonAstNode): JsonAstNode {
    if (this.src.startsWith(word, this.pos)) {
      this.pos += word.length;
      return node;
    }
    throw new JsonSyntaxException(`Invalid literal starting at '${this.src[this.pos]}'`, this.pos);
  }

  private parseString(): Extract<JsonAstNode, { kind: "string" }> {
    const start = this.pos;
    this.pos++; // skip opening '"'
    let decoded = "";

    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos);
      if (code === 0x22) {
        this.pos++;
        return {
          kind: "string",
          rawLiteral: this.src.slice(start, this.pos),
          decoded,
        };
      }
      if (code < 0x20) {
        throw new JsonSyntaxException(
          "Unescaped control character inside string literal",
          this.pos,
        );
      }
      if (code === 0x5c) {
        // Backslash escape
        const escPos = this.pos;
        this.pos++;
        if (this.pos >= this.src.length) {
          throw new JsonSyntaxException("Unterminated escape sequence in string", escPos);
        }
        const esc = this.src.charCodeAt(this.pos);
        switch (esc) {
          case 0x22:
            decoded += '"';
            this.pos++;
            break;
          case 0x5c:
            decoded += "\\";
            this.pos++;
            break;
          case 0x2f:
            decoded += "/";
            this.pos++;
            break;
          case 0x62:
            decoded += "\b";
            this.pos++;
            break;
          case 0x66:
            decoded += "\f";
            this.pos++;
            break;
          case 0x6e:
            decoded += "\n";
            this.pos++;
            break;
          case 0x72:
            decoded += "\r";
            this.pos++;
            break;
          case 0x74:
            decoded += "\t";
            this.pos++;
            break;
          case 0x75: {
            this.pos++;
            if (this.pos + 4 > this.src.length) {
              throw new JsonSyntaxException("Incomplete \\uXXXX Unicode escape", escPos);
            }
            for (let k = 0; k < 4; k++) {
              if (!isHexDigit(this.src.charCodeAt(this.pos + k))) {
                throw new JsonSyntaxException(
                  "Invalid hexadecimal digit in \\uXXXX Unicode escape",
                  this.pos + k,
                );
              }
            }
            const unit = Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16);
            this.pos += 4;
            decoded += String.fromCharCode(unit);
            break;
          }
          default:
            throw new JsonSyntaxException(
              `Invalid escape character '\\${this.src[this.pos]}' in string`,
              escPos,
            );
        }
      } else {
        decoded += this.src[this.pos];
        this.pos++;
      }
    }

    throw new JsonSyntaxException("Unterminated string literal", start);
  }

  private parseNumber(): Extract<JsonAstNode, { kind: "number" }> {
    const start = this.pos;
    if (this.src.charCodeAt(this.pos) === 0x2d) {
      this.pos++;
      if (this.pos >= this.src.length || !isDigit(this.src.charCodeAt(this.pos))) {
        throw new JsonSyntaxException("Expected digit after '-' in number", this.pos);
      }
    }

    const firstDigit = this.src.charCodeAt(this.pos);
    if (firstDigit === 0x30) {
      this.pos++;
      if (this.pos < this.src.length && isDigit(this.src.charCodeAt(this.pos))) {
        throw new JsonSyntaxException("Leading zeros are not permitted in JSON numbers", this.pos);
      }
    } else if (isDigit(firstDigit)) {
      while (this.pos < this.src.length && isDigit(this.src.charCodeAt(this.pos))) {
        this.pos++;
      }
    } else {
      throw new JsonSyntaxException("Invalid number literal", this.pos);
    }

    // Fractional part
    if (this.pos < this.src.length && this.src.charCodeAt(this.pos) === 0x2e) {
      this.pos++;
      if (this.pos >= this.src.length || !isDigit(this.src.charCodeAt(this.pos))) {
        throw new JsonSyntaxException("Expected digit after decimal point in number", this.pos);
      }
      while (this.pos < this.src.length && isDigit(this.src.charCodeAt(this.pos))) {
        this.pos++;
      }
    }

    // Exponent part
    if (this.pos < this.src.length) {
      const expChar = this.src.charCodeAt(this.pos);
      if (expChar === 0x65 || expChar === 0x45) {
        this.pos++;
        if (this.pos < this.src.length) {
          const sign = this.src.charCodeAt(this.pos);
          if (sign === 0x2b || sign === 0x2d) {
            this.pos++;
          }
        }
        if (this.pos >= this.src.length || !isDigit(this.src.charCodeAt(this.pos))) {
          throw new JsonSyntaxException("Expected digit in number exponent", this.pos);
        }
        while (this.pos < this.src.length && isDigit(this.src.charCodeAt(this.pos))) {
          this.pos++;
        }
      }
    }

    const rawLiteral = this.src.slice(start, this.pos);
    if (!this.hasPrecisionSensitiveNumbers && isNumberPrecisionSensitive(rawLiteral)) {
      this.hasPrecisionSensitiveNumbers = true;
    }
    return { kind: "number", rawLiteral };
  }

  private parseArray(depth: number): Extract<JsonAstNode, { kind: "array" }> {
    this.pos++; // skip '['
    this.skipWhitespace();
    const items: JsonAstNode[] = [];

    if (this.pos < this.src.length && this.src.charCodeAt(this.pos) === 0x5d) {
      this.pos++;
      return { kind: "array", items };
    }

    while (true) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) {
        throw new JsonSyntaxException("Unterminated array (missing ']')", this.pos);
      }
      if (this.src.charCodeAt(this.pos) === 0x5d) {
        throw new JsonSyntaxException("Trailing comma before ']' is not valid JSON", this.pos);
      }
      items.push(this.parseValue(depth));
      this.skipWhitespace();

      if (this.pos >= this.src.length) {
        throw new JsonSyntaxException("Unterminated array (expected ',' or ']')", this.pos);
      }
      const next = this.src.charCodeAt(this.pos);
      if (next === 0x2c) {
        this.pos++;
        continue;
      }
      if (next === 0x5d) {
        this.pos++;
        return { kind: "array", items };
      }
      throw new JsonSyntaxException(
        `Expected ',' or ']' in array, found '${this.src[this.pos]}'`,
        this.pos,
      );
    }
  }

  private parseObject(depth: number): Extract<JsonAstNode, { kind: "object" }> {
    this.pos++; // skip '{'
    this.skipWhitespace();
    const entries: Array<{ keyDecoded: string; keyRaw: string; value: JsonAstNode }> = [];
    const seenKeys = new Set<string>();

    if (this.pos < this.src.length && this.src.charCodeAt(this.pos) === 0x7d) {
      this.pos++;
      return { kind: "object", entries };
    }

    while (true) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) {
        throw new JsonSyntaxException("Unterminated object (missing '}')", this.pos);
      }
      if (this.src.charCodeAt(this.pos) === 0x7d) {
        throw new JsonSyntaxException("Trailing comma before '}' is not valid JSON", this.pos);
      }
      if (this.src.charCodeAt(this.pos) !== 0x22) {
        throw new JsonSyntaxException(
          "Expected double-quoted property name in JSON object",
          this.pos,
        );
      }

      const keyNode = this.parseString();
      if (seenKeys.has(keyNode.decoded)) {
        this.duplicateKeyCount++;
      } else {
        seenKeys.add(keyNode.decoded);
      }

      this.skipWhitespace();
      if (this.pos >= this.src.length || this.src.charCodeAt(this.pos) !== 0x3a) {
        throw new JsonSyntaxException("Expected ':' after object property name", this.pos);
      }
      this.pos++; // skip ':'

      this.skipWhitespace();
      const value = this.parseValue(depth);
      entries.push({
        keyDecoded: keyNode.decoded,
        keyRaw: keyNode.rawLiteral,
        value,
      });

      this.skipWhitespace();
      if (this.pos >= this.src.length) {
        throw new JsonSyntaxException("Unterminated object (expected ',' or '}')", this.pos);
      }
      const next = this.src.charCodeAt(this.pos);
      if (next === 0x2c) {
        this.pos++;
        continue;
      }
      if (next === 0x7d) {
        this.pos++;
        return { kind: "object", entries };
      }
      throw new JsonSyntaxException(
        `Expected ',' or '}' in object, found '${this.src[this.pos]}'`,
        this.pos,
      );
    }
  }
}

function serializeAst(
  node: JsonAstNode,
  indentUnit: string | null,
  sortKeys: boolean,
  depth = 0,
): string {
  switch (node.kind) {
    case "null":
      return "null";
    case "boolean":
      return node.value ? "true" : "false";
    case "number":
      return node.rawLiteral;
    case "string":
      return node.rawLiteral;
    case "array": {
      if (node.items.length === 0) {
        return "[]";
      }
      if (indentUnit === null) {
        return `[${node.items.map((item) => serializeAst(item, null, sortKeys, depth + 1)).join(",")}]`;
      }
      const childPad = indentUnit.repeat(depth + 1);
      const closePad = indentUnit.repeat(depth);
      const body = node.items
        .map((item) => `${childPad}${serializeAst(item, indentUnit, sortKeys, depth + 1)}`)
        .join(",\n");
      return `[\n${body}\n${closePad}]`;
    }
    case "object": {
      if (node.entries.length === 0) {
        return "{}";
      }
      const ordered = sortKeys
        ? [...node.entries].sort((a, b) =>
            a.keyDecoded < b.keyDecoded ? -1 : a.keyDecoded > b.keyDecoded ? 1 : 0,
          )
        : node.entries;

      if (indentUnit === null) {
        return `{${ordered
          .map((e) => `${e.keyRaw}:${serializeAst(e.value, null, sortKeys, depth + 1)}`)
          .join(",")}}`;
      }
      const childPad = indentUnit.repeat(depth + 1);
      const closePad = indentUnit.repeat(depth);
      const body = ordered
        .map(
          (e) =>
            `${childPad}${e.keyRaw}: ${serializeAst(e.value, indentUnit, sortKeys, depth + 1)}`,
        )
        .join(",\n");
      return `{\n${body}\n${closePad}}`;
    }
  }
}

export type LosslessJsonAstParseResult =
  | {
      status: "valid";
      ast: JsonAstNode;
      formatted: string;
      hasPrecisionSensitiveNumbers: boolean;
      duplicateKeyCount: number;
    }
  | {
      status: "invalid";
      error: JsonSyntaxErrorInfo;
    };

export function parseLosslessJsonAst(input: string, indentUnit = "  "): LosslessJsonAstParseResult {
  try {
    const parser = new LosslessJsonParser(input);
    const ast = parser.parseRoot();
    return {
      status: "valid",
      ast,
      formatted: serializeAst(ast, indentUnit, false),
      hasPrecisionSensitiveNumbers: parser.hasPrecisionSensitiveNumbers,
      duplicateKeyCount: parser.duplicateKeyCount,
    };
  } catch (err) {
    if (err instanceof JsonSyntaxException) {
      const { line, column } = computeLineAndColumn(input, err.offset);
      return {
        status: "invalid",
        error: {
          message: err.message,
          offset: err.offset,
          line,
          column,
        },
      };
    }
    return {
      status: "invalid",
      error: {
        message: err instanceof Error ? err.message : "Invalid JSON",
        offset: 0,
        line: 1,
        column: 1,
      },
    };
  }
}

export function processJsonText(input: string, options: JsonFormatOptions): JsonProcessResult {
  if (input.trim().length === 0) {
    return { status: "empty" };
  }

  try {
    const parser = new LosslessJsonParser(input);
    const ast = parser.parseRoot();
    const indentUnit = options.indent === "tab" ? "\t" : options.indent === "4" ? "    " : "  ";

    return {
      status: "valid",
      rootKind: ast.kind,
      formatted: serializeAst(ast, indentUnit, options.sortKeys),
      minified: serializeAst(ast, null, options.sortKeys),
      hasPrecisionSensitiveNumbers: parser.hasPrecisionSensitiveNumbers,
      duplicateKeyCount: parser.duplicateKeyCount,
    };
  } catch (err) {
    if (err instanceof JsonSyntaxException) {
      const { line, column } = computeLineAndColumn(input, err.offset);
      return {
        status: "invalid",
        error: {
          message: err.message,
          offset: err.offset,
          line,
          column,
        },
      };
    }
    return {
      status: "invalid",
      error: {
        message: err instanceof Error ? err.message : "Invalid JSON",
        offset: 0,
        line: 1,
        column: 1,
      },
    };
  }
}
