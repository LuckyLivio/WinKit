import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const QPDF_VERSION = "12.4.2";
const QPDF_TAG = `v${QPDF_VERSION}`;
const ARCHIVE_FILENAME = `qpdf-${QPDF_VERSION}-msvc64.zip`;
const ARCHIVE_URL = `https://github.com/qpdf/qpdf/releases/download/${QPDF_TAG}/${ARCHIVE_FILENAME}`;
const EXPECTED_ARCHIVE_BYTES = 28183147;
const EXPECTED_ARCHIVE_SHA256 =
  "db87077e683630c1217e0e8f9a20a9749d952ab676e881c3689187763a5de25d";

const ARCHIVE_PREFIX = `qpdf-${QPDF_VERSION}-msvc64/`;

const RUNTIME_FILES = [
  {
    archivePath: `${ARCHIVE_PREFIX}bin/qpdf30.dll`,
    destName: "qpdf30.dll",
    bytes: 7448064,
    sha256: "8812952678de93e0750308a113aa650e9161af466f9770679ea9673adeb61041",
  },
  {
    archivePath: `${ARCHIVE_PREFIX}bin/msvcp140.dll`,
    destName: "msvcp140.dll",
    bytes: 643512,
    sha256: "7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca",
  },
  {
    archivePath: `${ARCHIVE_PREFIX}bin/vcruntime140.dll`,
    destName: "vcruntime140.dll",
    bytes: 178616,
    sha256: "d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7",
  },
  {
    archivePath: `${ARCHIVE_PREFIX}bin/vcruntime140_1.dll`,
    destName: "vcruntime140_1.dll",
    bytes: 50112,
    sha256: "a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e",
  },
];

const NOTICE_FILENAME = "LICENSE-qpdf.txt";
const destDir = path.join(repoRoot, "src-tauri", "resources", "qpdf");
const noticePath = path.join(destDir, NOTICE_FILENAME);

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return { bytes: buf.length, hash: sha256Buffer(buf) };
}

/**
 * Minimal ZIP reader supporting Store (0) and Deflate (8) entries via the Central Directory.
 */
function extractZipEntries(zipBuf, wantedPaths) {
  const wanted = new Set(wantedPaths);
  const found = new Map();

  // Locate End of Central Directory (EOCD) signature 0x06054b50 from the tail
  const minOffset = Math.max(0, zipBuf.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= minOffset; i -= 1) {
    if (
      zipBuf[i] === 0x50 &&
      zipBuf[i + 1] === 0x4b &&
      zipBuf[i + 2] === 0x05 &&
      zipBuf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP archive: EOCD signature not found");
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuf.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > zipBuf.length) {
    throw new Error("Invalid ZIP archive: central directory out of bounds");
  }

  let pos = cdOffset;
  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (pos + 46 > zipBuf.length || zipBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at offset ${pos}`);
    }
    const method = zipBuf.readUInt16LE(pos + 10);
    const compressedSize = zipBuf.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuf.readUInt32LE(pos + 24);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);
    const entryName = zipBuf
      .subarray(pos + 46, pos + 46 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");
    pos += 46 + nameLen + extraLen + commentLen;

    if (!wanted.has(entryName)) {
      continue;
    }

    if (
      localHeaderOffset + 30 > zipBuf.length ||
      zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`Invalid local file header for ${entryName}`);
    }
    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuf.length) {
      throw new Error(`Truncated ZIP entry payload for ${entryName}`);
    }
    const compressed = zipBuf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${entryName}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(
        `Decompressed size mismatch for ${entryName}: expected ${uncompressedSize}, got ${data.length}`,
      );
    }
    found.set(entryName, data);
  }

  return found;
}

function buildNoticeText(upstreamLicenseRst) {
  const fileRows = RUNTIME_FILES.map(
    (f) => `  - ${f.destName} (${f.bytes} bytes, SHA-256 ${f.sha256})`,
  ).join("\n");

  return [
    "WinKit Bundled QPDF Runtime & Third-Party License Notices",
    "=========================================================",
    `Upstream project      : qpdf/qpdf (${QPDF_TAG})`,
    `Version               : ${QPDF_VERSION}`,
    `Release URL           : https://github.com/qpdf/qpdf/releases/tag/${QPDF_TAG}`,
    `Archive               : ${ARCHIVE_FILENAME} (${EXPECTED_ARCHIVE_BYTES} bytes, SHA-256 ${EXPECTED_ARCHIVE_SHA256})`,
    "Bundled runtime DLLs  :",
    fileRows,
    "",
    "Copyright (c) 2005-2021 Jay Berkenbilt",
    "Copyright (c) 2022-2026 Jay Berkenbilt and Manfred Holger",
    "",
    "qpdf is licensed under the Apache License, Version 2.0 (the \"License\");",
    "you may not use this file except in compliance with the License.",
    "You may obtain a copy of the License at:",
    "",
    "    https://www.apache.org/licenses/LICENSE-2.0",
    "",
    "Unless required by applicable law or agreed to in writing, software",
    "distributed under the License is distributed on an \"AS IS\" BASIS,",
    "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
    "See the License for the specific language governing permissions and",
    "limitations under the License.",
    "",
    "Crypto & Runtime Notes:",
    "- qpdf30.dll from the official qpdf Windows x64 MSVC distribution statically",
    "  links OpenSSL 3.x (Apache-2.0), zlib (Zlib license), and libjpeg-turbo (IJG/BSD-3-Clause).",
    "- msvcp140.dll, vcruntime140.dll, and vcruntime140_1.dll are app-local Microsoft",
    "  Visual C++ redistributable runtime DLLs included verbatim from the official",
    "  qpdf-12.4.2-msvc64.zip bin/ directory so qpdf30.dll loads cleanly on fresh Windows 11",
    "  systems without requiring an external VC++ Redistributable installation.",
    "",
    "----- BEGIN UPSTREAM license.rst.txt -----",
    upstreamLicenseRst.replace(/\r\n/g, "\n").trim(),
    "----- END UPSTREAM license.rst.txt -----",
    "",
  ].join("\n");
}

function writeAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, targetPath);
}

