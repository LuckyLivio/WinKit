import { Geodesic } from "geographiclib-geodesic";
import {
  BoundedUtf8Builder,
  serializeTableToCsvBounded,
  utf8ByteLength,
  type ConcreteDelimiter,
  type CsvCellInput,
  type FormulaPreviewSample,
} from "../csv-json/csvJsonEngine";

export const MAX_SINGLE_COORDINATE_INPUT_BYTES = 16 * 1024; // 16 KiB UTF-8
export const MAX_BATCH_COORDINATE_INPUT_BYTES = 1 * 1024 * 1024; // 1 MiB UTF-8
export const MAX_BATCH_COORDINATE_LINES = 5_000;
export const MAX_BATCH_COORDINATE_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB UTF-8
export const MAX_BATCH_PREVIEW_ROWS = 200;

export const MIN_DD_DECIMALS = 0;
export const MAX_DD_DECIMALS = 8;
export const DEFAULT_DD_DECIMALS = 6;

export const MIN_DM_DECIMALS = 0;
export const MAX_DM_DECIMALS = 4;
export const DEFAULT_DM_DECIMALS = 3;

export const MIN_DMS_DECIMALS = 0;
export const MAX_DMS_DECIMALS = 4;
export const DEFAULT_DMS_DECIMALS = 2;

export interface Wgs84Point {
  readonly latitude: number;
  readonly longitude: number;
  readonly datum: "WGS84";
}

export type PlainTextAxisOrder = "lat_lon" | "lon_lat";

export type AxisOrderUsed = "lat_lon" | "lon_lat" | "hemisphere_tagged";

export type DetectedCoordinateFormat =
  | "separate_fields"
  | "dd"
  | "dm"
  | "dms"
  | "geojson_point"
  | "wkt_point"
  | "geo_uri"
  | "apple_maps_url"
  | "google_maps_url";

export type CoordinateOutputFormatId =
  "dd" | "dms" | "dm" | "geojson" | "wkt" | "geo_uri" | "apple_maps" | "google_maps";

export interface CoordinatePrecisionOptions {
  ddDecimals: number;
  dmDecimals: number;
  dmsDecimals: number;
}

export interface FormattedCoordinateOutputs {
  dd: string;
  dms: string;
  dm: string;
  geojson: string;
  wkt: string;
  geo_uri: string;
  apple_maps: string;
  google_maps: string;
}

export type CoordinateErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "UNSUPPORTED_CRS"
  | "UNSUPPORTED_EXTRA_DIMENSION"
  | "UNSUPPORTED_GEOJSON_GEOMETRY"
  | "UNSUPPORTED_WKT_GEOMETRY"
  | "EMPTY_GEOMETRY"
  | "UNSUPPORTED_GEO_URI_ALTITUDE"
  | "UNSUPPORTED_GEO_URI_PARAM"
  | "UNSUPPORTED_SHORT_LINK"
  | "MAPS_URL_REQUIRES_ONLINE_LOOKUP"
  | "MAPS_URL_VIEWPORT_OR_PLACE_UNSUPPORTED"
  | "UNSUPPORTED_URL_HOST"
  | "CONFLICTING_URL_COORDINATES"
  | "MULTILINE_GEOJSON_IN_BATCH"
  | "SIGN_HEMISPHERE_CONFLICT"
  | "CONFLICTING_HEMISPHERE_AXES"
  | "INCOMPLETE_HEMISPHERE_PAIR"
  | "WRONG_AXIS_HEMISPHERE"
  | "MINUTES_OUT_OF_RANGE"
  | "SECONDS_OUT_OF_RANGE"
  | "LATITUDE_OUT_OF_RANGE"
  | "LONGITUDE_OUT_OF_RANGE"
  | "INVALID_COORDINATE_SYNTAX"
  | "GEODESIC_SOLVE_FAILED";

export interface CoordinateParseError {
  ok: false;
  code: CoordinateErrorCode;
  message: string;
}

export interface CoordinateParseSuccess {
  ok: true;
  point: Wgs84Point;
  detectedFormat: DetectedCoordinateFormat;
  axisOrderUsed: AxisOrderUsed;
}

export type CoordinateParseResult = CoordinateParseSuccess | CoordinateParseError;

export interface Wgs84DistanceResult {
  ok: true;
  meters: number;
  kilometers: number;
  miles: number;
  ellipsoid: "WGS84";
}

export type GeodesicDistanceOutcome =
  | Wgs84DistanceResult
  | {
      ok: false;
      code: CoordinateErrorCode;
      pointRole?: "A" | "B";
      message: string;
    };

export type BatchRowResult =
  | {
      lineNumber: number;
      rawInput: string;
      status: "ok";
      latitude: number;
      longitude: number;
      detectedFormat: DetectedCoordinateFormat;
      axisOrderUsed: AxisOrderUsed;
      formattedOutput: string;
    }
  | {
      lineNumber: number;
      rawInput: string;
      status: "error";
      errorCode: CoordinateErrorCode;
      errorMessage: string;
    };

export interface BatchCoordinateOptions {
  plainAxisOrder: PlainTextAxisOrder;
  outputFormat: CoordinateOutputFormatId;
  precision: CoordinatePrecisionOptions;
  csvExportScope?: "all_with_errors" | "valid_only";
  csvDelimiter?: ConcreteDelimiter;
  csvLineEnding?: "lf" | "crlf";
  csvIncludeBom?: boolean;
  formulaProtection: boolean;
}

export interface BatchBudgetOverrides {
  maxInputBytes?: number;
  maxLines?: number;
  maxSingleLineBytes?: number;
  maxOutputBytes?: number;
}

export type BatchCoordinateConversionResult =
  | {
      status: "empty";
    }
  | {
      status: "error";
      code: "BATCH_INPUT_TOO_LARGE" | "BATCH_LINE_LIMIT_EXCEEDED" | "BATCH_OUTPUT_LIMIT_EXCEEDED";
      message: string;
      actual?: number;
      limit?: number;
    }
  | {
      status: "ok";
      rows: BatchRowResult[];
      previewRows: BatchRowResult[];
      previewTruncated: boolean;
      totalNonBlankCount: number;
      validCount: number;
      errorCount: number;
      skippedBlankCount: number;
      validFormattedText: string;
      csvOutputText: string;
      csvByteLength: number;
      formulaLikeCellCount: number;
      formulaProtectedCount: number;
      formulaPreviewSamples: FormulaPreviewSample[];
    };

function normalizeZero(n: number): number {
  return Object.is(n, -0) || n === 0 ? 0 : n;
}

export function createWgs84Point(latitude: number, longitude: number): CoordinateParseResult {
  if (!Number.isFinite(latitude)) {
    return {
      ok: false,
      code: "LATITUDE_OUT_OF_RANGE",
      message: "Latitude must be a finite number in [-90, 90].",
    };
  }
  if (!Number.isFinite(longitude)) {
    return {
      ok: false,
      code: "LONGITUDE_OUT_OF_RANGE",
      message: "Longitude must be a finite number in [-180, 180].",
    };
  }
  if (latitude < -90 || latitude > 90) {
    return {
      ok: false,
      code: "LATITUDE_OUT_OF_RANGE",
      message: `Latitude ${latitude} is out of valid WGS 84 range [-90, 90].`,
    };
  }
  if (longitude < -180 || longitude > 180) {
    return {
      ok: false,
      code: "LONGITUDE_OUT_OF_RANGE",
      message: `Longitude ${longitude} is out of valid WGS 84 range [-180, 180] (no silent wrap-around).`,
    };
  }
  return {
    ok: true,
    point: {
      latitude: normalizeZero(latitude),
      longitude: normalizeZero(longitude),
      datum: "WGS84",
    },
    detectedFormat: "dd",
    axisOrderUsed: "lat_lon",
  };
}

