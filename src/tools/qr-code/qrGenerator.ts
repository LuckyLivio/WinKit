import QRCode from "qrcode";

export type WifiSecurity = "WPA" | "WEP" | "nopass";
export type CorrectionLevel = "L" | "M" | "Q" | "H";

export interface WifiInput {
  ssid: string;
  security: WifiSecurity;
  password: string;
  hidden: boolean;
}

export function wifiPayload({ ssid, security, password, hidden }: WifiInput): string {
  if (!ssid) return "";
  const escape = (field: string) => field.replace(/[\\;,":]/g, (c) => `\\${c}`);
  const fields = [`WIFI:T:${security}`, `S:${escape(ssid)}`];
  if (security !== "nopass") fields.push(`P:${escape(password)}`);
  if (hidden) fields.push("H:true");
  return fields.join(";") + ";;";
}

interface QrStyle {
  size: number;
  foreground: string;
  background: string;
  correction: CorrectionLevel;
}

export const DEFAULT_QR_STYLE: QrStyle = {
  size: 512,
  foreground: "#000000",
  background: "#ffffff",
  correction: "M",
};

interface Run {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QrImage {
  size: number;
  foreground: string;
  background: string;
  runs: Run[];
  svg: string;
}

type QrResult = { image: QrImage } | { error: "empty" | "capacity" | "size" | "color" };

export function generateQr(payload: string, style: QrStyle): QrResult {
  if (!payload) return { error: "empty" };
  // Version 40-L holds at most 7,089 digits. Other modes have smaller capacities.
  if (payload.length > 7089) return { error: "capacity" };
  const { size, foreground, background } = style;
  if (!Number.isInteger(size) || size < 64 || size > 2048) return { error: "size" };
  if (
    ![foreground, background].every((c) => /^#[0-9a-f]{6}$/i.test(c)) ||
    foreground.toLowerCase() === background.toLowerCase()
  ) {
    return { error: "color" };
  }

  let symbol;
  try {
    symbol = QRCode.create(payload, { errorCorrectionLevel: style.correction });
  } catch {
    return { error: "capacity" };
  }

  const modules = symbol.modules;
  const quietZone = 4;
  const total = modules.size + 2 * quietZone;
  if (size < total) return { error: "size" };
  const boundary = (index: number) => Math.round(((index + quietZone) * size) / total);
  const runs: Run[] = [];
  for (let row = 0; row < modules.size; row++) {
    let col = 0;
    while (col < modules.size) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      do {
        col++;
      } while (col < modules.size && modules.get(row, col));
      const x = boundary(start);
      const y = boundary(row);
      runs.push({ x, y, width: boundary(col) - x, height: boundary(row + 1) - y });
    }
  }
  const path = runs
    .map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h-${width}z`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${background}"/><path d="${path}" fill="${foreground}"/></svg>`;
  return { image: { size, foreground, background, runs, svg } };
}

export function pngFromQr(image: QrImage): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = image.size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");
  context.fillStyle = image.background;
  context.fillRect(0, 0, image.size, image.size);
  context.fillStyle = image.foreground;
  for (const run of image.runs) context.fillRect(run.x, run.y, run.width, run.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );
}