function allCachedFilesValid() {
  if (!fs.existsSync(noticePath) || fs.statSync(noticePath).size < 1024) {
    return false;
  }
  for (const file of RUNTIME_FILES) {
    const p = path.join(destDir, file.destName);
    if (!fs.existsSync(p)) {
      return false;
    }
    const existing = sha256File(p);
    if (existing.bytes !== file.bytes || existing.hash !== file.sha256) {
      console.warn(
        `[ensure-qpdf] Cached ${file.destName} mismatch (${existing.bytes} B, ${existing.hash}), re-fetching...`,
      );
      return false;
    }
  }
  return true;
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });

  if (allCachedFilesValid()) {
    const totalBytes = RUNTIME_FILES.reduce((acc, f) => acc + f.bytes, 0);
    console.log(
      `[ensure-qpdf] Verified cached qpdf ${QPDF_VERSION} runtime (${RUNTIME_FILES.length} DLLs, ${totalBytes} B) and ${NOTICE_FILENAME}`,
    );
    return;
  }

  console.log(`[ensure-qpdf] Downloading ${ARCHIVE_FILENAME} (qpdf ${QPDF_VERSION})...`);
  const resp = await fetch(ARCHIVE_URL, {
    redirect: "follow",
    headers: { "User-Agent": "WinKit-Build/0.18.0" },
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

  const licenseEntryPath = `${ARCHIVE_PREFIX}share/doc/qpdf/manual-html/_sources/license.rst.txt`;
  const wanted = [...RUNTIME_FILES.map((f) => f.archivePath), licenseEntryPath];
  const entries = extractZipEntries(archiveData, wanted);

  for (const file of RUNTIME_FILES) {
    const buf = entries.get(file.archivePath);
    if (!buf) {
      throw new Error(`Missing expected entry ${file.archivePath} inside ${ARCHIVE_FILENAME}`);
    }
    const hash = sha256Buffer(buf);
    if (buf.length !== file.bytes || hash !== file.sha256) {
      throw new Error(
        `DLL checksum mismatch for ${file.destName}: expected ${file.bytes} B / ${file.sha256}, got ${buf.length} B / ${hash}`,
      );
    }
    writeAtomic(path.join(destDir, file.destName), buf);
  }

  const licenseBuf = entries.get(licenseEntryPath);
  if (!licenseBuf) {
    throw new Error(`Missing upstream license text ${licenseEntryPath}`);
  }
  const noticeText = buildNoticeText(licenseBuf.toString("utf8"));
  writeAtomic(noticePath, Buffer.from(noticeText, "utf8"));

  const totalBytes = RUNTIME_FILES.reduce((acc, f) => acc + f.bytes, 0);
  console.log(
    `[ensure-qpdf] Saved verified qpdf ${QPDF_VERSION} runtime (${RUNTIME_FILES.length} DLLs, ${totalBytes} B) and ${NOTICE_FILENAME}`,
  );
}

main().catch((err) => {
  console.error(`[ensure-qpdf] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