function clampInt(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  const r = Math.trunc(val);
  return Math.min(max, Math.max(min, r));
}

export function normalizePrecisionOptions(
  raw?: Partial<CoordinatePrecisionOptions>,
): CoordinatePrecisionOptions {
  return {
    ddDecimals: clampInt(
      raw?.ddDecimals ?? DEFAULT_DD_DECIMALS,
      MIN_DD_DECIMALS,
      MAX_DD_DECIMALS,
      DEFAULT_DD_DECIMALS,
    ),
    dmDecimals: clampInt(
      raw?.dmDecimals ?? DEFAULT_DM_DECIMALS,
      MIN_DM_DECIMALS,
      MAX_DM_DECIMALS,
      DEFAULT_DM_DECIMALS,
    ),
    dmsDecimals: clampInt(
      raw?.dmsDecimals ?? DEFAULT_DMS_DECIMALS,
      MIN_DMS_DECIMALS,
      MAX_DMS_DECIMALS,
      DEFAULT_DMS_DECIMALS,
    ),
  };
}

/**
 * Locale-independent ASCII decimal formatter with `-0` elimination and trailing fractional zero trimming.
 * Always emits ASCII `.` regardless of OS locale.
 */
export function formatCleanDecimal(value: number, maxDecimals: number): string {
  const safeVal = normalizeZero(value);
  const fixed = safeVal.toFixed(maxDecimals);
  const trimmed =
    maxDecimals > 0 ? fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}

