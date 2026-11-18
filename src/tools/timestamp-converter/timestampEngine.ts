import type { TimestampUnit } from "../../lib/sessionStore";

export const MIN_EPOCH_NS = -62_104_060_800_000_000_000n; // 0002-01-01T00:00:00Z
export const MAX_EPOCH_NS = 253_370_764_799_999_999_999n; // 9998-12-31T23:59:59.999999999Z

const NS_PER_US = 1_000n;
const NS_PER_MS = 1_000_000n;
const NS_PER_SEC = 1_000_000_000n;

export interface ZonedDisplayCard {
  timeZone: string;
  civilDateTime: string;
  utcOffset: string;
  iso8601: string;
}

export interface EpochBreakdown {
  epochNs: bigint;
  seconds: string;
  milliseconds: string;
  microseconds: string;
  nanoseconds: string;
  subMsRemainderNs: bigint;
  hasCoarserTruncation: boolean;
  utc: ZonedDisplayCard;
  local: ZonedDisplayCard;
  custom: ZonedDisplayCard | null;
  customTzError: string | null;
}

export interface TimestampToDateOutput {
  usedUnit: TimestampUnit;
  suggestedUnit: TimestampUnit | null;
  breakdown: EpochBreakdown;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (r !== 0n && r < 0n !== b < 0n) {
    return q - 1n;
  }
  return q;
}

function floorMod(a: bigint, b: bigint): bigint {
  return a - floorDiv(a, b) * b;
}

export function isValidIanaTimeZone(tz: string): boolean {
  const trimmed = tz.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function getSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getCommonTimeZones(): string[] {
  const preferred = [
    "UTC",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Europe/London",
    "Europe/Berlin",
    "America/New_York",
    "America/Chicago",
    "America/Los_Angeles",
    "Australia/Sydney",
  ];
  return preferred.filter(isValidIanaTimeZone);
}

function civilUtcSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): bigint {
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(hour, minute, second, 0);
  return BigInt(dt.getTime()) / 1000n;
}

interface CivilParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function extractZonedCivilParts(utcSec: bigint, timeZone: string): CivilParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(Number(utcSec * 1000n)));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }
  const rawHour = Number(map.hour ?? "0");
  return {
    year: Number(map.year ?? "1970"),
    month: Number(map.month ?? "1"),
    day: Number(map.day ?? "1"),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.minute ?? "0"),
    second: Number(map.second ?? "0"),
  };
}

function formatOffsetSuffix(offsetSeconds: number, forIso: boolean): string {
  if (offsetSeconds === 0 && forIso) {
    return "Z";
  }
  const sign = offsetSeconds >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  const ss = abs % 60;
  const core = ss > 0 ? `${sign}${hh}:${mm}:${String(ss).padStart(2, "0")}` : `${sign}${hh}:${mm}`;
  return forIso ? core : `UTC${core}`;
}

function formatFractionalSeconds(subSecNs: bigint): string {
  if (subSecNs === 0n) {
    return "";
  }
  const raw9 = subSecNs.toString().padStart(9, "0");
  // Trim to ms (3), us (6), or full ns (9) without losing non-zero digits
  if (raw9.endsWith("000000")) {
    return `.${raw9.slice(0, 3)}`;
  }
  if (raw9.endsWith("000")) {
    return `.${raw9.slice(0, 6)}`;
  }
  return `.${raw9}`;
}

