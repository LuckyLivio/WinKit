/**
 * WinKit Local Link Tracking & Redirect Unwrapping Rule Catalog
 * Rule Set Version: 2026.11-r1
 *
 * Principles:
 * 1. Conservative by default: ambiguous or general-purpose parameter names such as
 *    `id`, `token`, `ref`, `source`, `q`, `page`, `lang`, `code`, `state`, `size`,
 *    or `si` (outside YouTube/Spotify) are NEVER treated globally as tracking.
 * 2. Site-specific parameters apply strictly within verified domain boundaries
 *    (`host === domain || host.endsWith("." + domain)`) and optional path patterns.
 * 3. Redirect unwrapping operates strictly offline on known wrapper hosts, paths,
 *    and documented target query parameters (decoding at most one layer per wrapper).
 */

export const CLEAN_LINKS_RULES_VERSION = "2026.11-r1";

export type TrackingCategory =
  | "utm_campaign"
  | "ad_click_id"
  | "email_marketing"
  | "analytics_cross_domain"
  | "social_share"
  | "ecommerce_attribution";

export interface UniversalParamRule {
  nameLower: string;
  category: TrackingCategory;
  sourceLabel: string;
}

export interface UniversalPrefixRule {
  prefixLower: string;
  category: TrackingCategory;
  sourceLabel: string;
}

export interface SiteSpecificParamRule {
  id: string;
  providerLabel: string;
  domains: readonly string[];
  pathPattern?: RegExp;
  paramNamesLower: ReadonlySet<string>;
  category: TrackingCategory;
}

export interface RedirectWrapperRule {
  id: string;
  providerLabel: string;
  domains: readonly string[];
  exactHostOnly?: boolean;
  allowedPaths: readonly string[] | "any";
  targetParams: readonly string[];
}

export const UNIVERSAL_PREFIX_RULES: readonly UniversalPrefixRule[] = [
  {
    prefixLower: "utm_",
    category: "utm_campaign",
    sourceLabel: "UTM Campaign",
  },
  {
    prefixLower: "hsa_",
    category: "email_marketing",
    sourceLabel: "HubSpot Ads",
  },
  {
    prefixLower: "mtm_",
    category: "analytics_cross_domain",
    sourceLabel: "Matomo Campaign",
  },
];

const EXACT_UNIVERSAL_ENTRIES: ReadonlyArray<[string, TrackingCategory, string]> = [
  // Ad platform click identifiers
  ["fbclid", "ad_click_id", "Meta Ads"],
  ["gclid", "ad_click_id", "Google Ads"],
  ["gclsrc", "ad_click_id", "Google Ads"],
  ["dclid", "ad_click_id", "Google Display & Video"],
  ["gbraid", "ad_click_id", "Google Ads iOS"],
  ["wbraid", "ad_click_id", "Google Ads Web-to-App"],
  ["msclkid", "ad_click_id", "Microsoft Advertising"],
  ["twclid", "ad_click_id", "X / Twitter Ads"],
  ["ttclid", "ad_click_id", "TikTok Ads"],
  ["li_fat_id", "ad_click_id", "LinkedIn Ads"],
  ["epik", "ad_click_id", "Pinterest Ads"],
  ["sccid", "ad_click_id", "Snapchat Ads"],
  ["yclid", "ad_click_id", "Yandex Direct"],
  ["ysclid", "ad_click_id", "Yandex Search"],
  ["_openstat", "ad_click_id", "Openstat"],
  ["wickedid", "ad_click_id", "Wicked Reports"],
  ["irclickid", "ad_click_id", "Impact Affiliate"],

  // Email & marketing automation
  ["mc_cid", "email_marketing", "Mailchimp"],
  ["mc_eid", "email_marketing", "Mailchimp"],
  ["_hsenc", "email_marketing", "HubSpot"],
  ["_hsmi", "email_marketing", "HubSpot"],
  ["__hssc", "email_marketing", "HubSpot"],
  ["__hstc", "email_marketing", "HubSpot"],
  ["__hsfp", "email_marketing", "HubSpot"],
  ["mkt_tok", "email_marketing", "Adobe Marketo"],
  ["_kx", "email_marketing", "Klaviyo"],
  ["vero_id", "email_marketing", "Vero"],
  ["vero_conv", "email_marketing", "Vero"],
  ["oly_enc_id", "email_marketing", "Omeda"],
  ["oly_anon_id", "email_marketing", "Omeda"],
  ["vgo_ee", "email_marketing", "ActiveCampaign"],

  // Analytics cross-domain & legacy campaign tags
  ["_ga", "analytics_cross_domain", "Google Analytics"],
  ["_gl", "analytics_cross_domain", "Google Linker"],
  ["pk_campaign", "analytics_cross_domain", "Matomo / Piwik"],
  ["pk_kwd", "analytics_cross_domain", "Matomo / Piwik"],
  ["pk_source", "analytics_cross_domain", "Matomo / Piwik"],
  ["pk_medium", "analytics_cross_domain", "Matomo / Piwik"],
  ["pk_content", "analytics_cross_domain", "Matomo / Piwik"],
  ["pk_cid", "analytics_cross_domain", "Matomo / Piwik"],
];