function formatScaledIntegerWithDecimals(scaledInt: number, decimals: number): string {
  if (decimals <= 0) {
    return String(scaledInt);
  }
  const factor = 10 ** decimals;
  const whole = Math.floor(scaledInt / factor);
  const frac = scaledInt - whole * factor;
  if (frac === 0) {
    return String(whole);
  }
  const fracStr = String(frac).padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

function formatSingleDms(value: number, isLatitude: boolean, dmsDecimals: number): string {
  const maxAbs = isLatitude ? 90 : 180;
  const clamped = Math.min(maxAbs, Math.max(-maxAbs, normalizeZero(value)));
  const unitsPerSec = 10 ** dmsDecimals;
  const unitsPerMin = 60 * unitsPerSec;
  const unitsPerDeg = 3600 * unitsPerSec;

  const totalUnits = Math.min(maxAbs * unitsPerDeg, Math.round(Math.abs(clamped) * unitsPerDeg));
  const deg = Math.floor(totalUnits / unitsPerDeg);
  const remAfterDeg = totalUnits - deg * unitsPerDeg;
  const min = Math.floor(remAfterDeg / unitsPerMin);
  const secUnits = remAfterDeg - min * unitsPerMin;

  // If rounded magnitude is 0, normalize hemisphere to N / E (never emit negative zero)
  const isNegative = totalUnits > 0 && clamped < 0;
  const hemi = isLatitude ? (isNegative ? "S" : "N") : isNegative ? "W" : "E";
  const secStr = formatScaledIntegerWithDecimals(secUnits, dmsDecimals);
  return `${deg}°${min}′${secStr}″${hemi}`;
}

function formatSingleDm(value: number, isLatitude: boolean, dmDecimals: number): string {
  const maxAbs = isLatitude ? 90 : 180;
  const clamped = Math.min(maxAbs, Math.max(-maxAbs, normalizeZero(value)));
  const unitsPerMin = 10 ** dmDecimals;
  const unitsPerDeg = 60 * unitsPerMin;

  const totalUnits = Math.min(maxAbs * unitsPerDeg, Math.round(Math.abs(clamped) * unitsPerDeg));
  const deg = Math.floor(totalUnits / unitsPerDeg);
  const minUnits = totalUnits - deg * unitsPerDeg;

  const isNegative = totalUnits > 0 && clamped < 0;
  const hemi = isLatitude ? (isNegative ? "S" : "N") : isNegative ? "W" : "E";
  const minStr = formatScaledIntegerWithDecimals(minUnits, dmDecimals);
  return `${deg}°${minStr}′${hemi}`;
}

export function formatAllCoordinateOutputs(
  point: Wgs84Point,
  rawPrecision?: Partial<CoordinatePrecisionOptions>,
): FormattedCoordinateOutputs {
  const prec = normalizePrecisionOptions(rawPrecision);
  const maxLatLonClamp = {
    lat: Math.min(90, Math.max(-90, normalizeZero(point.latitude))),
    lon: Math.min(180, Math.max(-180, normalizeZero(point.longitude))),
  };

  const latDd = formatCleanDecimal(maxLatLonClamp.lat, prec.ddDecimals);
  const lonDd = formatCleanDecimal(maxLatLonClamp.lon, prec.ddDecimals);

  const latDms = formatSingleDms(maxLatLonClamp.lat, true, prec.dmsDecimals);
  const lonDms = formatSingleDms(maxLatLonClamp.lon, false, prec.dmsDecimals);

  const latDm = formatSingleDm(maxLatLonClamp.lat, true, prec.dmDecimals);
  const lonDm = formatSingleDm(maxLatLonClamp.lon, false, prec.dmDecimals);

  return {
    dd: `${latDd}, ${lonDd}`,
    dms: `${latDms} ${lonDms}`,
    dm: `${latDm} ${lonDm}`,
    geojson: `{"type":"Point","coordinates":[${lonDd},${latDd}]}`,
    wkt: `POINT (${lonDd} ${latDd})`,
    geo_uri: `geo:${latDd},${lonDd}`,
    apple_maps: `https://maps.apple.com/place?coordinate=${latDd},${lonDd}`,
    google_maps: `https://www.google.com/maps/search/?api=1&query=${latDd}%2C${lonDd}`,
  };
}

export function formatCoordinateById(
  point: Wgs84Point,
  formatId: CoordinateOutputFormatId,
  precision?: Partial<CoordinatePrecisionOptions>,
): string {
  return formatAllCoordinateOutputs(point, precision)[formatId];
}

// Strict plain decimal number regex (no NaN, Infinity, hex, or scientific notation)
const STRICT_SIGNED_DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

interface ParsedSingleAngle {
  signedDegrees: number;
  absDegreesInt: number;
  hasNonZeroSubunits: boolean;
  hemisphere: "N" | "S" | "E" | "W" | null;
  form: "dd" | "dm" | "dms";
}

function parseSingleAngleToken(
  rawToken: string,
): { ok: true; angle: ParsedSingleAngle } | CoordinateParseError {
  const trimmed = rawToken.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "EMPTY_INPUT", message: "Coordinate component is empty." };
  }

  // Detect optional leading and/or trailing N/S/E/W designator
  let hemisphere: "N" | "S" | "E" | "W" | null = null;
  let core = trimmed;

  const leadMatch = /^([NSEW])(?:\s+|(?=[+-]?\d|\.\d))/i.exec(core);
  if (leadMatch) {
    hemisphere = leadMatch[1]!.toUpperCase() as "N" | "S" | "E" | "W";
    core = core.slice(leadMatch[0].length).trim();
  }

  const trailMatch = /(?:\s+|(?<=\d|[°º˚′'’″"”]))([NSEW])$/i.exec(core);
  if (trailMatch) {
    if (hemisphere !== null) {
      return {
        ok: false,
        code: "CONFLICTING_HEMISPHERE_AXES",
        message: `Coordinate token "${trimmed}" specifies multiple hemisphere letters.`,
      };
    }
    hemisphere = trailMatch[1]!.toUpperCase() as "N" | "S" | "E" | "W";
    core = core.slice(0, core.length - trailMatch[0].length).trim();
  }

  if (core.length === 0) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: `Invalid coordinate component "${trimmed}".`,
    };
  }

  let explicitSign: "+" | "-" | null = null;
  if (core.startsWith("+") || core.startsWith("-")) {
    explicitSign = core[0] as "+" | "-";
    core = core.slice(1).trim();
  }

  if (explicitSign === "+" && (hemisphere === "S" || hemisphere === "W")) {
    return {
      ok: false,
      code: "SIGN_HEMISPHERE_CONFLICT",
      message: `Explicit '+' sign conflicts with '${hemisphere}' hemisphere in "${trimmed}".`,
    };
  }
  if (explicitSign === "-" && (hemisphere === "N" || hemisphere === "E")) {
    return {
      ok: false,
      code: "SIGN_HEMISPHERE_CONFLICT",
      message: `Explicit '-' sign conflicts with '${hemisphere}' hemisphere in "${trimmed}".`,
    };
  }

  const signMultiplier = hemisphere === "S" || hemisphere === "W" || explicitSign === "-" ? -1 : 1;

  // Normalize two ASCII single quotes `''` into double prime `″`
  const norm = core.replace(/''/g, "″");

  // 1. Plain Decimal Degrees (with optional trailing degree symbol)
  const ddMatch = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:[°º˚]|deg)?$/i.exec(norm);
  if (ddMatch) {
    const mag = Number(ddMatch[1]!);
    if (!Number.isFinite(mag)) {
      return {
        ok: false,
        code: "INVALID_COORDINATE_SYNTAX",
        message: `Non-finite degree value in "${trimmed}".`,
      };
    }
    return {
      ok: true,
      angle: {
        signedDegrees: normalizeZero(signMultiplier * mag),
        absDegreesInt: Math.floor(mag),
        hasNonZeroSubunits: mag !== Math.floor(mag),
        hemisphere,
        form: "dd",
      },
    };
  }

  // 2. Degrees + Integer Minutes + Decimal Seconds (DMS — explicit symbols or 3 whitespace tokens)
  const dmsSymMatch =
    /^(\d+)\s*(?:[°º˚]|deg|d)\s*(\d+)\s*(?:[′'’]|m)\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:[″"”]|s)?$/i.exec(
      norm,
    );
  const dmsSpaceMatch = dmsSymMatch
    ? null
    : /^(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?|\.\d+)\s*[″"”]?$/.exec(norm);
  const dmsMatch = dmsSymMatch ?? dmsSpaceMatch;

  if (dmsMatch) {
    const deg = Number(dmsMatch[1]!);
    const min = Number(dmsMatch[2]!);
    const sec = Number(dmsMatch[3]!);
    if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) {
      return {
        ok: false,
        code: "INVALID_COORDINATE_SYNTAX",
        message: `Non-finite DMS component in "${trimmed}".`,
      };
    }
    if (min < 0 || min >= 60) {
      return {
        ok: false,
        code: "MINUTES_OUT_OF_RANGE",
        message: `Minutes (${min}) must be in [0, 60).`,
      };
    }
    if (sec < 0 || sec >= 60) {
      return {
        ok: false,
        code: "SECONDS_OUT_OF_RANGE",
        message: `Seconds (${sec}) must be in [0, 60).`,
      };
    }
    const mag = deg + min / 60 + sec / 3600;
    return {
      ok: true,
      angle: {
        signedDegrees: normalizeZero(signMultiplier * mag),
        absDegreesInt: deg,
        hasNonZeroSubunits: min > 0 || sec > 0,
        hemisphere,
        form: "dms",
      },
    };
  }

  // 3. Degrees + Decimal Minutes (DM — explicit symbols or 2 whitespace tokens)
  const dmSymMatch = /^(\d+)\s*(?:[°º˚]|deg|d)\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:[′'’]|m)?$/i.exec(norm);
  const dmSpaceMatch = dmSymMatch ? null : /^(\d+)\s+(\d+(?:\.\d+)?|\.\d+)\s*[′'’]$/.exec(norm);
  const dmMatch = dmSymMatch ?? dmSpaceMatch;

  if (dmMatch) {
    const deg = Number(dmMatch[1]!);
    const min = Number(dmMatch[2]!);
    if (!Number.isFinite(deg) || !Number.isFinite(min)) {
      return {
        ok: false,
        code: "INVALID_COORDINATE_SYNTAX",
        message: `Non-finite DM component in "${trimmed}".`,
      };
    }
    if (min < 0 || min >= 60) {
      return {
        ok: false,
        code: "MINUTES_OUT_OF_RANGE",
        message: `Minutes (${min}) must be in [0, 60).`,
      };
    }
    const mag = deg + min / 60;
    return {
      ok: true,
      angle: {
        signedDegrees: normalizeZero(signMultiplier * mag),
        absDegreesInt: deg,
        hasNonZeroSubunits: min > 0,
        hemisphere,
        form: "dm",
      },
    };
  }

  return {
    ok: false,
    code: "INVALID_COORDINATE_SYNTAX",
    message: `Unable to parse "${trimmed}" as DD, DM, or DMS coordinate.`,
  };
}

function validateAngleForAxis(
  angle: ParsedSingleAngle,
  axis: "lat" | "lon",
): CoordinateParseError | null {
  if (axis === "lat") {
    if (angle.hemisphere === "E" || angle.hemisphere === "W") {
      return {
        ok: false,
        code: "WRONG_AXIS_HEMISPHERE",
        message: `Hemisphere '${angle.hemisphere}' is only valid for longitude, not latitude.`,
      };
    }
    if (
      angle.signedDegrees < -90 ||
      angle.signedDegrees > 90 ||
      (angle.absDegreesInt === 90 && angle.hasNonZeroSubunits) ||
      angle.absDegreesInt > 90
    ) {
      return {
        ok: false,
        code: "LATITUDE_OUT_OF_RANGE",
        message: "Latitude must be within [-90°, 90°] with 0′0″ at ±90°.",
      };
    }
    return null;
  }

  if (angle.hemisphere === "N" || angle.hemisphere === "S") {
    return {
      ok: false,
      code: "WRONG_AXIS_HEMISPHERE",
      message: `Hemisphere '${angle.hemisphere}' is only valid for latitude, not longitude.`,
    };
  }
  if (
    angle.signedDegrees < -180 ||
    angle.signedDegrees > 180 ||
    (angle.absDegreesInt === 180 && angle.hasNonZeroSubunits) ||
    angle.absDegreesInt > 180
  ) {
    return {
      ok: false,
      code: "LONGITUDE_OUT_OF_RANGE",
      message: "Longitude must be within [-180°, 180°] with 0′0″ at ±180°.",
    };
  }
  return null;
}

export function parseSeparateLatLonFields(rawLat: string, rawLon: string): CoordinateParseResult {
  const latTrim = rawLat.trim();
  const lonTrim = rawLon.trim();
  if (latTrim.length === 0 && lonTrim.length === 0) {
    return { ok: false, code: "EMPTY_INPUT", message: "Enter latitude and longitude." };
  }
  if (
    utf8ByteLength(rawLat) > MAX_SINGLE_COORDINATE_INPUT_BYTES ||
    utf8ByteLength(rawLon) > MAX_SINGLE_COORDINATE_INPUT_BYTES
  ) {
    return {
      ok: false,
      code: "INPUT_TOO_LARGE",
      message: "Coordinate input exceeds the 16 KiB single-point limit.",
    };
  }
  if (latTrim.length === 0 || lonTrim.length === 0) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "Both Latitude and Longitude fields are required.",
    };
  }

  const latParsed = parseSingleAngleToken(latTrim);
  if (!latParsed.ok) return latParsed;
  const latErr = validateAngleForAxis(latParsed.angle, "lat");
  if (latErr) return latErr;

  const lonParsed = parseSingleAngleToken(lonTrim);
  if (!lonParsed.ok) return lonParsed;
  const lonErr = validateAngleForAxis(lonParsed.angle, "lon");
  if (lonErr) return lonErr;

  return {
    ok: true,
    point: {
      latitude: latParsed.angle.signedDegrees,
      longitude: lonParsed.angle.signedDegrees,
      datum: "WGS84",
    },
    detectedFormat: "separate_fields",
    axisOrderUsed: "lat_lon",
  };
}

