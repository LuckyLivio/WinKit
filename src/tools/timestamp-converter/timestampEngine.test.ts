import { describe, expect, it } from "vitest";
import { convertDateToTimestamp, convertTimestampToDate } from "./timestampEngine";

describe("D06 Lossless BigInt Timestamp Converter & Timezone/DST Engine", () => {
  it("handles epoch 0, negative timestamps, and exact s/ms/us/ns BigInt precision without Number rounding", () => {
    const zero = convertTimestampToDate("0", "s", "Asia/Tokyo");
    expect(zero.breakdown.utc.iso8601).toBe("1970-01-01T00:00:00Z");
    expect(zero.breakdown.custom?.iso8601).toBe("1970-01-01T09:00:00+09:00");

    // Negative epoch (-86400 s -> 1969-12-31T00:00:00Z)
    const neg = convertTimestampToDate("-86400", "s", "UTC");
    expect(neg.breakdown.utc.iso8601).toBe("1969-12-31T00:00:00Z");

    // Exact nanosecond integer beyond IEEE-754 MAX_SAFE_INTEGER (1700000000123456789 ns > 9e15!)
    const nsExact = convertTimestampToDate("1700000000123456789", "ns", "America/New_York");
    expect(nsExact.usedUnit).toBe("ns");
    expect(nsExact.breakdown.nanoseconds).toBe("1700000000123456789");
    expect(nsExact.breakdown.microseconds).toBe("1700000000123456");
    expect(nsExact.breakdown.milliseconds).toBe("1700000000123");
    expect(nsExact.breakdown.seconds).toBe("1700000000");
    expect(nsExact.breakdown.subMsRemainderNs).toBe(456789n);
    expect(nsExact.breakdown.utc.iso8601).toBe("2023-11-14T22:13:20.123456789Z");

    // Non-silent unit suggestion: passing ms value while 's' is selected keeps 's' and suggests 'ms'
    const msInSec = convertTimestampToDate("1700000000", "ms", "UTC");
    expect(msInSec.usedUnit).toBe("ms");
    expect(msInSec.suggestedUnit).toBe("s");
  });

  it("validates leap days strictly and rejects invalid calendar dates instead of rolling into next month", () => {
    const leapValid = convertDateToTimestamp("2024-02-29T12:00:00Z", "UTC", "UTC");
    expect(leapValid.seconds).toBe("1709208000");

    // Non-leap year 2023-02-29 and April 31 MUST throw, never roll to March/May!
    expect(() => convertDateToTimestamp("2023-02-29T12:00:00Z", "UTC", "UTC")).toThrow(
      /at most 28 days/,
    );
    expect(() => convertDateToTimestamp("2026-04-31 08:00:00", "UTC", "UTC")).toThrow(
      /at most 30 days/,
    );
  });

  it("parses explicit ISO offsets accurately and rejects nonexistent/ambiguous DST local times independent of host OS timezone", () => {
    // Explicit +08:00 offset ignores interpretTimeZone
    const explicit = convertDateToTimestamp(
      "2026-11-18T08:00:00.000000123+08:00",
      "America/New_York",
      "Europe/London",
    );
    expect(explicit.utc.iso8601).toBe("2026-11-18T00:00:00.000000123Z");
    expect(explicit.nanoseconds.endsWith("000000123")).toBe(true);

    // DST Spring-Forward Gap in America/New_York: 2026-03-08 02:30:00 does NOT exist!
    expect(() => convertDateToTimestamp("2026-03-08 02:30:00", "America/New_York", "UTC")).toThrow(
      /spring-forward gap/,
    );

    // DST Fall-Back Fold in America/New_York: 2026-11-01 01:30:00 happens TWICE (-04:00 and -05:00)!
    expect(() => convertDateToTimestamp("2026-11-01 01:30:00", "America/New_York", "UTC")).toThrow(
      /fall-back fold.*-04:00.*-05:00/,
    );

    // Supplying explicit -04:00 or -05:00 disambiguates the exact instant cleanly (3600s apart)
    const firstFold = convertDateToTimestamp(
      "2026-11-01T01:30:00-04:00",
      "America/New_York",
      "UTC",
    );
    const secondFold = convertDateToTimestamp(
      "2026-11-01T01:30:00-05:00",
      "America/New_York",
      "UTC",
    );
    expect(BigInt(secondFold.seconds) - BigInt(firstFold.seconds)).toBe(3600n);
  });
});