export const UNIVERSAL_EXACT_MAP: ReadonlyMap<string, UniversalParamRule> = new Map(
  EXACT_UNIVERSAL_ENTRIES.map(([nameLower, category, sourceLabel]) => [
    nameLower,
    { nameLower, category, sourceLabel },
  ]),
);

const AMAZON_DOMAINS = [
  "amazon.com",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.co.jp",
  "amazon.ca",
  "amazon.it",
  "amazon.es",
  "amazon.cn",
  "amazon.in",
  "amazon.com.au",
  "amazon.com.br",
  "amazon.com.mx",
  "amazon.nl",
  "amazon.se",
  "amazon.pl",
  "amazon.sg",
] as const;

export const SITE_SPECIFIC_RULES: readonly SiteSpecificParamRule[] = [
  {
    id: "youtube",
    providerLabel: "YouTube",
    domains: ["youtube.com", "youtu.be"],
    paramNamesLower: new Set(["si", "pp", "feature", "kw"]),
    category: "social_share",
  },
  {
    id: "spotify",
    providerLabel: "Spotify",
    domains: ["spotify.com"],
    paramNamesLower: new Set(["si", "nd"]),
    category: "social_share",
  },
  {
    id: "instagram",
    providerLabel: "Instagram",
    domains: ["instagram.com"],
    paramNamesLower: new Set(["igsh", "igshid"]),
    category: "social_share",
  },
  {
    id: "tiktok",
    providerLabel: "TikTok",
    domains: ["tiktok.com"],
    paramNamesLower: new Set([
      "_t",
      "_r",
      "is_from_webapp",
      "sender_device",
      "sender_web_id",
      "u_code",
      "share_app_id",
      "share_item_id",
      "share_link_id",
    ]),
    category: "social_share",
  },
  {
    id: "amazon",
    providerLabel: "Amazon",
    domains: AMAZON_DOMAINS,
    paramNamesLower: new Set([
      "pd_rd_i",
      "pd_rd_r",
      "pd_rd_w",
      "pd_rd_wg",
      "pf_rd_i",
      "pf_rd_m",
      "pf_rd_p",
      "pf_rd_r",
      "pf_rd_s",
      "pf_rd_t",
      "qid",
      "sr",
      "dib",
      "dib_tag",
      "linkcode",
      "linkid",
      "ascsubtag",
      "ref_",
    ]),
    category: "ecommerce_attribution",
  },
  {
    id: "x_status",
    providerLabel: "X / Twitter Status",
    domains: ["x.com", "twitter.com"],
    pathPattern: /^\/[^/]+\/status\/\d+/i,
    paramNamesLower: new Set(["s", "t"]),
    category: "social_share",
  },
  {
    id: "linkedin_feed",
    providerLabel: "LinkedIn",
    domains: ["linkedin.com"],
    paramNamesLower: new Set(["trk", "trkinfo", "lipi", "licu", "rcm"]),
    category: "social_share",
  },
  {
    id: "reddit",
    providerLabel: "Reddit",
    domains: ["reddit.com"],
    paramNamesLower: new Set(["rdt_cid", "share_id"]),
    category: "social_share",
  },
];

/**
 * Conservative presigned / cryptographically signed URL parameter indicators.
 * When any parameter in a URL matches, parameter cleaning is skipped across the ENTIRE URL
 * so signed query strings (AWS S3 SigV4/V2, CloudFront, GCS, Azure SAS, OSS/COS) never break.
 */
