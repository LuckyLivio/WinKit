import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const ORT_VERSION = "1.23.2";
const ORT_WHEEL_FILENAME = `onnxruntime-${ORT_VERSION}-cp312-cp312-win_amd64.whl`;
const ORT_WHEEL_URL =
  "https://files.pythonhosted.org/packages/c0/b4/569d298f9fc4d286c11c45e85d9ffa9e877af12ace98af8cab52396e8f46/onnxruntime-1.23.2-cp312-cp312-win_amd64.whl";
const EXPECTED_ORT_WHEEL_BYTES = 13470528;
const EXPECTED_ORT_WHEEL_SHA256 =
  "25de5214923ce941a3523739d34a520aac30f21e631de53bba9174dc9c004435";

const ORT_DLL = {
  archivePath: "onnxruntime/capi/onnxruntime.dll",
  destName: "onnxruntime.dll",
  bytes: 15709728,
  sha256: "462ea8e85b881b26388c595f96b1b9b39e57565aa4725fe29136695c1ead179f",
};

const MODEL_FILES = [
  {
    destName: "ch_PP-OCRv4_det_mobile.onnx",
    bytes: 4745517,
    sha256: "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
    urls: [
      "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx",
      "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx",
    ],
  },
  {
    destName: "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    bytes: 581639,
    sha256: "70581b300b83babd9e0dd1d7d74c5b006869e8796da277a70c2e405bf9d77c82",
    urls: [
      "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/ch_ppocr_mobile_v2.0_cls_train.onnx",
    ],
  },
  {
    destName: "ch_PP-OCRv4_rec_mobile.onnx",
    bytes: 10857958,
    sha256: "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b",
    urls: [
      "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx",
      "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx",
    ],
  },
];

const NOTICE_FILENAME = "LICENSE-ocr.txt";
const destDir = path.join(repoRoot, "src-tauri", "resources", "ocr");
const noticePath = path.join(destDir, NOTICE_FILENAME);

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return { bytes: buf.length, hash: sha256Buffer(buf) };
}

function writeAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Minimal ZIP reader supporting Store (0) and Deflate (8) entries via Central Directory.
 */