function detectExplicitUnsupportedCrsPrefix(trimmed: string): CoordinateParseError | null {
  if (/\b(?:GCJ-?02|BD-?09|CGCS\s*2000|MGRS|Web\s*Mercator)\b/i.test(trimmed)) {
    return {
      ok: false,
      code: "UNSUPPORTED_CRS",
      message:
        "Explicit non-WGS84 coordinate system (GCJ-02 / BD-09 / CGCS2000 / MGRS / Web Mercator) is not supported; WinKit D10 processes 2D WGS 84 geographic coordinates only.",
    };
  }
  const epsgMatch = /\bEPSG\s*:\s*(\d+)\b/i.exec(trimmed);
  if (epsgMatch && epsgMatch[1] !== "4326") {
    return {
      ok: false,
      code: "UNSUPPORTED_CRS",
      message: `EPSG:${epsgMatch[1]} is not supported; only 2D WGS 84 (EPSG:4326 / CRS84) is supported.`,
    };
  }
  // UTM grid notation like `10S 545896 4185960` or `51R 348000 3456000`
  if (/^\d{1,2}\s*[C-HJ-NP-X]\s+\d{5,7}(?:\.\d+)?\s+\d{5,8}(?:\.\d+)?$/i.test(trimmed)) {
    return {
      ok: false,
      code: "UNSUPPORTED_CRS",
      message:
        "Projected UTM grid coordinates are not supported; enter 2D WGS 84 latitude and longitude.",
    };
  }
  return null;
}

function isAllowedGeoJsonCrs(crs: unknown): boolean {
  if (crs === undefined || crs === null) return true;
  if (typeof crs !== "object") return false;
  const obj = crs as Record<string, unknown>;
  if (obj.type !== "name" || !obj.properties || typeof obj.properties !== "object") {
    return false;
  }
  const nameRaw = (obj.properties as Record<string, unknown>).name;
  if (typeof nameRaw !== "string") return false;
  const norm = nameRaw.trim().toUpperCase();
  return (
    norm === "CRS84" ||
    norm === "URN:OGC:DEF:CRS:OGC:1.3:CRS84" ||
    norm === "URN:OGC:DEF:CRS:OGC::CRS84"
  );
}

function extractPointCoordsFromGeoJsonPosition(coords: unknown): CoordinateParseResult {
  if (!Array.isArray(coords)) {
    return {
      ok: false,
      code: "UNSUPPORTED_GEOJSON_GEOMETRY",
      message: "GeoJSON Point coordinates must be a numeric [longitude, latitude] array.",
    };
  }
  if (coords.length === 0) {
    return {
      ok: false,
      code: "EMPTY_GEOMETRY",
      message: "GeoJSON Point coordinates array is empty.",
    };
  }
  if (coords.length > 2) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTRA_DIMENSION",
      message: `GeoJSON position has ${coords.length} elements (3D altitude/M is not silently dropped in 2D WGS 84 mode).`,
    };
  }
  if (coords.length < 2) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "GeoJSON Point position requires [longitude, latitude].",
    };
  }

  const lon = coords[0];
  const lat = coords[1];
  if (
    typeof lon !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat)
  ) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "GeoJSON Point [longitude, latitude] elements must be finite numbers.",
    };
  }

  const validated = createWgs84Point(lat, lon);
  if (!validated.ok) return validated;
  return {
    ok: true,
    point: validated.point,
    detectedFormat: "geojson_point",
    axisOrderUsed: "lon_lat",
  };
}

function parseGeoJsonInput(trimmed: string): CoordinateParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "Invalid JSON syntax in GeoJSON coordinate input.",
    };
  }

  if (Array.isArray(parsed)) {
    if (parsed.some((item) => Array.isArray(item) || (item !== null && typeof item === "object"))) {
      return {
        ok: false,
        code: "UNSUPPORTED_GEOJSON_GEOMETRY",
        message:
          "Multi-point or nested coordinate arrays are not supported; provide a single 2D Point.",
      };
    }
    return extractPointCoordsFromGeoJsonPosition(parsed);
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "GeoJSON input must be a Point object or Feature with a 2D Point geometry.",
    };
  }

  const obj = parsed as Record<string, unknown>;
  if ("crs" in obj && !isAllowedGeoJsonCrs(obj.crs)) {
    return {
      ok: false,
      code: "UNSUPPORTED_CRS",
      message:
        "Explicit non-CRS84 GeoJSON 'crs' member is not supported (RFC 7946 uses 2D WGS 84 [longitude, latitude]).",
    };
  }

  if (obj.type === "Point") {
    return extractPointCoordsFromGeoJsonPosition(obj.coordinates);
  }

  if (obj.type === "Feature") {
    const geom = obj.geometry;
    if (geom === null || geom === undefined) {
      return {
        ok: false,
        code: "EMPTY_GEOMETRY",
        message: "GeoJSON Feature has null/empty geometry.",
      };
    }
    if (typeof geom !== "object" || Array.isArray(geom)) {
      return {
        ok: false,
        code: "UNSUPPORTED_GEOJSON_GEOMETRY",
        message: "GeoJSON Feature geometry is invalid.",
      };
    }
    const geomObj = geom as Record<string, unknown>;
    if ("crs" in geomObj && !isAllowedGeoJsonCrs(geomObj.crs)) {
      return {
        ok: false,
        code: "UNSUPPORTED_CRS",
        message: "Explicit non-CRS84 GeoJSON geometry 'crs' is not supported.",
      };
    }
    if (geomObj.type !== "Point") {
      return {
        ok: false,
        code: "UNSUPPORTED_GEOJSON_GEOMETRY",
        message: `GeoJSON Feature geometry type "${String(geomObj.type)}" is not supported (only 2D Point is supported).`,
      };
    }
    return extractPointCoordsFromGeoJsonPosition(geomObj.coordinates);
  }

  return {
    ok: false,
    code: "UNSUPPORTED_GEOJSON_GEOMETRY",
    message: `GeoJSON type "${String(obj.type)}" is not supported (only 2D Point or Feature<Point> is supported; collections are never silently reduced to their first point).`,
  };
}

