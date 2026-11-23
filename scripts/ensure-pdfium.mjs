import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PDFIUM_TAG = "chromium/8179";
const PDFIUM_VERSION = "160.0.8179.0";
const ARCHIVE_FILENAME = "pdfium-win-x64.tgz";
const ARCHIVE_URL = `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/${ARCHIVE_FILENAME}`;
const EXPECTED_ARCHIVE_BYTES = 4046589;
const EXPECTED_ARCHIVE_SHA256 =
  "836a77c9053f624839c66010cddea7b675628a36b8831d2330178bb169d241b6";

const DLL_FILENAME = "pdfium.dll";
const EXPECTED_DLL_BYTES = 7849984;
const EXPECTED_DLL_SHA256 =
  "b9324fe77556753e24443b8ff1d03b39a3aa01ccd6e56e7debb82922438e8965";
const NOTICE_FILENAME = "LICENSE-pdfium.txt";

const destDir = path.join(repoRoot, "src-tauri", "resources", "pdfium");
const dllPath = path.join(destDir, DLL_FILENAME);
const noticePath = path.join(destDir, NOTICE_FILENAME);

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return { bytes: buf.length, hash: sha256Buffer(buf) };
}

function readTarEntries(tarBuffer) {
  const entries = new Map();
  let offset = 0;
  let pendingLongName = null;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      break;
    }

    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefixRaw = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeRaw = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const typeFlag = header[156];
    const size = sizeRaw ? Number.parseInt(sizeRaw, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size at offset ${offset}: ${sizeRaw}`);
    }

    offset += 512;
    const dataEnd = offset + size;
    if (dataEnd > tarBuffer.length) {
      throw new Error(`Truncated tar entry at offset ${offset}`);
    }
    const content = tarBuffer.subarray(offset, dataEnd);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    // GNU LongLink ('L' = 76)
    if (typeFlag === 76) {
      pendingLongName = content.toString("utf8").replace(/\0.*$/, "");
      continue;
    }

    const rawPath = pendingLongName ?? (prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw);
    pendingLongName = null;
    const normalized = rawPath.replace(/^\.\//, "").replace(/\\/g, "/");

    // Regular file ('0' = 48 or '\0' = 0)
    if (typeFlag === 48 || typeFlag === 0) {
      entries.set(normalized, Buffer.from(content));
    }
  }

  return entries;
}

function buildCombinedNotice(entries) {
  const sections = [
    [
      "WinKit Bundled PDFium Binary & Third-Party License Notices",
      "==========================================================",
      `Upstream distribution : bblanchon/pdfium-binaries (${PDFIUM_TAG})`,
      `PDFium version        : ${PDFIUM_VERSION}`,
      `Archive               : ${ARCHIVE_FILENAME} (${EXPECTED_ARCHIVE_BYTES} bytes, SHA-256 ${EXPECTED_ARCHIVE_SHA256})`,
      `Bundled DLL           : ${DLL_FILENAME} (${EXPECTED_DLL_BYTES} bytes, SHA-256 ${EXPECTED_DLL_SHA256})`,
      `Release URL           : https://github.com/bblanchon/pdfium-binaries/releases/tag/${PDFIUM_TAG}`,
      "",
    ].join("\n"),
  ];

  const licenseKeys = Array.from(entries.keys())
    .filter((key) => key === "LICENSE" || key.startsWith("licenses/"))
    .sort((a, b) => {
      if (a === "LICENSE") return -1;
      if (b === "LICENSE") return 1;
      return a.localeCompare(b);
    });

  if (licenseKeys.length === 0) {
    throw new Error("Expected LICENSE and licenses/* entries inside pdfium-win-x64.tgz");
  }

  for (const key of licenseKeys) {
    const text = entries.get(key).toString("utf8").replace(/\r\n/g, "\n").trim();
    sections.push(`----- BEGIN ${key} -----\n${text}\n----- END ${key} -----\n`);
  }

  return `${sections.join("\n")}\n`;
}

function writeAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, targetPath);
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });

  if (fs.existsSync(dllPath) && fs.existsSync(noticePath)) {
    const existing = sha256File(dllPath);
    const noticeStat = fs.statSync(noticePath);
    if (
      existing.bytes === EXPECTED_DLL_BYTES &&
      existing.hash === EXPECTED_DLL_SHA256 &&
      noticeStat.size > 1024
    ) {
      console.log(
        `[ensure-pdfium] Verified cached ${DLL_FILENAME} (${existing.bytes} B) and ${NOTICE_FILENAME} (${noticeStat.size} B)`,
      );
      return;
    }
    console.warn(
      `[ensure-pdfium] Cached ${DLL_FILENAME} mismatch (${existing.bytes} B, ${existing.hash}), re-fetching...`,
    );
  }

  console.log(
    `[ensure-pdfium] Downloading ${ARCHIVE_FILENAME} (${PDFIUM_TAG}, PDFium ${PDFIUM_VERSION})...`,
  );
  const resp = await fetch(ARCHIVE_URL, {
    redirect: "follow",
    headers: { "User-Agent": "WinKit-Build/0.17.0" },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${ARCHIVE_URL}: HTTP ${resp.status} ${resp.statusText}`);
  }

  const archiveData = Buffer.from(await resp.arrayBuffer());
  const archiveHash = sha256Buffer(archiveData);
  if (archiveData.length !== EXPECTED_ARCHIVE_BYTES || archiveHash !== EXPECTED_ARCHIVE_SHA256) {
    throw new Error(
      `Archive checksum mismatch for ${ARCHIVE_FILENAME}: expected ${EXPECTED_ARCHIVE_BYTES} B / ${EXPECTED_ARCHIVE_SHA256}, got ${archiveData.length} B / ${archiveHash}`,
    );
  }

  const tarBuffer = zlib.gunzipSync(archiveData);
  const entries = readTarEntries(tarBuffer);
  const dllBuffer = entries.get("bin/pdfium.dll");
  if (!dllBuffer) {
    throw new Error("bin/pdfium.dll was not found inside pdfium-win-x64.tgz");
  }

  const dllHash = sha256Buffer(dllBuffer);
  if (dllBuffer.length !== EXPECTED_DLL_BYTES || dllHash !== EXPECTED_DLL_SHA256) {
    throw new Error(
      `DLL checksum mismatch for ${DLL_FILENAME}: expected ${EXPECTED_DLL_BYTES} B / ${EXPECTED_DLL_SHA256}, got ${dllBuffer.length} B / ${dllHash}`,
    );
  }

  const combinedNotice = buildCombinedNotice(entries);
  writeAtomic(dllPath, dllBuffer);
  writeAtomic(noticePath, Buffer.from(combinedNotice, "utf8"));
  console.log(
    `[ensure-pdfium] Saved verified ${DLL_FILENAME} (${dllBuffer.length} B, sha256=${dllHash}) and ${NOTICE_FILENAME} (${Buffer.byteLength(combinedNotice, "utf8")} B)`,
  );
}

main().catch((err) => {
  console.error(`[ensure-pdfium] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
