import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOMAIN_MAPPINGS,
  normalizeDomainRuleInput,
  resolveMappedSiteName,
  validateDomainMappingInput,
} from "./organizeEngine";

describe("organizeEngine (F05)", () => {
  it("enforces strict domain-boundary matching and longest-match specificity", () => {
    expect(resolveMappedSiteName("pbs.twimg.com", DEFAULT_DOMAIN_MAPPINGS)).toBe("X (Twitter)");
    expect(resolveMappedSiteName("sub.pbs.twimg.com", DEFAULT_DOMAIN_MAPPINGS)).toBe("X (Twitter)");
    expect(resolveMappedSiteName("wx2.sinaimg.cn", DEFAULT_DOMAIN_MAPPINGS)).toBe("Weibo");
    // Must NEVER false-match suffix strings without a dot boundary
    expect(resolveMappedSiteName("notgithub.com", DEFAULT_DOMAIN_MAPPINGS)).toBeNull();
    expect(resolveMappedSiteName("fakex.com", DEFAULT_DOMAIN_MAPPINGS)).toBeNull();
    expect(resolveMappedSiteName("my-sinaimg.cn", DEFAULT_DOMAIN_MAPPINGS)).toBeNull();

    // More specific rule wins over parent domain rule
    const custom = [
      { domain: "example.com", siteName: "Example General" },
      { domain: "cdn.example.com", siteName: "Example CDN" },
    ];
    expect(resolveMappedSiteName("img.cdn.example.com", custom)).toBe("Example CDN");
    expect(resolveMappedSiteName("www.example.com", custom)).toBe("Example General");
  });

  it("normalizes and validates user-edited mapping rules", () => {
    expect(normalizeDomainRuleInput(" https://PBS.TWIMG.COM/media/123?format=jpg ")).toBe(
      "pbs.twimg.com",
    );
    expect(validateDomainMappingInput("i.imgur.com", "Imgur")).toBeNull();
    expect(validateDomainMappingInput("", "Imgur")).toBe("empty_domain");
    expect(validateDomainMappingInput("localhost", "Local")).toBe("invalid_domain");
    expect(validateDomainMappingInput("i.imgur.com", "")).toBe("empty_site");
    expect(validateDomainMappingInput("i.imgur.com", "Bad/Name")).toBe("invalid_site");
  });
});
