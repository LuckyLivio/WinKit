import { describe, expect, it } from "vitest";
import {
  cleanLinksBatch,
  cleanSingleLine,
  evaluateClipboardLinksOnlyReplace,
} from "./linkCleanerEngine";

describe("D09 linkCleanerEngine", () => {
  it("strips universal trackers while preserving raw encoding (+ / %20 / %2B / %252F / ~), duplicates, empty values, keyless flags, and fragments", () => {
    const raw =
      "https://shop.example.com/path/a%2Fb~1?id=007&q=c%2B%2B+guide%20v2&path=%252Fdir%7Ehome&filter=&tag=a&tag=b&debug&%75tm_source=mail&fbclid=IwAR123&mc_eid=999&_hsenc=p2ANq#section-%20one";
    const res = cleanSingleLine(raw, 1);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    expect(res.cleanedUrl).toBe(
      "https://shop.example.com/path/a%2Fb~1?id=007&q=c%2B%2B+guide%20v2&path=%252Fdir%7Ehome&filter=&tag=a&tag=b&debug#section-%20one",
    );
    expect(res.removedParams.map((p) => p.decodedKey)).toEqual([
      "utm_source",
      "fbclid",
      "mc_eid",
      "_hsenc",
    ]);

    // Idempotency check: cleaning again yields zero further changes
    const second = cleanSingleLine(res.cleanedUrl, 1);
    expect(second.status).toBe("ok");
    if (second.status === "ok") {
      expect(second.changed).toBe(false);
      expect(second.cleanedUrl).toBe(res.cleanedUrl);
    }
  });

  it("applies site-specific rules only within verified domain & path boundaries and keeps generic params", () => {
    // YouTube & Spotify strip `si`, while generic e-commerce keeps `si`, `id`, `token`, `ref`, `source`
    const yt = cleanSingleLine(
      "https://youtu.be/dQw4w9WgXcQ?t=42&si=TrackShare123&feature=shared",
      1,
    );
    expect(yt.status === "ok" && yt.cleanedUrl).toBe("https://youtu.be/dQw4w9WgXcQ?t=42");

    const spotify = cleanSingleLine(
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123def&nd=1",
      1,
    );
    expect(spotify.status === "ok" && spotify.cleanedUrl).toBe(
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    );

    const shop = cleanSingleLine(
      "https://store.example.com/item?si=XL&id=42&token=live_tok&ref=sidebar&source=organic",
      1,
    );
    expect(shop.status === "ok" && shop.changed).toBe(false);
    expect(shop.status === "ok" && shop.cleanedUrl).toBe(
      "https://store.example.com/item?si=XL&id=42&token=live_tok&ref=sidebar&source=organic",
    );

    // X status strips `s` and `t`, while X search and WordPress `/?s=` keep them
    const xStatus = cleanSingleLine("https://x.com/alice/status/1800000000000000000?s=20&t=xyz", 1);
    expect(xStatus.status === "ok" && xStatus.cleanedUrl).toBe(
      "https://x.com/alice/status/1800000000000000000",
    );

    const xSearch = cleanSingleLine("https://x.com/search?q=tauri&s=09", 1);
    expect(xSearch.status === "ok" && xSearch.cleanedUrl).toBe("https://x.com/search?q=tauri&s=09");

    // Amazon strips pd_rd_* / pf_rd_* / qid / sr / ref_ while keeping psc / th / k
    const amz = cleanSingleLine(
      "https://www.amazon.co.jp/dp/B000000000?psc=1&th=1&pd_rd_w=abc&pf_rd_p=def&qid=1700000000&sr=8-1&ref_=nav_ya_signin",
      1,
    );
    expect(amz.status === "ok" && amz.cleanedUrl).toBe(
      "https://www.amazon.co.jp/dp/B000000000?psc=1&th=1",
    );
  });

  it("distinguishes originally bare '?', query cleaned to empty, and interior empty segments", () => {
    // 1. Originally bare '?' with no trackers -> preserved as-is
    const bareQ = cleanSingleLine("https://example.com/list?#top", 1);
    expect(bareQ.status === "ok" && bareQ.cleanedUrl).toBe("https://example.com/list?#top");

    // 2. Non-empty query whose every parameter is a tracker -> '?' omitted completely
    const allTrackers = cleanSingleLine("https://example.com/list?utm_source=x&gclid=123#top", 1);
    expect(allTrackers.status === "ok" && allTrackers.cleanedUrl).toBe(
      "https://example.com/list#top",
    );

    // 3. Query with interior empty segment (`a=1&&b=2`) alongside removed tracker -> keeps `a=1&&b=2`
    const emptySeg = cleanSingleLine("https://example.com/list?&a=1&&b=2&utm_medium=social&", 1);
    expect(emptySeg.status === "ok" && emptySeg.cleanedUrl).toBe(
      "https://example.com/list?a=1&&b=2",
    );
  });

  it("skips parameter stripping on presigned URLs so cryptographic signatures never break", () => {
    const presigned =
      "https://bucket.s3.amazonaws.com/invoice.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcdef&utm_source=billing_email";
    const res = cleanSingleLine(presigned, 1);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.presignedSkippedKey).toBe("X-Amz-Algorithm");
    expect(res.changed).toBe(false);
    expect(res.cleanedUrl).toBe(presigned);
  });

  it("unwraps nested known redirect wrappers offline, enforces strict host boundaries, and decodes only once per layer", () => {
    // Nested: Outlook Safe Links -> Facebook l.php -> Instagram post with igsh & utm_source
    const innerTarget =
      "https://www.instagram.com/p/C0ffee123/?igsh=MzRlODBiNWFlZA%3D%3D&keep=a+b%20c%2B1&utm_source=ig_web";
    const fbWrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(innerTarget)}&h=AT0xyz`;
    const outlookWrapped =
      `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(fbWrapped)}&data=05%7C01&sdata= fake&reserved=0`.replace(
        " fake",
        "fake",
      );

    const res = cleanSingleLine(outlookWrapped, 1);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.unwrapSteps.map((s) => s.wrapperId)).toEqual(["outlook_safelinks", "facebook_l"]);
    expect(res.cleanedUrl).toBe("https://www.instagram.com/p/C0ffee123/?keep=a+b%20c%2B1");

    // Spoofed domains must NEVER unwrap
    const spoofGoogle =
      "https://google.com.evil.example/url?q=https%3A%2F%2Fbank.example.com&utm_source=phish";
    const spoofRes = cleanSingleLine(spoofGoogle, 1);
    expect(spoofRes.status).toBe("ok");
    if (spoofRes.status === "ok") {
      expect(spoofRes.unwrapSteps).toHaveLength(0);
      expect(spoofRes.cleanedUrl).toBe(
        "https://google.com.evil.example/url?q=https%3A%2F%2Fbank.example.com",
      );
    }

    // Double-encoded scheme must NOT be decoded twice to manufacture a URL
    const doubleEncoded =
      "https://www.linkedin.com/redir/redirect?url=https%253A%252F%252Fexample.com%252F";
    const dblRes = cleanSingleLine(doubleEncoded, 1);
    expect(dblRes.status).toBe("ok");
    if (dblRes.status === "ok") {
      expect(dblRes.unwrapSteps).toHaveLength(0);
      expect(dblRes.unwrapStoppedReason?.kind).toBe("non_http_or_invalid_target");
    }

    // Unsafe javascript: target or malformed %ZZ target must stop safely
    const jsTarget = "https://www.google.com/url?url=javascript%3Aalert(1)";
    const jsRes = cleanSingleLine(jsTarget, 1);
    expect(jsRes.status === "ok" && jsRes.unwrapStoppedReason?.kind).toBe(
      "non_http_or_invalid_target",
    );

    const badPctTarget = "https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F%ZZ";
    const badPctRes = cleanSingleLine(badPctTarget, 1);
    expect(badPctRes.status === "ok" && badPctRes.unwrapStoppedReason?.kind).toBe(
      "malformed_target_encoding",
    );

    // Wrapper around a presigned target unwraps the wrapper, then preserves the presigned target intact
    const signedInner =
      "https://cdn.example.com/archive.zip?Expires=1900000000&sig=xyz987&utm_medium=email";
    const wrappedSigned = `https://www.google.com/url?q=${encodeURIComponent(signedInner)}&sa=D`;
    const wsRes = cleanSingleLine(wrappedSigned, 1);
    expect(wsRes.status).toBe("ok");
    if (wsRes.status === "ok") {
      expect(wsRes.unwrapSteps).toHaveLength(1);
      expect(wsRes.presignedSkippedKey).toBe("sig");
      expect(wsRes.cleanedUrl).toBe(signedInner);
    }

    // > 5 nested wrappers stops cleanly at depth 5
    let deep = "https://example.com/final?utm_source=deep";
    for (let i = 0; i < 6; i++) {
      deep = `https://www.google.com/url?url=${encodeURIComponent(deep)}&layer=${i}`;
    }
    const deepRes = cleanSingleLine(deep, 1);
    expect(deepRes.status).toBe("ok");
    if (deepRes.status === "ok") {
      expect(deepRes.unwrapSteps).toHaveLength(5);
      expect(deepRes.unwrapStoppedReason).toEqual({
        kind: "max_depth_reached",
        maxDepth: 5,
      });
    }
  });

  it("handles mixed valid/invalid batch lines in place and guards links-only clipboard replacement", () => {
    const batchText = [
      "https://news.example.com/story?id=10&utm_campaign=daily",
      "not a url — meeting notes at 3pm",
      "ftp://files.example.com/pub.zip",
      "https://tiktok.com/@creator/video/123456?_t=8abc&_r=1&lang=zh",
    ].join("\n");

    const batch = cleanLinksBatch(batchText);
    expect(batch.status).toBe("ok");
    if (batch.status !== "ok") return;
    expect(batch.validCount).toBe(2);
    expect(batch.invalidCount).toBe(2);
    expect(batch.allValidCleanedText).toBe(
      "https://news.example.com/story?id=10\nhttps://tiktok.com/@creator/video/123456?lang=zh",
    );

    // Mixed text must NOT replace clipboard in one-click mode
    const mixedClip = evaluateClipboardLinksOnlyReplace(batchText);
    expect(mixedClip.canReplace).toBe(false);

    // Pure-links clipboard replaces cleanly
    const pureClip = evaluateClipboardLinksOnlyReplace(
      "https://news.example.com/story?id=10&utm_source=rss\r\nhttps://youtu.be/abc?si=track1",
    );
    expect(pureClip.canReplace).toBe(true);
    if (pureClip.canReplace) {
      expect(pureClip.replacementText).toBe(
        "https://news.example.com/story?id=10\r\nhttps://youtu.be/abc",
      );
    }
  });
});