function formatZonedCard(epochNs: bigint, timeZone: string): ZonedDisplayCard {
  const floorSec = floorDiv(epochNs, NS_PER_SEC);
  const subSecNs = floorMod(epochNs, NS_PER_SEC);
  const civil = extractZonedCivilParts(floorSec, timeZone);
  const civilAsUtc = civilUtcSeconds(
    civil.year,
    civil.month,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  const offsetSec = Number(civilAsUtc - floorSec);

  const yyyy = String(civil.year).padStart(4, "0");
  const mo = String(civil.month).padStart(2, "0");
  const dd = String(civil.day).padStart(2, "0");
  const hh = String(civil.hour).padStart(2, "0");
  const mi = String(civil.minute).padStart(2, "0");
  const ss = String(civil.second).padStart(2, "0");
  const frac = formatFractionalSeconds(subSecNs);

  const isPureUtc = timeZone.toUpperCase() === "UTC" || timeZone === "Etc/UTC";
  const isoSuffix = isPureUtc ? "Z" : formatOffsetSuffix(offsetSec, true);

  return {
    timeZone,
    civilDateTime: `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}${frac}`,
    utcOffset: formatOffsetSuffix(offsetSec, false),
    iso8601: `${yyyy}-${mo}-${dd}T${hh}:${mi}:${ss}${frac}${isoSuffix}`,
  };
}

export function suggestUnitByMagnitude(
  val: bigint,
  selectedUnit: TimestampUnit,
): TimestampUnit | null {
  const abs = val < 0n ? -val : val;
  // Plausible modern epoch magnitudes (roughly 1973..2286):
  // s:  10^8 .. 10^10
  // ms: 10^11 .. 10^13
  // us: 10^14 .. 10^16
  // ns: 10^17 .. 10^19
  let likely: TimestampUnit | null = null;
  if (abs >= 100_000_000_000_000_000n) {
    likely = "ns";
  } else if (abs >= 100_000_000_000_000n) {
    likely = "us";
  } else if (abs >= 100_000_000_000n) {
    likely = "ms";
  } else if (abs >= 100_000_000n && abs < 100_000_000_000n) {
    likely = "s";
  }
  return likely && likely !== selectedUnit ? likely : null;
}

export function buildBreakdownFromEpochNs(epochNs: bigint, customTimeZone: string): EpochBreakdown {
  if (epochNs < MIN_EPOCH_NS || epochNs > MAX_EPOCH_NS) {
    throw new Error(
      "Timestamp out of supported 4-digit calendar range (0002-01-01 to 9998-12-31 UTC).",
    );
  }

  const seconds = floorDiv(epochNs, NS_PER_SEC);
  const milliseconds = floorDiv(epochNs, NS_PER_MS);
  const microseconds = floorDiv(epochNs, NS_PER_US);
  const subMsRemainderNs = floorMod(epochNs, NS_PER_MS);
  const hasCoarserTruncation = floorMod(epochNs, NS_PER_SEC) !== 0n;

  const localTz = getSystemTimeZone();
  const trimmedCustom = customTimeZone.trim();
  let customCard: ZonedDisplayCard | null = null;
  let customTzError: string | null = null;

  if (trimmedCustom) {
    if (isValidIanaTimeZone(trimmedCustom)) {
      customCard = formatZonedCard(epochNs, trimmedCustom);
    } else {
      customTzError = `Invalid IANA timezone: "${trimmedCustom}".`;
    }
  }

  return {
    epochNs,
    seconds: seconds.toString(),
    milliseconds: milliseconds.toString(),
    microseconds: microseconds.toString(),
    nanoseconds: epochNs.toString(),
    subMsRemainderNs,
    hasCoarserTruncation,
    utc: formatZonedCard(epochNs, "UTC"),
    local: formatZonedCard(epochNs, localTz),
    custom: customCard,
    customTzError,
  };
}

export function convertTimestampToDate(
  rawInput: string,
  unit: TimestampUnit,
  customTimeZone: string,
): TimestampToDateOutput {
  const match = /^\s*([+-]?\d+)\s*$/.exec(rawInput);
  if (!match?.[1]) {
    throw new Error(
      "Invalid timestamp: enter an exact integer (e.g. 0, -86400, 1700000000) without floating-point or non-digit characters.",
    );
  }

  const parsedBig = BigInt(match[1]);
  const suggestedUnit = suggestUnitByMagnitude(parsedBig, unit);

  const multiplier =
    unit === "s" ? NS_PER_SEC : unit === "ms" ? NS_PER_MS : unit === "us" ? NS_PER_US : 1n;

  const epochNs = parsedBig * multiplier;
  if (epochNs < MIN_EPOCH_NS || epochNs > MAX_EPOCH_NS) {
    const hint = suggestedUnit ? ` (did you mean unit '${suggestedUnit}'?)` : "";
    throw new Error(
      `Timestamp with unit '${unit}' overflows calendar range (0002–9998 UTC)${hint}.`,
    );
  }

  return {
    usedUnit: unit,
    suggestedUnit,
    breakdown: buildBreakdownFromEpochNs(epochNs, customTimeZone),
  };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function maxDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export function convertDateToTimestamp(
  rawDate: string,
  interpretTimeZone: string,
  customDisplayTimeZone: string,
): EpochBreakdown {
  const trimmed = rawDate.trim();
  if (!trimmed) {
    throw new Error("Date/time input is empty.");
  }

  const re =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/;
  const m = re.exec(trimmed);
  if (!m) {
    throw new Error("Invalid date format: expected YYYY-MM-DD[THH:mm[:ss[.fffffffff]]][Z|±HH:MM].");
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] !== undefined ? Number(m[4]) : 0;
  const minute = m[5] !== undefined ? Number(m[5]) : 0;
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  const fracRaw = m[7] ?? "";
  const offsetToken = m[8];

  if (year < 2 || year > 9998) {
    throw new Error(`Year ${year} is outside supported range (0002–9998).`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month ${month} (must be 01–12).`);
  }
  const maxDay = maxDaysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new Error(
      `Invalid calendar date ${m[1]}-${m[2]}-${m[3]}: month ${m[2]} in year ${year} has at most ${maxDay} days.`,
    );
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid clock time ${m[4]}:${m[5]}:${m[6] ?? "00"}.`);
  }

  const subSecNs = fracRaw ? BigInt(fracRaw.padEnd(9, "0")) : 0n;
  const baseCivilSec = civilUtcSeconds(year, month, day, hour, minute, second);

  let resolvedUtcSec: bigint;

  if (offsetToken) {
    if (offsetToken === "Z" || offsetToken === "z") {
      resolvedUtcSec = baseCivilSec;
    } else {
      const sign = offsetToken.startsWith("-") ? -1n : 1n;
      const digits = offsetToken.slice(1).replace(":", "");
      const offH = Number(digits.slice(0, 2));
      const offM = Number(digits.slice(2, 4));
      if (offH > 23 || offM > 59) {
        throw new Error(`Invalid UTC offset "${offsetToken}".`);
      }
      const offSec = sign * BigInt(offH * 3600 + offM * 60);
      resolvedUtcSec = baseCivilSec - offSec;
    }
  } else {
    const tz = interpretTimeZone.trim();
    if (!isValidIanaTimeZone(tz)) {
      throw new Error(
        `Offset-less date requires a valid IANA timezone (got "${interpretTimeZone}").`,
      );
    }

    // Probe offsets across ±36 hours around `baseCivilSec` to discover all candidate UTC instants
    const probeHours = [-36n, -18n, -6n, -2n, 0n, 2n, 6n, 18n, 36n];
    const candidateOffsets = new Set<bigint>();
    for (const hOff of probeHours) {
      const probeSec = baseCivilSec + hOff * 3600n;
      const parts = extractZonedCivilParts(probeSec, tz);
      const asUtc = civilUtcSeconds(
        parts.year,
        parts.month,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      candidateOffsets.add(asUtc - probeSec);
    }

    const validMatches: Array<{ utcSec: bigint; offsetSec: number }> = [];
    const seenUtc = new Set<string>();
    for (const off of candidateOffsets) {
      const candUtc = baseCivilSec - off;
      const key = candUtc.toString();
      if (seenUtc.has(key)) continue;
      const check = extractZonedCivilParts(candUtc, tz);
      if (
        check.year === year &&
        check.month === month &&
        check.day === day &&
        check.hour === hour &&
        check.minute === minute &&
        check.second === second
      ) {
        seenUtc.add(key);
        validMatches.push({ utcSec: candUtc, offsetSec: Number(off) });
      }
    }

    if (validMatches.length === 0) {
      throw new Error(
        `Non-existent local time in ${tz} (DST spring-forward gap): "${trimmed}" never occurred. Provide an explicit UTC offset (e.g. ±HH:MM).`,
      );
    }

    if (validMatches.length > 1) {
      validMatches.sort((a, b) => (a.utcSec < b.utcSec ? -1 : 1));
      const offsetsDesc = validMatches
        .map((item) => formatOffsetSuffix(item.offsetSec, true))
        .join(" or ");
      throw new Error(
        `Ambiguous local time in ${tz} (DST fall-back fold): "${trimmed}" occurred twice (${offsetsDesc}). Provide an explicit UTC offset to disambiguate.`,
      );
    }

    resolvedUtcSec = validMatches[0]!.utcSec;
  }

  const totalNs = resolvedUtcSec * NS_PER_SEC + subSecNs;
  return buildBreakdownFromEpochNs(totalNs, customDisplayTimeZone);
}
