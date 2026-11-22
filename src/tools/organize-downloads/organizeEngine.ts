export type OrganizeNamingMode = "site_alias" | "domain_only";

export type OrganizeItemStatus =
  | "ready"
  | "already_organized"
  | "no_source"
  | "metadata_unreadable"
  | "unsupported_fs"
  | "conflict_exists"
  | "invalid_target";

export type OrganizeItemAction = "move" | "stay_in_place" | "already_organized" | "skip_conflict";

export interface DomainMappingRule {
  id: string;
  domain: string;
  siteName: string;
}

export interface OrganizePreviewRequest {
  folderPath: string;
  namingMode: OrganizeNamingMode;
  moveUnknownToFolder: boolean;
  unknownFolderName: string;
  mappings: Array<{ domain: string; siteName: string }>;
}

export interface OrganizePreviewItem {
  sourcePath: string;
  fileName: string;
  byteLength: number;
  modifiedMs: number | null;
  fileIdKey: string | null;
  contentSha256: string | null;
  zoneId: number | null;
  sourceField: "host_url" | "referrer_url" | null;
  detectedDomain: string | null;
  mappedSiteName: string | null;
  targetFolderName: string | null;
  targetRelPath: string | null;
  status: OrganizeItemStatus;
  action: OrganizeItemAction;
  reason: string | null;
}

export interface OrganizePreviewResponse {
  folderPath: string;
  volumeSupportsAds: boolean;
  totalImageCount: number;
  nonImageCount: number;
  readyCount: number;
  alreadyOrganizedCount: number;
  stayInPlaceCount: number;
  conflictCount: number;
  items: OrganizePreviewItem[];
}

export interface OrganizeExecuteItemInput {
  sourcePath: string;
  fileName: string;
  targetFolderName: string;
  expectedByteLength: number;
  expectedModifiedMs: number | null;
  expectedFileIdKey: string | null;
  expectedSha256: string;
}

export interface OrganizeExecuteRequest {
  folderPath: string;
  items: OrganizeExecuteItemInput[];
}

export type OrganizeExecuteOutcomeStatus = "moved" | "skipped" | "failed";

export interface OrganizeExecuteItemOutcome {
  sourcePath: string;
  targetPath: string | null;
  fileName: string;
  status: OrganizeExecuteOutcomeStatus;
  reason: string | null;
}

export interface OrganizeExecuteResponse {
  folderPath: string;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  outcomes: OrganizeExecuteItemOutcome[];
}

export const DEFAULT_DOMAIN_MAPPINGS: readonly DomainMappingRule[] = [
  { id: "x-pbs", domain: "pbs.twimg.com", siteName: "X (Twitter)" },
  { id: "x-ton", domain: "ton.twimg.com", siteName: "X (Twitter)" },
  { id: "x-com", domain: "x.com", siteName: "X (Twitter)" },
  { id: "twitter", domain: "twitter.com", siteName: "X (Twitter)" },
  { id: "reddit-i", domain: "i.redd.it", siteName: "Reddit" },
  { id: "reddit-prev", domain: "preview.redd.it", siteName: "Reddit" },
  { id: "reddit", domain: "reddit.com", siteName: "Reddit" },
  { id: "unsplash-img", domain: "images.unsplash.com", siteName: "Unsplash" },
  { id: "unsplash", domain: "unsplash.com", siteName: "Unsplash" },
  { id: "pixiv-img", domain: "i.pximg.net", siteName: "Pixiv" },
  { id: "pixiv", domain: "pixiv.net", siteName: "Pixiv" },
  { id: "discord-cdn", domain: "cdn.discordapp.com", siteName: "Discord" },
  { id: "discord-media", domain: "media.discordapp.net", siteName: "Discord" },
  { id: "github-avatars", domain: "avatars.githubusercontent.com", siteName: "GitHub" },
  { id: "github-userimg", domain: "user-images.githubusercontent.com", siteName: "GitHub" },
  { id: "github-raw", domain: "raw.githubusercontent.com", siteName: "GitHub" },
  { id: "github", domain: "github.com", siteName: "GitHub" },
  { id: "medium", domain: "miro.medium.com", siteName: "Medium" },
  { id: "pinterest", domain: "i.pinimg.com", siteName: "Pinterest" },
  { id: "wikimedia", domain: "upload.wikimedia.org", siteName: "Wikimedia" },
  { id: "pexels", domain: "images.pexels.com", siteName: "Pexels" },
  { id: "weibo", domain: "sinaimg.cn", siteName: "Weibo" },
  { id: "zhihu", domain: "zhimg.com", siteName: "Zhihu" },
  { id: "bilibili", domain: "hdslb.com", siteName: "Bilibili" },
];

export function normalizeDomainRuleInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  const slashIdx = s.indexOf("/");
  if (slashIdx >= 0) s = s.slice(0, slashIdx);
  const colonIdx = s.indexOf(":");
  if (colonIdx >= 0) s = s.slice(0, colonIdx);
  s = s.replace(/^\.+|\.+$/g, "");
  return s;
}

/**
 * Strict domain-boundary matching: `host === ruleDomain || host.endsWith("." + ruleDomain)`.
 * Selects the longest (most specific) matching rule domain.
 */
export function resolveMappedSiteName(
  host: string,
  mappings: readonly Pick<DomainMappingRule, "domain" | "siteName">[],
): string | null {
  const normalizedHost = normalizeDomainRuleInput(host);
  if (!normalizedHost) return null;

  let bestLen = 0;
  let bestSite: string | null = null;
  for (const rule of mappings) {
    const ruleDomain = normalizeDomainRuleInput(rule.domain);
    const siteName = rule.siteName.trim();
    if (!ruleDomain || !siteName) continue;
    const matched = normalizedHost === ruleDomain || normalizedHost.endsWith(`.${ruleDomain}`);
    if (matched && ruleDomain.length > bestLen) {
      bestLen = ruleDomain.length;
      bestSite = siteName;
    }
  }
  return bestSite;
}

export function validateDomainMappingInput(
  domain: string,
  siteName: string,
): "empty_domain" | "invalid_domain" | "empty_site" | "invalid_site" | null {
  const norm = normalizeDomainRuleInput(domain);
  if (!norm) return "empty_domain";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(norm)) {
    return "invalid_domain";
  }
  const site = siteName.trim();
  if (!site) return "empty_site";
  if (/[<>:"/\\|?*]/.test(site) || site === "." || site === "..") {
    return "invalid_site";
  }
  return null;
}

export function formatOrganizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