export const PRESIGNED_SIGNATURE_PARAM_NAMES: ReadonlySet<string> = new Set([
  "sig",
  "signature",
  "hmac",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-algorithm",
  "x-amz-security-token",
  "awsaccesskeyid",
  "key-pair-id",
  "x-goog-signature",
  "x-goog-credential",
  "x-goog-algorithm",
  "googleaccessid",
  "x-oss-signature",
  "ossaccesskeyid",
  "q-signature",
  "q-sign-algorithm",
  "x-obs-signature",
]);

const GOOGLE_REDIRECT_DOMAINS = [
  "google.com",
  "google.co.uk",
  "google.de",
  "google.fr",
  "google.co.jp",
  "google.com.hk",
  "google.ca",
  "google.com.au",
  "google.com.sg",
  "google.com.tw",
  "google.it",
  "google.es",
  "google.nl",
] as const;

export const REDIRECT_WRAPPER_RULES: readonly RedirectWrapperRule[] = [
  {
    id: "google_url",
    providerLabel: "Google Search / Mail Redirect",
    domains: GOOGLE_REDIRECT_DOMAINS,
    allowedPaths: ["/url"],
    targetParams: ["url", "q"],
  },
  {
    id: "facebook_l",
    providerLabel: "Facebook Link Shim",
    domains: ["facebook.com"],
    allowedPaths: ["/l.php"],
    targetParams: ["u"],
  },
  {
    id: "instagram_l",
    providerLabel: "Instagram Link Shim",
    domains: ["l.instagram.com"],
    exactHostOnly: true,
    allowedPaths: ["/"],
    targetParams: ["u"],
  },
  {
    id: "outlook_safelinks",
    providerLabel: "Outlook Safe Links",
    domains: ["safelinks.protection.outlook.com"],
    allowedPaths: "any",
    targetParams: ["url"],
  },
  {
    id: "linkedin_redirect",
    providerLabel: "LinkedIn Redirect",
    domains: ["linkedin.com"],
    allowedPaths: ["/redir/redirect", "/safety/go"],
    targetParams: ["url"],
  },
];

export function matchesDomainBoundary(
  rawHostname: string,
  allowedDomains: readonly string[],
  exactHostOnly = false,
): boolean {
  const host = rawHostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return allowedDomains.some((domain) => {
    if (host === domain) return true;
    if (exactHostOnly) return false;
    return host.endsWith(`.${domain}`);
  });
}

export interface MatchedTrackingRule {
  scope: "universal" | "site";
  providerLabel: string;
  category: TrackingCategory;
}

export function matchTrackingParameter(
  decodedParamName: string,
  hostname: string,
  pathname: string,
): MatchedTrackingRule | null {
  const lower = decodedParamName.toLowerCase();
  if (!lower) return null;

  const exactUniversal = UNIVERSAL_EXACT_MAP.get(lower);
  if (exactUniversal) {
    return {
      scope: "universal",
      providerLabel: exactUniversal.sourceLabel,
      category: exactUniversal.category,
    };
  }

  for (const prefixRule of UNIVERSAL_PREFIX_RULES) {
    if (lower.startsWith(prefixRule.prefixLower) && lower.length > prefixRule.prefixLower.length) {
      return {
        scope: "universal",
        providerLabel: prefixRule.sourceLabel,
        category: prefixRule.category,
      };
    }
  }

  for (const siteRule of SITE_SPECIFIC_RULES) {
    if (!matchesDomainBoundary(hostname, siteRule.domains)) {
      continue;
    }
    if (siteRule.pathPattern && !siteRule.pathPattern.test(pathname)) {
      continue;
    }
    if (siteRule.paramNamesLower.has(lower)) {
      return {
        scope: "site",
        providerLabel: siteRule.providerLabel,
        category: siteRule.category,
      };
    }
  }

  return null;
}

export function findMatchingRedirectWrapper(
  hostname: string,
  pathname: string,
): RedirectWrapperRule | null {
  for (const wrapper of REDIRECT_WRAPPER_RULES) {
    if (!matchesDomainBoundary(hostname, wrapper.domains, Boolean(wrapper.exactHostOnly))) {
      continue;
    }
    if (wrapper.allowedPaths !== "any" && !wrapper.allowedPaths.includes(pathname)) {
      continue;
    }
    return wrapper;
  }
  return null;
}
