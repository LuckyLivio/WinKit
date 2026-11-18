import { describe, expect, it } from "vitest";
import {
  calculateWgs84EllipsoidDistance,
  convertCoordinateBatch,
  createWgs84Point,
  formatAllCoordinateOutputs,
  parseCoordinateInput,
  parseSeparateLatLonFields,
  serializeUnroundedPointForTransfer,
} from "./coordinateEngine";

describe("D10 coordinateEngine — WGS 84 parsing, 8-format output, geodesic distance & batch", () => {
  it("matches exact reference outputs for 37.8197, -122.4786 across all 8 formats and round-trips within precision tolerance", () => {
    const parsed = parseCoordinateInput("37.8197, -122.4786");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.detectedFormat).toBe("dd");
    expect(parsed.axisOrderUsed).toBe("lat_lon");
    expect(parsed.point).toEqual({
      latitude: 37.8197,
      longitude: -122.4786,
      datum: "WGS84",
    });

    const out = formatAllCoordinateOutputs(parsed.point, {
      ddDecimals: 6,
      dmDecimals: 3,
      dmsDecimals: 2,
    });

    expect(out.dd).toBe("37.8197, -122.4786");
    expect(out.dms).toBe("37°49′10.92″N 122°28′42.96″W");
    expect(out.dm).toBe("37°49.182′N 122°28.716′W");
    expect(out.geojson).toBe('{"type":"Point","coordinates":[-122.4786,37.8197]}');
    expect(out.wkt).toBe("POINT (-122.4786 37.8197)");
    expect(out.geo_uri).toBe("geo:37.8197,-122.4786");
    expect(out.apple_maps).toBe("https://maps.apple.com/place?coordinate=37.8197,-122.4786");
    expect(out.google_maps).toBe(
      "https://www.google.com/maps/search/?api=1&query=37.8197%2C-122.4786",
    );

    // Every one of the 8 formatted representations parses back within its quantization bound
    for (const [key, text] of Object.entries(out)) {
      const rt = parseCoordinateInput(text);
      expect(rt.ok, `round-trip failed for ${key}: ${text}`).toBe(true);
      if (!rt.ok) continue;
      const tol =
        key === "dms"
          ? (0.5 * 1e-2) / 3600 + 1e-12
          : key === "dm"
            ? (0.5 * 1e-3) / 60 + 1e-12
            : 0.5 * 1e-6 + 1e-12;
      expect(Math.abs(rt.point.latitude - parsed.point.latitude)).toBeLessThanOrEqual(tol);
      expect(Math.abs(rt.point.longitude - parsed.point.longitude)).toBeLessThanOrEqual(tol);
    }
  });

  it("handles carry propagation (0°30′0″S, 179°59′59.9999″E -> 180°0′0″E), 0,0, -0 normalization, and display-precision isolation", () => {
    const carryParsed = parseCoordinateInput("0°30′0″S, 179°59′59.9999″E");
    expect(carryParsed.ok).toBe(true);
    if (!carryParsed.ok) return;

    expect(carryParsed.point.latitude).toBeCloseTo(-0.5, 12);
    const outSecInt = formatAllCoordinateOutputs(carryParsed.point, {
      ddDecimals: 6,
      dmDecimals: 2,
      dmsDecimals: 0,
    });
    expect(outSecInt.dms).toBe("0°30′0″S 180°0′0″E");
    expect(outSecInt.dm).toBe("0°30′S 180°0′E");
    expect(outSecInt.dd.startsWith("-0.5,")).toBe(true);

    // Changing display precision to 0 decimals NEVER mutates the underlying unrounded Wgs84Point used for distance
    const coarseDisplay = formatAllCoordinateOutputs(carryParsed.point, {
      ddDecimals: 0,
      dmDecimals: 0,
      dmsDecimals: 0,
    });
    expect(coarseDisplay.dd).toBe("-1, 180");
    expect(carryParsed.point.latitude).toBe(-0.5);

    // Zero and negative-zero coordinates (`0, 0` and `-0, -0.0`) are valid and normalize `-0` to `0`
    const zeroOrigin = parseSeparateLatLonFields("-0", "-0.000");
    expect(zeroOrigin.ok).toBe(true);
    if (zeroOrigin.ok) {
      expect(Object.is(zeroOrigin.point.latitude, 0)).toBe(true);
      expect(Object.is(zeroOrigin.point.longitude, 0)).toBe(true);
      const zOut = formatAllCoordinateOutputs(zeroOrigin.point);
      expect(zOut.dd).toBe("0, 0");
      expect(zOut.dms).toBe("0°0′0″N 0°0′0″E");
    }

    // Consistent negative sign + S/W applies negative direction ONCE (never double-negates!)
    const consistentNeg = parseCoordinateInput("-37.5 S, -122.25 W");
    expect(consistentNeg.ok).toBe(true);
    if (consistentNeg.ok) {
      expect(consistentNeg.point.latitude).toBe(-37.5);
      expect(consistentNeg.point.longitude).toBe(-122.25);
    }
  });

  it("enforces axis order rules across plain text, hemisphere tags, GeoJSON, WKT, geo:, and Maps URLs", () => {
    // Plain text `40, 20` follows explicit `plainAxisOrder` without guessing from magnitude
    const latFirst = parseCoordinateInput("40, 20", { plainAxisOrder: "lat_lon" });
    expect(latFirst.ok && latFirst.point).toEqual({
      latitude: 40,
      longitude: 20,
      datum: "WGS84",
    });

    const lonFirst = parseCoordinateInput("40, 20", { plainAxisOrder: "lon_lat" });
    expect(lonFirst.ok && lonFirst.point).toEqual({
      latitude: 20,
      longitude: 40,
      datum: "WGS84",
    });

    // GeoJSON `[40, 20]` and `{"type":"Point","coordinates":[40,20]}` are FIXED `[lon, lat]`
    const gjTuple = parseCoordinateInput("[40, 20]", { plainAxisOrder: "lat_lon" });
    expect(gjTuple.ok).toBe(true);
    if (gjTuple.ok) {
      expect(gjTuple.detectedFormat).toBe("geojson_point");
      expect(gjTuple.point).toEqual({ latitude: 20, longitude: 40, datum: "WGS84" });
    }

    const gjFeature = parseCoordinateInput(
      '{"type":"Feature","properties":{"name":"Test"},"geometry":{"type":"Point","coordinates":[40,20]}}',
    );
    expect(gjFeature.ok && gjFeature.point).toEqual({
      latitude: 20,
      longitude: 40,
      datum: "WGS84",
    });

    // WKT `POINT (40 20)` is FIXED `lon lat`; `geo:40,20` is FIXED `lat,lon`
    const wkt = parseCoordinateInput("SRID=4326;POINT (40 20)");
    expect(wkt.ok && wkt.point).toEqual({ latitude: 20, longitude: 40, datum: "WGS84" });

    const geoCrs = parseCoordinateInput("geo:40,20;crs=WGS84");
    expect(geoCrs.ok && geoCrs.point).toEqual({ latitude: 40, longitude: 20, datum: "WGS84" });

    // Hemisphere-tagged `122°28′42.96″W, 37°49′10.92″N` assigns E/W to lon and N/S to lat automatically
    const hemiSwapped = parseCoordinateInput("122°28′42.96″W, 37°49′10.92″N");
    expect(hemiSwapped.ok).toBe(true);
    if (hemiSwapped.ok) {
      expect(hemiSwapped.axisOrderUsed).toBe("hemisphere_tagged");
      expect(hemiSwapped.point.latitude).toBeCloseTo(37.8197, 6);
      expect(hemiSwapped.point.longitude).toBeCloseTo(-122.4786, 6);
    }
  });

  it("rejects out-of-range values, 60m/60s, sign conflicts, non-Point/3D geometries, unknown CRS, spoofed hosts, viewports, and short links", () => {
    expect(parseCoordinateInput("91, 0")).toMatchObject({
      ok: false,
      code: "LATITUDE_OUT_OF_RANGE",
    });
    expect(parseCoordinateInput("0, 181")).toMatchObject({
      ok: false,
      code: "LONGITUDE_OUT_OF_RANGE",
    });
    expect(parseCoordinateInput("90°0′0.1″N, 0°0′0″E")).toMatchObject({
      ok: false,
      code: "LATITUDE_OUT_OF_RANGE",
    });
    expect(parseCoordinateInput("0°0′0″N, 180°0′0.1″E")).toMatchObject({
      ok: false,
      code: "LONGITUDE_OUT_OF_RANGE",
    });
    expect(parseCoordinateInput("37°60′0″N, 122°0′0″W")).toMatchObject({
      ok: false,
      code: "MINUTES_OUT_OF_RANGE",
    });
    expect(parseCoordinateInput("37°0′60″N, 122°0′0″W")).toMatchObject({
      ok: false,
      code: "SECONDS_OUT_OF_RANGE",
    });
    expect(parseCoordinateInput("NaN, 120")).toMatchObject({ ok: false });
    expect(parseCoordinateInput("Infinity, 120")).toMatchObject({ ok: false });
    expect(parseCoordinateInput("-37.5 N, 122 W")).toMatchObject({
      ok: false,
      code: "SIGN_HEMISPHERE_CONFLICT",
    });
    expect(parseCoordinateInput("+37.5 S, 122 W")).toMatchObject({
      ok: false,
      code: "SIGN_HEMISPHERE_CONFLICT",
    });
    expect(parseCoordinateInput("37.5 N, 42.1 S")).toMatchObject({
      ok: false,
      code: "CONFLICTING_HEMISPHERE_AXES",
    });
    expect(parseCoordinateInput("1600 Amphitheatre Parkway, Mountain View")).toMatchObject({
      ok: false,
    });
    expect(parseCoordinateInput("")).toMatchObject({ ok: false, code: "EMPTY_INPUT" });

    // Structured rejections
    expect(parseCoordinateInput('{"type":"LineString","coordinates":[[0,0],[1,1]]}')).toMatchObject(
      { ok: false, code: "UNSUPPORTED_GEOJSON_GEOMETRY" },
    );
    expect(parseCoordinateInput('{"type":"Point","coordinates":[120,30,50]}')).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_EXTRA_DIMENSION",
    });
    expect(
      parseCoordinateInput(
        '{"type":"Point","coordinates":[120,30],"crs":{"type":"name","properties":{"name":"EPSG:3857"}}}',
      ),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_CRS" });
    expect(parseCoordinateInput("GCJ-02 31.2304, 121.4737")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_CRS",
    });
    expect(parseCoordinateInput("SRID=3857;POINT (13522000 3662000)")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_CRS",
    });
    expect(parseCoordinateInput("POINT Z (120 30 15)")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_EXTRA_DIMENSION",
    });
    expect(parseCoordinateInput("geo:37.8,-122.4,10")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_GEO_URI_ALTITUDE",
    });
    expect(parseCoordinateInput("geo:37.8,-122.4;u=25")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_GEO_URI_PARAM",
    });
    expect(parseCoordinateInput("geo:37.8,-122.4;crs=moon2000")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_CRS",
    });

    // URL security & offline boundaries
    expect(
      parseCoordinateInput("https://maps.apple.com.evil.example/place?coordinate=37.8,-122.4"),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_URL_HOST" });
    expect(parseCoordinateInput("https://maps.app.goo.gl/AbCdEf12345")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_SHORT_LINK",
    });
    expect(
      parseCoordinateInput("https://www.google.com/maps/@37.8197,-122.4786,15z"),
    ).toMatchObject({
      ok: false,
      code: "MAPS_URL_VIEWPORT_OR_PLACE_UNSUPPORTED",
    });
    expect(
      parseCoordinateInput("https://www.google.com/maps/search/?api=1&query=Golden+Gate+Bridge"),
    ).toMatchObject({
      ok: false,
      code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
    });
    // Place/address query with a viewport `ll` or `center` must NEVER fall back to `ll`
    expect(
      parseCoordinateInput(
        "https://www.google.com/maps/search/?api=1&query=Eiffel%20Tower&ll=40,-70",
      ),
    ).toMatchObject({
      ok: false,
      code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
    });
    expect(
      parseCoordinateInput("https://www.google.com/maps?q=Eiffel%20Tower&ll=40,-70"),
    ).toMatchObject({
      ok: false,
      code: "MAPS_URL_REQUIRES_ONLINE_LOOKUP",
    });
    expect(parseCoordinateInput("https://www.google.com/maps?ll=40,-70")).toMatchObject({
      ok: false,
      code: "MAPS_URL_VIEWPORT_OR_PLACE_UNSUPPORTED",
    });
    expect(
      parseCoordinateInput("https://maps.apple.com/place?coordinate=37.8,-122.4&ll=38.0,-122.0"),
    ).toMatchObject({
      ok: false,
      code: "CONFLICTING_URL_COORDINATES",
    });
    // Apple Map Links documented `ll` + `q` pin label remains valid when no address/place-id is present
    const appleLabeledPin = parseCoordinateInput(
      "https://maps.apple.com/?ll=37.8197,-122.4786&q=Custom%20Pin%20Label",
    );
    expect(appleLabeledPin).toMatchObject({
      ok: true,
      point: { latitude: 37.8197, longitude: -122.4786, datum: "WGS84" },
      detectedFormat: "apple_maps_url",
    });
    // Generated Apple & Google numeric coordinate URLs round-trip losslessly
    const samplePt = createWgs84Point(37.8197, -122.4786);
    expect(samplePt.ok).toBe(true);
    if (samplePt.ok) {
      const outs = formatAllCoordinateOutputs(samplePt.point, {
        ddDecimals: 6,
        dmDecimals: 3,
        dmsDecimals: 2,
      });
      expect(parseCoordinateInput(outs.apple_maps)).toMatchObject({
        ok: true,
        point: { latitude: 37.8197, longitude: -122.4786, datum: "WGS84" },
      });
      expect(parseCoordinateInput(outs.google_maps)).toMatchObject({
        ok: true,
        point: { latitude: 37.8197, longitude: -122.4786, datum: "WGS84" },
      });

      // Tiny & unrounded point transfer preserves exact coordinates regardless of plainAxisOrder
      const tiny = createWgs84Point(1e-12, -2.5e-11);
      expect(tiny.ok).toBe(true);
      if (tiny.ok) {
        const payload = serializeUnroundedPointForTransfer(tiny.point);
        expect(parseCoordinateInput(payload, { plainAxisOrder: "lat_lon" })).toMatchObject({
          ok: true,
          point: { latitude: 1e-12, longitude: -2.5e-11, datum: "WGS84" },
        });
        expect(parseCoordinateInput(payload, { plainAxisOrder: "lon_lat" })).toMatchObject({
          ok: true,
          point: { latitude: 1e-12, longitude: -2.5e-11, datum: "WGS84" },
        });
      }
    }
  });

  it("computes exact WGS 84 ellipsoid geodesic distances across identical points, poles, equator, antimeridian, and nearly antipodal points", () => {
    const pt = (lat: number, lon: number) => {
      const r = createWgs84Point(lat, lon);
      if (!r.ok) throw new Error(r.message);
      return r.point;
    };

    // 1. Identical point & North Pole with different longitudes -> exact 0
    const same = calculateWgs84EllipsoidDistance(pt(37.8197, -122.4786), pt(37.8197, -122.4786));
    expect(same.ok && same.meters).toBe(0);

    const poles = calculateWgs84EllipsoidDistance(pt(90, -135), pt(90, 45));
    expect(poles.ok && poles.meters).toBe(0);

    // 2. Equator 1 degree: (0,0) -> (0,1) = a * pi / 180 ≈ 111319.490793 m
    const eq1 = calculateWgs84EllipsoidDistance(pt(0, 0), pt(0, 1));
    expect(eq1.ok).toBe(true);
    if (eq1.ok) {
      expect(Math.abs(eq1.meters - 111319.490793)).toBeLessThanOrEqual(0.01);
      expect(eq1.kilometers).toBeCloseTo(eq1.meters / 1000, 9);
      expect(eq1.miles).toBeCloseTo(eq1.meters / 1609.344, 9);
    }

    // 3. Antimeridian crossing: (0, 179.9) -> (0, -179.9) = 0.2 deg on equator ≈ 22263.898159 m
    const dateline = calculateWgs84EllipsoidDistance(pt(0, 179.9), pt(0, -179.9));
    expect(dateline.ok).toBe(true);
    if (dateline.ok) {
      expect(Math.abs(dateline.meters - 22263.898159)).toBeLessThanOrEqual(0.01);
    }

    // 4. Nearly antipodal GeographicLib benchmark: (-41.32, 174.81) -> (40.96, -5.50) ≈ 19959679.267 m
    const antipodal = calculateWgs84EllipsoidDistance(pt(-41.32, 174.81), pt(40.96, -5.5));
    expect(antipodal.ok).toBe(true);
    if (antipodal.ok) {
      expect(Math.abs(antipodal.meters - 19959679.267)).toBeLessThanOrEqual(0.01);
    }
  });

  it("converts mixed valid/invalid coordinate batches preserving source line numbers, CSV formula protection, and output budgets", () => {
    const batchText = [
      "37.8197, -122.4786",
      "",
      "POINT (139.6917 35.6895)",
      '=HYPERLINK("https://evil.example","bad row")',
      "geo:-33.8688,151.2093",
      '{"type":"Point",',
    ].join("\n");

    const res = convertCoordinateBatch(batchText, {
      plainAxisOrder: "lat_lon",
      outputFormat: "wkt",
      precision: { ddDecimals: 4, dmDecimals: 3, dmsDecimals: 2 },
      formulaProtection: true,
    });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    expect(res.skippedBlankCount).toBe(1);
    expect(res.validCount).toBe(3);
    expect(res.errorCount).toBe(2);
    // Source line numbers are preserved across skipped blank line #2!
    expect(res.rows.map((r) => r.lineNumber)).toEqual([1, 3, 4, 5, 6]);
    expect(res.rows[4]?.status === "error" && res.rows[4]?.errorCode).toBe(
      "MULTILINE_GEOJSON_IN_BATCH",
    );

    // Negative latitude `-33.8688` is NOT prefixed with `'`, while `=HYPERLINK(...)` in raw_input IS protected!
    expect(res.formulaProtectedCount).toBe(1);
    expect(res.csvOutputText).toContain(
      '5,"geo:-33.8688,151.2093",ok,-33.8688,151.2093,POINT (151.2093 -33.8688),',
    );
    expect(res.csvOutputText).toContain(
      '4,"\'=HYPERLINK(""https://evil.example"",""bad row"")",error,,,,',
    );

    // Incremental output budget check
    const budgetExceeded = convertCoordinateBatch(
      batchText,
      {
        plainAxisOrder: "lat_lon",
        outputFormat: "google_maps",
        precision: { ddDecimals: 6, dmDecimals: 3, dmsDecimals: 2 },
        formulaProtection: false,
      },
      { maxOutputBytes: 80 },
    );
    expect(budgetExceeded.status === "error" && budgetExceeded.code).toBe(
      "BATCH_OUTPUT_LIMIT_EXCEEDED",
    );
  });
});