function parseWktInput(trimmed: string): CoordinateParseResult {
  let body = trimmed;

  // Optional EWKT `SRID=...;` prefix
  const sridPrefix = /^SRID\s*=\s*([^;]+);\s*(.*)$/is.exec(body);
  if (sridPrefix) {
    const sridVal = sridPrefix[1]!.trim();
    if (sridVal !== "4326") {
      return {
        ok: false,
        code: "UNSUPPORTED_CRS",
        message: `WKT SRID=${sridVal} is not supported; only 2D WGS 84 (SRID=4326) is supported.`,
      };
    }
    body = sridPrefix[2]!.trim();
  }

  const upper = body.toUpperCase();
  if (
    /^(?:LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION|CIRCULARSTRING|COMPOUNDCURVE|CURVEPOLYGON|TIN|POLYHEDRALSURFACE)\b/.test(
      upper,
    )
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_WKT_GEOMETRY",
      message: "Only 2D WKT POINT (longitude latitude) is supported.",
    };
  }

  if (/^POINT\s*(?:Z|M|ZM)\b/i.test(body)) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTRA_DIMENSION",
      message: "WKT POINT Z / M / ZM dimensions are not supported in 2D WGS 84 mode.",
    };
  }

  if (/^POINT\s+EMPTY$/i.test(body)) {
    return {
      ok: false,
      code: "EMPTY_GEOMETRY",
      message: "WKT POINT EMPTY contains no coordinates.",
    };
  }

  const pointMatch = /^POINT\s*\(\s*([^)]*?)\s*\)$/i.exec(body);
  if (!pointMatch) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "Invalid WKT POINT syntax; expected POINT (longitude latitude).",
    };
  }

  const inner = pointMatch[1]!.trim();
  if (inner.length === 0 || inner.toUpperCase() === "EMPTY") {
    return {
      ok: false,
      code: "EMPTY_GEOMETRY",
      message: "WKT POINT contains no coordinates.",
    };
  }

  const parts = inner.split(/\s+/);
  if (parts.length > 2) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTRA_DIMENSION",
      message: `WKT POINT has ${parts.length} coordinates; 3D/4D Z/M values are not silently dropped in 2D mode.`,
    };
  }
  if (
    parts.length !== 2 ||
    !STRICT_SIGNED_DECIMAL_RE.test(parts[0]!) ||
    !STRICT_SIGNED_DECIMAL_RE.test(parts[1]!)
  ) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "WKT POINT requires two decimal numbers: POINT (longitude latitude).",
    };
  }

  const lon = Number(parts[0]!);
  const lat = Number(parts[1]!);
  const validated = createWgs84Point(lat, lon);
  if (!validated.ok) return validated;

  return {
    ok: true,
    point: validated.point,
    detectedFormat: "wkt_point",
    axisOrderUsed: "lon_lat",
  };
}

function parseGeoUriInput(trimmed: string): CoordinateParseResult {
  // RFC 5870: `geo:lat,lon[,alt][;crs=...][;u=...]`
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return {
      ok: false,
      code: "UNSUPPORTED_GEO_URI_PARAM",
      message:
        "Query strings or fragments on geo: URIs are not supported in strict 2D WGS 84 mode.",
    };
  }

  const afterScheme = trimmed.slice(4);
  if (afterScheme.length === 0) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "geo: URI is missing coordinates.",
    };
  }

  const semiParts = afterScheme.split(";");
  const coordPart = semiParts[0]!;
  const paramParts = semiParts.slice(1);

  for (const rawParam of paramParts) {
    if (rawParam.trim().length === 0) {
      return {
        ok: false,
        code: "INVALID_COORDINATE_SYNTAX",
        message: "Trailing or empty semicolon parameter in geo: URI.",
      };
    }
    const eqIdx = rawParam.indexOf("=");
    const pName = (eqIdx === -1 ? rawParam : rawParam.slice(0, eqIdx)).trim().toLowerCase();
    const pVal =
      eqIdx === -1
        ? ""
        : rawParam
            .slice(eqIdx + 1)
            .trim()
            .toLowerCase();

    if (pName === "crs") {
      if (pVal !== "wgs84") {
        return {
          ok: false,
          code: "UNSUPPORTED_CRS",
          message: `geo: URI crs="${pVal}" is not supported; only crs=wgs84 is supported.`,
        };
      }
      continue;
    }

    return {
      ok: false,
      code: "UNSUPPORTED_GEO_URI_PARAM",
      message: `geo: URI parameter "${pName}" (such as uncertainty u=) is not supported in 2D point mode and is never silently truncated.`,
    };
  }

  const nums = coordPart.split(",");
  if (nums.length === 3) {
    return {
      ok: false,
      code: "UNSUPPORTED_GEO_URI_ALTITUDE",
      message:
        "3D altitude in geo:lat,lon,alt URI is not supported in 2D mode and is never silently dropped.",
    };
  }
  if (
    nums.length !== 2 ||
    !STRICT_SIGNED_DECIMAL_RE.test(nums[0]!) ||
    !STRICT_SIGNED_DECIMAL_RE.test(nums[1]!)
  ) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "geo: URI requires two decimal numbers: geo:latitude,longitude.",
    };
  }

  const lat = Number(nums[0]!);
  const lon = Number(nums[1]!);
  const validated = createWgs84Point(lat, lon);
  if (!validated.ok) return validated;

  return {
    ok: true,
    point: validated.point,
    detectedFormat: "geo_uri",
    axisOrderUsed: "lat_lon",
  };
}

function decodeQuerySegmentOnce(raw: string, plusAsSpace: boolean): string | null {
  const prepped = plusAsSpace ? raw.replace(/\+/g, " ") : raw;
  for (let i = 0; i < prepped.length; i++) {
    if (prepped.charCodeAt(i) === 0x25 /* % */) {
      if (i + 2 >= prepped.length) return null;
      const c1 = prepped.charCodeAt(i + 1);
      const c2 = prepped.charCodeAt(i + 2);
      const hex1 =
        (c1 >= 0x30 && c1 <= 0x39) || (c1 >= 0x41 && c1 <= 0x46) || (c1 >= 0x61 && c1 <= 0x66);
      const hex2 =
        (c2 >= 0x30 && c2 <= 0x39) || (c2 >= 0x41 && c2 <= 0x46) || (c2 >= 0x61 && c2 <= 0x66);
      if (!hex1 || !hex2) return null;
      i += 2;
    }
  }
  try {
    return decodeURIComponent(prepped);
  } catch {
    return null;
  }
}

function parseStrictDecimalPairLatLon(text: string): { ok: true; lat: number; lon: number } | null {
  const parts = text.trim().split(",");
  if (parts.length !== 2) return null;
  const p0 = parts[0]!.trim();
  const p1 = parts[1]!.trim();
  if (!STRICT_SIGNED_DECIMAL_RE.test(p0) || !STRICT_SIGNED_DECIMAL_RE.test(p1)) {
    return null;
  }
  const lat = Number(p0);
  const lon = Number(p1);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { ok: true, lat, lon };
}

function extractRawQueryEntriesSingleDecode(
  rawUrl: string,
): Array<{ key: string; value: string }> | null {
  const hashIdx = rawUrl.indexOf("#");
  const beforeHash = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
  const qIdx = beforeHash.indexOf("?");
  if (qIdx === -1) return [];
  const rawQuery = beforeHash.slice(qIdx + 1);
  if (rawQuery.length === 0) return [];

  const entries: Array<{ key: string; value: string }> = [];
  for (const seg of rawQuery.split("&")) {
    if (!seg) continue;
    const eqIdx = seg.indexOf("=");
    const rawKey = eqIdx === -1 ? seg : seg.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? "" : seg.slice(eqIdx + 1);
    const decKey = decodeQuerySegmentOnce(rawKey, true);
    const decVal = decodeQuerySegmentOnce(rawVal, true);
    if (decKey === null || decVal === null) {
      return null;
    }
    entries.push({ key: decKey, value: decVal });
  }
  return entries;
}

