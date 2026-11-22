/** The decoded text stays visible verbatim. Offer external navigation only for complete web URLs. */
export function isQrWebUrl(content: string): boolean {
  if (!/^https?:\/\//i.test(content) || /[\s\\]/u.test(content)) return false;
  try {
    const url = new URL(content);
    return Boolean(url.hostname) && !Array.from(content).some((c) => c.charCodeAt(0) < 32);
  } catch {
    return false;
  }
}

export function wifiPassword(content: string): string | null {
  if (!content.startsWith("WIFI:")) return null;
  let field = "";
  let escaped = false;
  let security = "";
  let password: string | null = null;
  for (const ch of content.slice(5) + ";") {
    if (escaped) {
      field += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === ";") {
      if (field.startsWith("T:")) security = field.slice(2).toLowerCase();
      if (field.startsWith("P:")) password = field.slice(2);
      field = "";
    } else {
      field += ch;
    }
  }
  return security === "nopass" || !password ? null : password;
}