function extractZipEntries(zipBuf, wantedPaths) {
  const wanted = new Set(wantedPaths);
  const found = new Map();

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

async function fetchWithMirrors(urls, label) {
  let lastError = null;
  for (const url of urls) {
    try {
      console.log(`[ensure-ocr-runtime] Downloading ${label} from ${url}...`);
      const resp = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "WinKit-Build/0.19.0" },
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      lastError = err;
      console.warn(
        `[ensure-ocr-runtime] Mirror failed for ${label} (${url}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(
    `All mirrors failed for ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function buildNoticeText(ortLicenseText) {
  const modelRows = MODEL_FILES.map(
    (m) => `  - ${m.destName} (${m.bytes} bytes, SHA-256 ${m.sha256})`,
  ).join("\n");

  return [
    "WinKit Bundled Offline OCR Runtime & Model License Notices",
    "==========================================================",
    "",
    "1. Microsoft ONNX Runtime (CPU, Windows x64)",
    "--------------------------------------------",
    `Version   : ${ORT_VERSION}`,
    `Package   : ${ORT_WHEEL_FILENAME} (${EXPECTED_ORT_WHEEL_BYTES} bytes, SHA-256 ${EXPECTED_ORT_WHEEL_SHA256})`,
    `Binary    : ${ORT_DLL.destName} (${ORT_DLL.bytes} bytes, SHA-256 ${ORT_DLL.sha256})`,
    "License   : MIT License",
    "",
    ortLicenseText.replace(/\r\n/g, "\n").trim(),
    "",
    "2. RapidOCR / PaddleOCR PP-OCRv4 Mobile ONNX Models",
    "---------------------------------------------------",
    "Upstream Projects : RapidAI/RapidOCR & PaddlePaddle/PaddleOCR",
    "Model Sources     : https://huggingface.co/SWHL/RapidOCR & https://www.modelscope.cn/models/RapidAI/RapidOCR",
    "License           : Apache License, Version 2.0",
    "Bundled Models    :",
    modelRows,
    "",
    "Licensed under the Apache License, Version 2.0 (the \"License\");",
    "you may not use these files except in compliance with the License.",
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
  ].join("\n");
}

function isFileVerified(filePath, expectedBytes, expectedSha) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const actual = sha256File(filePath);
  if (actual.bytes !== expectedBytes || actual.hash !== expectedSha) {
    console.warn(
      `[ensure-ocr-runtime] Cached ${path.basename(filePath)} mismatch (${actual.bytes} B, ${actual.hash}), re-fetching...`,
    );
    return false;
  }
  return true;
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });

  const ortPath = path.join(destDir, ORT_DLL.destName);
  const ortValid = isFileVerified(ortPath, ORT_DLL.bytes, ORT_DLL.sha256);
  const noticeValid = fs.existsSync(noticePath) && fs.statSync(noticePath).size >= 1024;
  const modelsValid = MODEL_FILES.every((m) =>
    isFileVerified(path.join(destDir, m.destName), m.bytes, m.sha256),
  );

  if (ortValid && noticeValid && modelsValid) {
    const totalBytes =
      ORT_DLL.bytes + MODEL_FILES.reduce((acc, item) => acc + item.bytes, 0);
    console.log(
      `[ensure-ocr-runtime] Verified cached ONNX Runtime ${ORT_VERSION} + RapidOCR PP-OCRv4 mobile (${totalBytes} B) and ${NOTICE_FILENAME}`,
    );
    return;
  }

  let ortLicenseText = "";
  if (!ortValid || !noticeValid) {
    const whlBuf = await fetchWithMirrors([ORT_WHEEL_URL], ORT_WHEEL_FILENAME);
    const whlHash = sha256Buffer(whlBuf);
    if (whlBuf.length !== EXPECTED_ORT_WHEEL_BYTES || whlHash !== EXPECTED_ORT_WHEEL_SHA256) {
      throw new Error(
        `Wheel checksum mismatch for ${ORT_WHEEL_FILENAME}: expected ${EXPECTED_ORT_WHEEL_BYTES} B / ${EXPECTED_ORT_WHEEL_SHA256}, got ${whlBuf.length} B / ${whlHash}`,
      );
    }
    const entries = extractZipEntries(whlBuf, [ORT_DLL.archivePath, "onnxruntime/LICENSE"]);
    const dllBuf = entries.get(ORT_DLL.archivePath);
    if (!dllBuf) {
      throw new Error(`Missing ${ORT_DLL.archivePath} inside ${ORT_WHEEL_FILENAME}`);
    }
    const dllHash = sha256Buffer(dllBuf);
    if (dllBuf.length !== ORT_DLL.bytes || dllHash !== ORT_DLL.sha256) {
      throw new Error(
        `DLL checksum mismatch for ${ORT_DLL.destName}: expected ${ORT_DLL.bytes} B / ${ORT_DLL.sha256}, got ${dllBuf.length} B / ${dllHash}`,
      );
    }
    writeAtomic(ortPath, dllBuf);

    const licenseBuf = entries.get("onnxruntime/LICENSE");
    if (!licenseBuf) {
      throw new Error(`Missing onnxruntime/LICENSE inside ${ORT_WHEEL_FILENAME}`);
    }
    ortLicenseText = licenseBuf.toString("utf8");
  }

  for (const model of MODEL_FILES) {
    const target = path.join(destDir, model.destName);
    if (isFileVerified(target, model.bytes, model.sha256)) {
      continue;
    }
    const buf = await fetchWithMirrors(model.urls, model.destName);
    const hash = sha256Buffer(buf);
    if (buf.length !== model.bytes || hash !== model.sha256) {
      throw new Error(
        `Model checksum mismatch for ${model.destName}: expected ${model.bytes} B / ${model.sha256}, got ${buf.length} B / ${hash}`,
      );
    }
    writeAtomic(target, buf);
  }

  if (!noticeValid || ortLicenseText) {
    const text = buildNoticeText(
      ortLicenseText ||
        "MIT License - Copyright (c) Microsoft Corporation. See https://github.com/microsoft/onnxruntime/blob/main/LICENSE",
    );
    writeAtomic(noticePath, Buffer.from(text, "utf8"));
  }

  const totalBytes =
    ORT_DLL.bytes + MODEL_FILES.reduce((acc, item) => acc + item.bytes, 0);
  console.log(
    `[ensure-ocr-runtime] Saved verified ONNX Runtime ${ORT_VERSION} + RapidOCR PP-OCRv4 mobile (${totalBytes} B) and ${NOTICE_FILENAME}`,
  );
}

main().catch((err) => {
  console.error(
    `[ensure-ocr-runtime] ERROR: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