function parseHttpMapsUrl(trimmed: string): CoordinateParseResult {
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "Malformed URL.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "UNSUPPORTED_URL_HOST",
      message:
        "Only official Apple Maps and Google Maps HTTP/HTTPS coordinate links are supported.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  // Explicit short-link rejection (never make network requests or follow redirects)
  if (
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "g.co" ||
    host === "bit.ly" ||
    host === "tinyurl.com"
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_SHORT_LINK",
      message:
        "Shortened map links require online redirect resolution; WinKit D10 runs strictly offline without network requests.",
    };
  }

  const entries = extractRawQueryEntriesSingleDecode(trimmed);
  if (entries === null) {
    return {
      ok: false,
      code: "INVALID_COORDINATE_SYNTAX",
      message: "Malformed percent-encoding in Maps URL query parameters.",
    };
  }

  // 1. Official Apple Maps (`maps.apple.com` ONLY — rejects spoofed subdomains like `maps.apple.com.evil.example`)
  if (host === "maps.apple.com") {
    const coordCandidates: Array<{ lat: number; lon: number }> = [];
    let hasOnlineOnlyParam = false;

    for (const { key, value } of entries) {
      const k = key.toLowerCase();
      if (k === "coordinate" || k === "ll") {
        const pair = parseStrictDecimalPairLatLon(value);
        if (!pair) {
          return {
            ok: false,
            code: "INVALID_COORDINATE_SYNTAX",
            message: `Apple Maps parameter "${key}" does not contain a valid decimal latitude,longitude pair.`,
          };
        }
        coordCandidates.push(pair);
      } else if (k === "address" || k === "auid" || k === "muid" || k === "place-id" || k === "q") {
        hasOnlineOnlyParam = true;
      }
    }

    if (coordCandidates.length === 0) {
      return {
        ok: false,
        code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
        message: hasOnlineOnlyParam
          ? "Apple Maps address, search, or Place ID URLs cannot be resolved to coordinates offline."
          : "Apple Maps URL does not contain an explicit coordinate= or ll= parameter.",
      };
    }

    const first = coordCandidates[0]!;
    for (let i = 1; i < coordCandidates.length; i++) {
      if (coordCandidates[i]!.lat !== first.lat || coordCandidates[i]!.lon !== first.lon) {
        return {
          ok: false,
          code: "CONFLICTING_URL_COORDINATES",
          message: "Apple Maps URL contains conflicting coordinate parameters.",
        };
      }
    }

    const validated = createWgs84Point(first.lat, first.lon);
    if (!validated.ok) return validated;
    return {
      ok: true,
      point: validated.point,
      detectedFormat: "apple_maps_url",
      axisOrderUsed: "lat_lon",
    };
  }

  // 2. Official Google Maps (`www.google.com/maps...`, `google.com/maps...`, or `maps.google.com`)
  const isGoogleMapsHost =
    host === "maps.google.com" ||
    ((host === "www.google.com" || host === "google.com") &&
      (pathname === "/maps" || pathname.startsWith("/maps/")));

  if (isGoogleMapsHost) {
    // If `query_place_id` is present, Google Maps resolves the Place ID online rather than raw coordinates
    if (
      entries.some((e) => e.key.toLowerCase() === "query_place_id" && e.value.trim().length > 0)
    ) {
      return {
        ok: false,
        code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
        message:
          "Google Maps URL includes query_place_id, which requires online Place resolution and cannot be resolved offline.",
      };
    }

    const coordCandidates: Array<{ lat: number; lon: number }> = [];
    let sawNonCoordinateQuery = false;

    for (const { key, value } of entries) {
      const k = key.toLowerCase();
      if (k === "query" || k === "q" || k === "ll") {
        const pair = parseStrictDecimalPairLatLon(value);
        if (pair) {
          coordCandidates.push(pair);
        } else if (k === "ll") {
          return {
            ok: false,
            code: "INVALID_COORDINATE_SYNTAX",
            message:
              'Google Maps parameter "ll" does not contain a valid decimal latitude,longitude pair.',
          };
        } else {
          sawNonCoordinateQuery = true;
        }
      }
    }

    if (coordCandidates.length === 0) {
      if (sawNonCoordinateQuery) {
        return {
          ok: false,
          code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
          message:
            "Google Maps place/address query cannot be geocoded offline; only explicit coordinate links (such as ?api=1&query=lat,lon) are supported.",
        };
      }
      if (pathname.includes("/@") || pathname.startsWith("/maps/place/")) {
        return {
          ok: false,
          code: "MAPS_URL_VIEWPORT_OR_PLACE_UNSUPPORTED",
          message:
            "Google Maps '@lat,lon,zoom' viewport centers and /place/ pages are not treated as selected pin coordinates offline.",
        };
      }
      return {
        ok: false,
        code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
        message: "Google Maps URL does not contain an explicit coordinate query parameter.",
      };
    }

    const first = coordCandidates[0]!;
    for (let i = 1; i < coordCandidates.length; i++) {
      if (coordCandidates[i]!.lat !== first.lat || coordCandidates[i]!.lon !== first.lon) {
        return {
          ok: false,
          code: "CONFLICTING_URL_COORDINATES",
          message: "Google Maps URL contains conflicting coordinate parameters.",
        };
      }
    }

    const validated = createWgs84Point(first.lat, first.lon);
    if (!validated.ok) return validated;
    return {
      ok: true,
      point: validated.point,
      detectedFormat: "google_maps_url",
      axisOrderUsed: "lat_lon",
    };
  }

  return {
    ok: false,
    code: "UNSUPPORTED_URL_HOST",
    message: `URL host "${host}" is not a supported official Apple Maps or Google Maps coordinate link.`,
  };
}

