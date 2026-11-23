/**
 * Client-side 1-based page range parser/formatter used by P10 Delete Pages & P11 Extract Pages
 * for immediate upfront feedback before backend validation.
 */
export interface ClientPageRangeResult {
  valid: boolean;
  pages: number[];
  uniqueSorted: number[];
  duplicateCount: number;
  error: string | null;
}

export function parseClientPageRanges(raw: string, totalPages: number): ClientPageRangeResult {
  if (totalPages <= 0) {
    return { valid: false, pages: [], uniqueSorted: [], duplicateCount: 0, error: "No pages." };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, pages: [], uniqueSorted: [], duplicateCount: 0, error: "Empty range." };
  }

  const normalized = trimmed.replace(/，/g, ",").replace(/[–—]/g, "-");
  const pages: number[] = [];
  const seen = new Set<number>();
  let duplicateCount = 0;

  for (const part of normalized.split(",")) {
    const token = part.trim();
    if (!token) {
      return {
        valid: false,
        pages: [],
        uniqueSorted: [],
        duplicateCount: 0,
        error: `Empty segment in "${trimmed}"`,
      };
    }
    if (token.includes("-")) {
      const pieces = token.split("-");
      if (pieces.length !== 2) {
        return {
          valid: false,
          pages: [],
          uniqueSorted: [],
          duplicateCount: 0,
          error: `Invalid range "${token}"`,
        };
      }
      const start = Number.parseInt(pieces[0]!.trim(), 10);
      const end = Number.parseInt(pieces[1]!.trim(), 10);
      if (
        !/^\d+$/.test(pieces[0]!.trim()) ||
        !/^\d+$/.test(pieces[1]!.trim()) ||
        start < 1 ||
        end < 1 ||
        start > totalPages ||
        end > totalPages ||
        start > end
      ) {
        return {
          valid: false,
          pages: [],
          uniqueSorted: [],
          duplicateCount: 0,
          error: `Invalid or out-of-bounds range "${token}" (1-${totalPages})`,
        };
      }
      for (let p = start; p <= end; p += 1) {
        if (seen.has(p)) duplicateCount += 1;
        seen.add(p);
        pages.push(p);
      }
    } else {
      if (!/^\d+$/.test(token)) {
        return {
          valid: false,
          pages: [],
          uniqueSorted: [],
          duplicateCount: 0,
          error: `Invalid page number "${token}"`,
        };
      }
      const p = Number.parseInt(token, 10);
      if (p < 1 || p > totalPages) {
        return {
          valid: false,
          pages: [],
          uniqueSorted: [],
          duplicateCount: 0,
          error: `Page ${p} out of bounds (1-${totalPages})`,
        };
      }
      if (seen.has(p)) duplicateCount += 1;
      seen.add(p);
      pages.push(p);
    }
  }

  const uniqueSorted = Array.from(seen).sort((a, b) => a - b);
  return { valid: pages.length > 0, pages, uniqueSorted, duplicateCount, error: null };
}

export function formatCompactPages(pages: number[]): string {
  if (pages.length === 0) return "";
  const parts: string[] = [];
  let start = pages[0]!;
  let end = pages[0]!;
  for (let i = 1; i < pages.length; i += 1) {
    const p = pages[i]!;
    if (p === end + 1) {
      end = p;
    } else {
      parts.push(start === end ? `${start}` : `${start}-${end}`);
      start = p;
      end = p;
    }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(", ");
}
