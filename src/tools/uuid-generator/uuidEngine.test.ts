import { describe, expect, it } from "vitest";
import {
  formatUuidDisplay,
  generateUuidBatchClientFallback,
  inspectUuidClientFallback,
} from "./uuidEngine";

describe("D04 UUID v4 / v7 RFC 9562 engine & inspector", () => {
  it("validates RFC 9562 Appendix A vectors without fabricating timestamps for v4", () => {
    // RFC 9562 Appendix A.4 v4
    const v4 = inspectUuidClientFallback("919108f7-52d1-4320-9bac-f847db4148a8");
    expect(v4.version).toBe(4);
    expect(v4.variant).toBe("RFC 9562 / RFC 4122 (10x)");
    expect(v4.unixTimestampMs).toBeNull();

    // RFC 9562 Appendix A.6 v7: 2022-02-22T19:22:22.000Z (1645557742000 ms)
    const v7 = inspectUuidClientFallback("017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
    expect(v7.version).toBe(7);
    expect(v7.variant).toBe("RFC 9562 / RFC 4122 (10x)");
    expect(v7.unixTimestampMs).toBe(1_645_557_742_000);
    expect(new Date(v7.unixTimestampMs!).toISOString()).toBe("2022-02-22T19:22:22.000Z");

    // RFC 9562 Appendix A.1 v1 — must NOT pretend v1 has a decoded Unix v7 timestamp
    const v1 = inspectUuidClientFallback("C232AB00-9414-11EC-B3C8-9F6BDECED846");
    expect(v1.version).toBe(1);
    expect(v1.unixTimestampMs).toBeNull();

    // Nil and Max UUIDs
    expect(inspectUuidClientFallback("00000000000000000000000000000000").isNil).toBe(true);
    expect(inspectUuidClientFallback("urn:uuid:ffffffff-ffff-ffff-ffff-ffffffffffff").isMax).toBe(
      true,
    );
  });

  it("generates bounded v4/v7 batches with valid version/variant bits and formats case/hyphens", () => {
    const batch = generateUuidBatchClientFallback("v7", 10);
    expect(batch).toHaveLength(10);
    for (const id of batch) {
      const parsed = inspectUuidClientFallback(id);
      expect(parsed.version).toBe(7);
      expect(parsed.variant).toBe("RFC 9562 / RFC 4122 (10x)");
      expect(parsed.unixTimestampMs).toBeGreaterThan(1_700_000_000_000);
    }

    expect(
      formatUuidDisplay("017f22e2-79b0-7cc3-98c4-dc0c0c07398f", {
        uppercase: true,
        hyphens: false,
      }),
    ).toBe("017F22E279B07CC398C4DC0C0C07398F");

    expect(() => generateUuidBatchClientFallback("v4", 0)).toThrow();
    expect(() => generateUuidBatchClientFallback("v4", 501)).toThrow();
  });
});