function splitPlainCoordinatePair(
  trimmed: string,
): { ok: true; first: string; second: string } | CoordinateParseError {
  // 1. Comma-separated
  if (trimmed.includes(",")) {
    const commaParts = trimmed.split(",");
    if (
      commaParts.length === 3 &&
      commaParts.every((p) => STRICT_SIGNED_DECIMAL_RE.test(p.trim()))
    ) {
      return {
        ok: false,
        code: "UNSUPPORTED_EXTRA_DIMENSION",
        message:
          "3D coordinate tuples (3 comma-separated numbers) are not supported in 2D WGS 84 mode.",
      };
    }
    if (commaParts.length !== 2) {
      return {
        ok: false,
        code: "INVALID_COORDINATE_SYNTAX",
        message: "Expected a two-coordinate pair separated by a single comma.",
      };
    }
    return { ok: true, first: commaParts[0]!, second: commaParts[1]! };
  }

  // 2. Semicolon-separated
  if (trimmed.includes(";")) {
    const semiParts = trimmed.split(";");
    if (semiParts.length !== 2) {
      return {
        ok: false,
        code: "INVALID_COORDINATE_SYNTAX",
        message: "Expected a two-coordinate pair.",
      };
    }
    return { ok: true, first: semiParts[0]!, second: semiParts[1]! };
  }

  // 3. Whitespace-separated plain decimal pair (`37.8197 -122.4786`)
  const plainSpace = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(
    trimmed,
  );
  if (plainSpace) {
    return { ok: true, first: plainSpace[1]!, second: plainSpace[2]! };
  }

  // Check 3 whitespace-separated plain numbers (`37.8 -122.4 100`) — only when no degree/hemi markers
  const threePlain =
    /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(
      trimmed,
    );
  if (threePlain) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTRA_DIMENSION",
      message: "3-number tuple is ambiguous or 3D; enter a 2D coordinate pair.",
    };
  }

  // 4. Trailing hemisphere after first coordinate (`37°49′10.92″N 122°28′42.96″W` or `37 49 10.92 N 122 28 42.96 W`)
  const trailingHemiSplit = /^(.+?[NSEW])\s+(.+)$/i.exec(trimmed);
  if (trailingHemiSplit) {
    return { ok: true, first: trailingHemiSplit[1]!, second: trailingHemiSplit[2]! };
  }

  // 5. Leading hemisphere on both coordinates (`N 37°49.182′ W 122°28.716′`)
  const leadingHemiSplit = /^([NSEW]\s*[^NSEW]+?)\s+([NSEW]\s*[^NSEW]+)$/i.exec(trimmed);
  if (leadingHemiSplit) {
    return { ok: true, first: leadingHemiSplit[1]!, second: leadingHemiSplit[2]! };
  }

  // 6. Unsigned/signed DMS or DM ending in `″`/`′`/`°` followed by second signed/unsigned coordinate
  const unitEndSplit = /^(.+?[″"”′'’°º˚])\s+([+-]?\d.+)$/.exec(trimmed);
  if (unitEndSplit) {
    return { ok: true, first: unitEndSplit[1]!, second: unitEndSplit[2]! };
  }

  return {
    ok: false,
    code: "INVALID_COORDINATE_SYNTAX",
    message:
      "Input is not a recognized 2D WGS 84 coordinate, GeoJSON Point, WKT POINT, geo: URI, or supported Maps coordinate link.",
  };
}

export function parseCoordinateInput(
  rawInput: string,
  options?: {
    plainAxisOrder?: PlainTextAxisOrder;
    maxInputBytes?: number;
  },
): CoordinateParseResult {
  const maxBytes = options?.maxInputBytes ?? MAX_SINGLE_COORDINATE_INPUT_BYTES;
  if (utf8ByteLength(rawInput) > maxBytes) {
    return {
      ok: false,
      code: "INPUT_TOO_LARGE",
      message: `Coordinate input exceeds the ${(maxBytes / 1024).toFixed(0)} KiB limit.`,
    };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "EMPTY_INPUT",
      message: "Coordinate input is empty.",
    };
  }

  // 1. Explicit non-WGS84 CRS / projected system guard
  const crsErr = detectExplicitUnsupportedCrsPrefix(trimmed);
  if (crsErr) return crsErr;

  // 2. Structured JSON / GeoJSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseGeoJsonInput(trimmed);
  }

  // 3. `geo:` URI (RFC 5870)
  if (/^geo:/i.test(trimmed)) {
    return parseGeoUriInput(trimmed);
  }

  // 4. HTTP / HTTPS URL (Apple Maps / Google Maps / rejected hosts & short links)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return parseHttpMapsUrl(trimmed);
  }

  // 5. WKT / EWKT
  if (
    /^(?:SRID\s*=|POINT\b|LINESTRING\b|POLYGON\b|MULTIPOINT\b|MULTILINESTRING\b|MULTIPOLYGON\b|GEOMETRYCOLLECTION\b)/i.test(
      trimmed,
    )
  ) {
    return parseWktInput(trimmed);
  }

  // 6. Plain DD / DM / DMS pair
  const split = splitPlainCoordinatePair(trimmed);
  if (!split.ok) return split;

  const firstParsed = parseSingleAngleToken(split.first);
  if (!firstParsed.ok) return firstParsed;
  const secondParsed = parseSingleAngleToken(split.second);
  if (!secondParsed.ok) return secondParsed;

  const a1 = firstParsed.angle;
  const a2 = secondParsed.angle;

  const detectedForm: DetectedCoordinateFormat =
    a1.form === "dms" || a2.form === "dms"
      ? "dms"
      : a1.form === "dm" || a2.form === "dm"
        ? "dm"
        : "dd";

  let latAngle: ParsedSingleAngle;
  let lonAngle: ParsedSingleAngle;
  let axisOrderUsed: AxisOrderUsed;

  if (a1.hemisphere !== null || a2.hemisphere !== null) {
    if (a1.hemisphere === null || a2.hemisphere === null) {
      return {
        ok: false,
        code: "INCOMPLETE_HEMISPHERE_PAIR",
        message: "Specify hemisphere designators (N/S and E/W) on both coordinates or neither.",
      };
    }
    const a1IsLat = a1.hemisphere === "N" || a1.hemisphere === "S";
    const a2IsLat = a2.hemisphere === "N" || a2.hemisphere === "S";
    if (a1IsLat === a2IsLat) {
      return {
        ok: false,
        code: "CONFLICTING_HEMISPHERE_AXES",
        message: `Hemisphere designators '${a1.hemisphere}' and '${a2.hemisphere}' refer to the same axis; expected one N/S and one E/W.`,
      };
    }
    if (a1IsLat) {
      latAngle = a1;
      lonAngle = a2;
    } else {
      latAngle = a2;
      lonAngle = a1;
    }
    axisOrderUsed = "hemisphere_tagged";
  } else {
    const order = options?.plainAxisOrder ?? "lat_lon";
    if (order === "lat_lon") {
      latAngle = a1;
      lonAngle = a2;
      axisOrderUsed = "lat_lon";
    } else {
      lonAngle = a1;
      latAngle = a2;
      axisOrderUsed = "lon_lat";
    }
  }

  const latErr = validateAngleForAxis(latAngle, "lat");
  if (latErr) return latErr;
  const lonErr = validateAngleForAxis(lonAngle, "lon");
  if (lonErr) return lonErr;

  return {
    ok: true,
    point: {
      latitude: latAngle.signedDegrees,
      longitude: lonAngle.signedDegrees,
      datum: "WGS84",
    },
    detectedFormat: detectedForm,
    axisOrderUsed,
  };
}

/**
 * Computes the exact WGS 84 ellipsoid inverse geodesic surface distance (`a = 6378137 m`,
 * `f = 1/298.257223563`) via Karney's algorithm in `geographiclib-geodesic`.
 * Never substitutes spherical approximations.
 */
export function calculateWgs84EllipsoidDistance(
  pointA: Wgs84Point,
  pointB: Wgs84Point,
): GeodesicDistanceOutcome {
  const checkA = createWgs84Point(pointA.latitude, pointA.longitude);
  if (!checkA.ok) {
    return { ok: false, code: checkA.code, pointRole: "A", message: checkA.message };
  }
  const checkB = createWgs84Point(pointB.latitude, pointB.longitude);
  if (!checkB.ok) {
    return { ok: false, code: checkB.code, pointRole: "B", message: checkB.message };
  }

  const a = checkA.point;
  const b = checkB.point;

  // Identical coordinates or identical geographic pole (all longitudes meet at ±90°) -> exact 0
  if (
    (a.latitude === b.latitude && a.longitude === b.longitude) ||
    (Math.abs(a.latitude) === 90 && a.latitude === b.latitude)
  ) {
    return {
      ok: true,
      meters: 0,
      kilometers: 0,
      miles: 0,
      ellipsoid: "WGS84",
    };
  }

  const inv = Geodesic.WGS84.Inverse(a.latitude, a.longitude, b.latitude, b.longitude);
  const rawMeters = inv.s12;
  if (typeof rawMeters !== "number" || !Number.isFinite(rawMeters) || rawMeters < -1e-9) {
    return {
      ok: false,
      code: "GEODESIC_SOLVE_FAILED",
      message:
        "WGS 84 ellipsoid inverse geodesic calculation did not return a valid finite distance.",
    };
  }

  const meters = rawMeters <= 0 ? 0 : rawMeters;
  return {
    ok: true,
    meters,
    kilometers: meters / 1000,
    miles: meters / 1609.344,
    ellipsoid: "WGS84",
  };
}

