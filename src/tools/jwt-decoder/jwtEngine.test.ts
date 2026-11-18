import { describe, expect, it } from "vitest";
import { decodeJwtToken, evaluateJwtTimeClaims, verifyJwtHmacClientFallback } from "./jwtEngine";

// Official IETF RFC 7515 Appendix A.1.1 JWS HMAC-SHA256 vector (contains CRLF whitespace inside JSON)
const RFC7515_A1_TOKEN =
  "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7515_A1_KEY_B64URL =
  "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow";

// Independent OpenSSL reference vectors for HS256, HS384, HS512
const VEC_HS256 =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.reGQzG3OKdoIMWLDKOZ4TICJit3EW69cQE72E2CfzRE";
const VEC_HS384 =
  "eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.bQTnz6AuMJvmXXQsVPrxeQNvzDkimo7VNXxHeSBfClLufmCVZRUuyTwJF311JHuh";
const VEC_HS512 =
  "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.VFb0qJ1LRg_4ujbZoRMXnVkUgiuKq5KxWqNdbKq_G9Vvz-S1zZa9LPxtHWKa64zDl2ofkT8F6jBt_K4riU-fPg";

function toB64Url(utf8: string): string {
  return Buffer.from(utf8, "utf-8").toString("base64url");
}

describe("D05 jwtEngine — decoding, lossless claims, JWE detection, HMAC & NumericDate", () => {
  it("strips Bearer prefix and matching outer quotes without mutating internal characters and preserves 64-bit integer claims", () => {
    const hdr = toB64Url('{"alg":"HS256","typ":"JWT"}');
    const pay = toB64Url(
      '{"sub":"u1","snowflake_id":9007199254740993,"big_u64":18446744073709551615}',
    );
    const wrapped = `  "Bearer   ${hdr}.${pay}.dGVzdA"  `;

    const res = decodeJwtToken(wrapped);
    expect(res.kind).toBe("jws");
    if (res.kind !== "jws") return;

    expect(res.envelope.strippedBearer).toBe(true);
    expect(res.envelope.strippedQuotes).toBe(true);
    expect(res.hasPrecisionSensitiveNumbers).toBe(true);
    expect(res.payloadFormatted).toContain("9007199254740993");
    expect(res.payloadFormatted).toContain("18446744073709551615");
  });

  it("identifies 5-part encrypted JWE tokens and decodes protected header without misparsing as JWS", () => {
    const jweHdr = toB64Url('{"alg":"RSA-OAEP-256","enc":"A256GCM"}');
    const jwe = `${jweHdr}.ekey.iv.ciphertext.authtag`;
    const res = decodeJwtToken(jwe);

    expect(res.kind).toBe("jwe_encrypted");
    if (res.kind !== "jwe_encrypted") return;
    expect(res.headerAlg).toBe("RSA-OAEP-256");
    expect(res.headerEnc).toBe("A256GCM");
    expect(res.protectedHeaderFormatted).toContain('"A256GCM"');
  });

  it("reports accurate decode errors for wrong segment counts, malformed Base64url, invalid UTF-8, and invalid JSON", () => {
    const twoSeg = decodeJwtToken("abc.def");
    expect(twoSeg.kind === "error" && twoSeg.error.code).toBe("WRONG_SEGMENT_COUNT");

    const badB64 = decodeJwtToken("eyJhbGciOiJIUzI1NiJ9===.eyJzdWIiOiIxIn0.c2ln");
    expect(badB64.kind === "error" && badB64.error.code).toBe("MALFORMED_BASE64URL");

    const invalidUtf8Payload = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url");
    const badUtf8 = decodeJwtToken(`${toB64Url('{"alg":"HS256"}')}.${invalidUtf8Payload}.c2ln`);
    expect(badUtf8.kind === "error" && badUtf8.error.code).toBe("INVALID_UTF8");

    const badJson = decodeJwtToken(`${toB64Url('{"alg":"HS256"}')}.${toB64Url("{broken")}.c2ln`);
    expect(badJson.kind === "error" && badJson.error.code).toBe("INVALID_JSON");
  });

  it("verifies independent RFC 7515 A.1.1 and OpenSSL HS256/HS384/HS512 vectors and rejects tampering, wrong key, alg mismatch, alg=none, RS256, and crit", async () => {
    // RFC 7515 A.1.1 (Base64url key + raw CRLF inside JSON)
    const rfcOk = await verifyJwtHmacClientFallback({
      rawToken: RFC7515_A1_TOKEN,
      expectedAlgorithm: "HS256",
      secret: RFC7515_A1_KEY_B64URL,
      secretEncoding: "base64",
    });
    expect(rfcOk.outcome).toBe("valid");
    expect(rfcOk.keyByteLength).toBe(64);

    // Same key string in UTF-8 mode must NOT match
    const rfcWrongMode = await verifyJwtHmacClientFallback({
      rawToken: RFC7515_A1_TOKEN,
      expectedAlgorithm: "HS256",
      secret: RFC7515_A1_KEY_B64URL,
      secretEncoding: "utf8",
    });
    expect(rfcWrongMode.outcome).toBe("invalid_signature");

    // HS256 / HS384 / HS512 independent vectors
    for (const [token, alg, secret] of [
      [VEC_HS256, "HS256", "your-256-bit-secret"],
      [VEC_HS384, "HS384", "your-384-bit-secret"],
      [VEC_HS512, "HS512", "your-512-bit-secret"],
    ] as const) {
      const ok = await verifyJwtHmacClientFallback({
        rawToken: token,
        expectedAlgorithm: alg,
        secret,
        secretEncoding: "utf8",
      });
      expect(ok.outcome).toBe("valid");

      const wrongSecret = await verifyJwtHmacClientFallback({
        rawToken: token,
        expectedAlgorithm: alg,
        secret: `${secret}_bad`,
        secretEncoding: "utf8",
      });
      expect(wrongSecret.outcome).toBe("invalid_signature");
    }

    // Tampered payload
    const [h0, , s0] = VEC_HS256.split(".");
    const tampered = `${h0}.${toB64Url('{"sub":"1234567890","admin":false}')}.${s0}`;
    const tamperedRes = await verifyJwtHmacClientFallback({
      rawToken: tampered,
      expectedAlgorithm: null,
      secret: "your-256-bit-secret",
      secretEncoding: "utf8",
    });
    expect(tamperedRes.outcome).toBe("invalid_signature");

    // Algorithm mismatch
    const mismatch = await verifyJwtHmacClientFallback({
      rawToken: VEC_HS256,
      expectedAlgorithm: "HS384",
      secret: "your-256-bit-secret",
      secretEncoding: "utf8",
    });
    expect(mismatch.outcome).toBe("algorithm_mismatch");

    // alg=none -> unsigned_alg_none (never valid!)
    const noneToken = `${toB64Url('{"alg":"none","typ":"JWT"}')}.${toB64Url('{"sub":"1"}')}.`;
    const noneRes = await verifyJwtHmacClientFallback({
      rawToken: noneToken,
      expectedAlgorithm: null,
      secret: "",
      secretEncoding: "utf8",
    });
    expect(noneRes.outcome).toBe("unsigned_alg_none");

    // Unsupported algorithm RS256
    const rsToken = `${toB64Url('{"alg":"RS256"}')}.${toB64Url('{"sub":"1"}')}.c2ln`;
    const rsRes = await verifyJwtHmacClientFallback({
      rawToken: rsToken,
      expectedAlgorithm: null,
      secret: "secret",
      secretEncoding: "utf8",
    });
    expect(rsRes.outcome).toBe("unsupported_algorithm");

    // Critical header `crit` must be rejected
    const critToken = `${toB64Url('{"alg":"HS256","crit":["b64"]}')}.${toB64Url('{"sub":"1"}')}.c2ln`;
    const critRes = await verifyJwtHmacClientFallback({
      rawToken: critToken,
      expectedAlgorithm: null,
      secret: "secret",
      secretEncoding: "utf8",
    });
    expect(critRes.outcome).toBe("unsupported_crit_header");
  });

  it("evaluates NumericDate exp/nbf/iat accurately across active, expired, not-yet-valid, missing, zero, invalid type, and overflow", () => {
    const refNowMs = 1_700_000_500_000; // 1700000500s

    // Active window + zero epoch iat
    const activeDec = decodeJwtToken(
      `${toB64Url('{"alg":"HS256"}')}.${toB64Url('{"iat":0,"nbf":1700000000,"exp":1700001000}')}.c2ln`,
    );
    expect(activeDec.kind).toBe("jws");
    if (activeDec.kind === "jws") {
      const ev = evaluateJwtTimeClaims(activeDec.payloadAst, refNowMs);
      expect(ev.windowStatus).toBe("active");
      expect(ev.iat.status === "valid" && ev.iat.isZeroEpoch).toBe(true);
    }

    // Expired
    const expDec = decodeJwtToken(
      `${toB64Url('{"alg":"HS256"}')}.${toB64Url('{"exp":1700000500}')}.c2ln`,
    );
    if (expDec.kind === "jws") {
      expect(evaluateJwtTimeClaims(expDec.payloadAst, refNowMs).windowStatus).toBe("expired");
    }

    // Not yet valid (nbf in future)
    const nbfDec = decodeJwtToken(
      `${toB64Url('{"alg":"HS256"}')}.${toB64Url('{"nbf":1700009000,"exp":1700019000}')}.c2ln`,
    );
    if (nbfDec.kind === "jws") {
      expect(evaluateJwtTimeClaims(nbfDec.payloadAst, refNowMs).windowStatus).toBe("not_yet_valid");
    }

    // No time claims
    const noneDec = decodeJwtToken(
      `${toB64Url('{"alg":"HS256"}')}.${toB64Url('{"sub":"stateless"}')}.c2ln`,
    );
    if (noneDec.kind === "jws") {
      expect(evaluateJwtTimeClaims(noneDec.payloadAst, refNowMs).windowStatus).toBe("no_window");
    }

    // Non-numeric & overflow claims
    const badClaimsDec = decodeJwtToken(
      `${toB64Url('{"alg":"HS256"}')}.${toB64Url('{"exp":"tomorrow","nbf":999999999999999999}')}.c2ln`,
    );
    if (badClaimsDec.kind === "jws") {
      const ev = evaluateJwtTimeClaims(badClaimsDec.payloadAst, refNowMs);
      expect(ev.windowStatus).toBe("invalid_claim");
      expect(ev.exp.status).toBe("invalid_type");
      expect(ev.nbf.status).toBe("out_of_range");
    }
  });
});
