import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const MODEL_FILENAME = "face_detection_yunet_2023mar.onnx";
const MODEL_COMMIT = "f12e12798e8314f7c074a6656816c048dcc95b7a";
const MODEL_URL = `https://media.githubusercontent.com/media/opencv/opencv_zoo/${MODEL_COMMIT}/models/face_detection_yunet/${MODEL_FILENAME}`;
const EXPECTED_BYTES = 232589;
const EXPECTED_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";

const destDir = path.join(repoRoot, "src-tauri", "resources", "models");
const destPath = path.join(destDir, MODEL_FILENAME);

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  return { bytes: buf.length, hash };
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });

  if (fs.existsSync(destPath)) {
    const existing = sha256File(destPath);
    if (existing.bytes === EXPECTED_BYTES && existing.hash === EXPECTED_SHA256) {
      console.log(`[ensure-face-model] Verified cached ${MODEL_FILENAME} (${existing.bytes} B)`);
      return;
    }
    console.warn(
      `[ensure-face-model] Existing ${MODEL_FILENAME} mismatch (${existing.bytes} B, ${existing.hash}), re-fetching...`,
    );
  }

  console.log(`[ensure-face-model] Downloading ${MODEL_FILENAME} from pinned opencv_zoo commit...`);
  const resp = await fetch(MODEL_URL, {
    redirect: "follow",
    headers: { "User-Agent": "WinKit-Build/0.12.0" },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${MODEL_URL}: HTTP ${resp.status} ${resp.statusText}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  const data = Buffer.from(arrayBuf);
  const actualHash = crypto.createHash("sha256").update(data).digest("hex");

  if (data.length !== EXPECTED_BYTES || actualHash !== EXPECTED_SHA256) {
    throw new Error(
      `Checksum mismatch for ${MODEL_FILENAME}: expected ${EXPECTED_BYTES} B / ${EXPECTED_SHA256}, got ${data.length} B / ${actualHash}`,
    );
  }

  const tmpPath = `${destPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, destPath);
  console.log(`[ensure-face-model] Saved verified ${MODEL_FILENAME} (${data.length} B, sha256=${actualHash})`);
}

main().catch((err) => {
  console.error(`[ensure-face-model] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