const BATCH_CSV_HEADERS = [
  "line_number",
  "raw_input",
  "status",
  "latitude",
  "longitude",
  "formatted_output",
  "error",
] as const;

export function convertCoordinateBatch(
  rawBatchInput: string,
  options: BatchCoordinateOptions,
  budgetOverrides?: BatchBudgetOverrides,
): BatchCoordinateConversionResult {
  const maxInputBytes = budgetOverrides?.maxInputBytes ?? MAX_BATCH_COORDINATE_INPUT_BYTES;
  const maxLines = budgetOverrides?.maxLines ?? MAX_BATCH_COORDINATE_LINES;
  const maxSingleLineBytes =
    budgetOverrides?.maxSingleLineBytes ?? MAX_SINGLE_COORDINATE_INPUT_BYTES;
  const maxOutputBytes = budgetOverrides?.maxOutputBytes ?? MAX_BATCH_COORDINATE_OUTPUT_BYTES;

  const withoutBom =
    rawBatchInput.charCodeAt(0) === 0xfeff ? rawBatchInput.slice(1) : rawBatchInput;
  if (withoutBom.trim().length === 0) {
    return { status: "empty" };
  }

  const inputBytes = utf8ByteLength(rawBatchInput);
  if (inputBytes > maxInputBytes) {
    return {
      status: "error",
      code: "BATCH_INPUT_TOO_LARGE",
      message: `Batch input (${(inputBytes / (1024 * 1024)).toFixed(2)} MiB) exceeds the ${(maxInputBytes / (1024 * 1024)).toFixed(0)} MiB limit.`,
      actual: inputBytes,
      limit: maxInputBytes,
    };
  }

  const rawLines = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (rawLines.length > maxLines) {
    return {
      status: "error",
      code: "BATCH_LINE_LIMIT_EXCEEDED",
      message: `Batch input (${rawLines.length.toLocaleString()} lines) exceeds the ${maxLines.toLocaleString()}-line limit.`,
      actual: rawLines.length,
      limit: maxLines,
    };
  }

  const prec = normalizePrecisionOptions(options.precision);
  const rows: BatchRowResult[] = [];
  const validLinesBuilder = new BoundedUtf8Builder(maxOutputBytes);
  let validCount = 0;
  let errorCount = 0;
  let skippedBlankCount = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i] ?? "";
    const lineNumber = i + 1;
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      skippedBlankCount += 1;
      continue;
    }

    if (utf8ByteLength(rawLine) > maxSingleLineBytes) {
      errorCount += 1;
      rows.push({
        lineNumber,
        rawInput: rawLine,
        status: "error",
        errorCode: "INPUT_TOO_LARGE",
        errorMessage: `Line exceeds the ${(maxSingleLineBytes / 1024).toFixed(0)} KiB per-line limit.`,
      });
      continue;
    }

    if ((trimmed === "{" || trimmed.startsWith('{"type"')) && !trimmed.endsWith("}")) {
      errorCount += 1;
      rows.push({
        lineNumber,
        rawInput: rawLine,
        status: "error",
        errorCode: "MULTILINE_GEOJSON_IN_BATCH",
        errorMessage:
          "Batch mode processes one coordinate expression per line; paste multi-line formatted GeoJSON in the Single-Point tab.",
      });
      continue;
    }

    const parsed = parseCoordinateInput(trimmed, {
      plainAxisOrder: options.plainAxisOrder,
      maxInputBytes: maxSingleLineBytes,
    });

    if (!parsed.ok) {
      errorCount += 1;
      rows.push({
        lineNumber,
        rawInput: rawLine,
        status: "error",
        errorCode: parsed.code,
        errorMessage: parsed.message,
      });
      continue;
    }

    const formattedOutput = formatCoordinateById(parsed.point, options.outputFormat, prec);
    if (validCount > 0 && !validLinesBuilder.append("\n")) {
      return {
        status: "error",
        code: "BATCH_OUTPUT_LIMIT_EXCEEDED",
        message: "Batch formatted output exceeds the UTF-8 safety budget.",
      };
    }
    if (!validLinesBuilder.append(formattedOutput)) {
      return {
        status: "error",
        code: "BATCH_OUTPUT_LIMIT_EXCEEDED",
        message: "Batch formatted output exceeds the UTF-8 safety budget.",
      };
    }

    validCount += 1;
    rows.push({
      lineNumber,
      rawInput: rawLine,
      status: "ok",
      latitude: parsed.point.latitude,
      longitude: parsed.point.longitude,
      detectedFormat: parsed.detectedFormat,
      axisOrderUsed: parsed.axisOrderUsed,
      formattedOutput,
    });
  }

  const exportScope = options.csvExportScope ?? "all_with_errors";
  const rowsForCsv = exportScope === "valid_only" ? rows.filter((r) => r.status === "ok") : rows;

  const csvMatrix: CsvCellInput[][] = rowsForCsv.map((r) => {
    if (r.status === "ok") {
      return [
        { text: String(r.lineNumber), isGenuineNumber: true },
        { text: r.rawInput, isGenuineNumber: false },
        { text: "ok", isGenuineNumber: false },
        { text: formatCleanDecimal(r.latitude, prec.ddDecimals), isGenuineNumber: true },
        { text: formatCleanDecimal(r.longitude, prec.ddDecimals), isGenuineNumber: true },
        {
          // Generated strictly from validated numeric coordinates (e.g. "-41.32, 174.81"), never untrusted formula text
          text: r.formattedOutput,
          isGenuineNumber: true,
        },
        { text: "", isGenuineNumber: false },
      ];
    }
    return [
      { text: String(r.lineNumber), isGenuineNumber: true },
      { text: r.rawInput, isGenuineNumber: false },
      { text: "error", isGenuineNumber: false },
      { text: "", isGenuineNumber: false },
      { text: "", isGenuineNumber: false },
      { text: "", isGenuineNumber: false },
      { text: `[${r.errorCode}] ${r.errorMessage}`, isGenuineNumber: false },
    ];
  });

  const csvRes = serializeTableToCsvBounded({
    headers: BATCH_CSV_HEADERS,
    rows: csvMatrix,
    includeHeaderRow: true,
    delimiter: options.csvDelimiter ?? ",",
    lineEnding: options.csvLineEnding === "crlf" ? "\r\n" : "\n",
    includeBom: Boolean(options.csvIncludeBom),
    formulaProtection: options.formulaProtection,
    maxOutputBytes,
  });

  if (!csvRes.ok) {
    return {
      status: "error",
      code: "BATCH_OUTPUT_LIMIT_EXCEEDED",
      message: csvRes.message,
    };
  }

  return {
    status: "ok",
    rows,
    previewRows: rows.slice(0, MAX_BATCH_PREVIEW_ROWS),
    previewTruncated: rows.length > MAX_BATCH_PREVIEW_ROWS,
    totalNonBlankCount: rows.length,
    validCount,
    errorCount,
    skippedBlankCount,
    validFormattedText: validLinesBuilder.build(),
    csvOutputText: csvRes.csvText,
    csvByteLength: csvRes.byteLength,
    formulaLikeCellCount: csvRes.formulaLikeCellCount,
    formulaProtectedCount: csvRes.formulaProtectedCount,
    formulaPreviewSamples: csvRes.formulaPreviewSamples,
  };
}
