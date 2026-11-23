import type { Locale } from "../../i18n/messages";
import type { AudioExtractFormat } from "../../lib/tauriBridge";

export interface UiAudioPlan {
  willStreamCopy: boolean;
  label: string;
  detail: string;
}

export function planAudioExtractionUi(
  sourceCodec: string | null | undefined,
  format: AudioExtractFormat,
  preferStreamCopy: boolean,
  bitrateKbps: number | null,
  locale: Locale,
): UiAudioPlan {
  const isZh = locale === "zh-CN";
  const norm = sourceCodec?.trim().toLowerCase() ?? "";

  const compatible =
    (format === "m4a" && (norm === "aac" || norm === "alac")) ||
    (format === "mp3" && norm === "mp3") ||
    (format === "flac" && norm === "flac") ||
    (format === "wav" &&
      ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"].includes(norm));

  const bitrateForcesTranscode = (format === "m4a" || format === "mp3") && bitrateKbps != null;

  if (preferStreamCopy && compatible && !bitrateForcesTranscode) {
    return {
      willStreamCopy: true,
      label: isZh ? "原样无损提取（流复制）" : "Lossless Stream Copy",
      detail: isZh
        ? `源编码 ${norm.toUpperCase()} 与目标 ${format.toUpperCase()} 兼容，将直接提取原始音频流，不重新编码。`
        : `Source ${norm.toUpperCase()} is compatible with ${format.toUpperCase()}; audio stream will be copied losslessly without re-encoding.`,
    };
  }

  const targetDesc =
    format === "m4a"
      ? `AAC ${bitrateKbps ?? 192} kbps`
      : format === "mp3"
        ? `MP3 ${bitrateKbps ?? 192} kbps`
        : format === "wav"
          ? "PCM 16-bit WAV"
          : "FLAC";

  return {
    willStreamCopy: false,
    label: isZh ? `将执行音频转码 → ${targetDesc}` : `Will Transcode → ${targetDesc}`,
    detail: isZh
      ? bitrateForcesTranscode
        ? `已指定目标码率 ${bitrateKbps} kbps，将从 ${norm ? norm.toUpperCase() : "源音轨"} 转码为 ${targetDesc}。`
        : `源编码 ${norm ? norm.toUpperCase() : "未知"} 需转码后封装为 ${format.toUpperCase()}（${targetDesc}）。`
      : bitrateForcesTranscode
        ? `Custom bitrate (${bitrateKbps} kbps) selected; will transcode to ${targetDesc}.`
        : `Source ${norm ? norm.toUpperCase() : "audio"} will be transcoded to ${targetDesc}.`,
  };
}
