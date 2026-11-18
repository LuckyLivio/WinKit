use crate::error::AppError;
use crate::fs_guard::{
    validate_existing_input_file, validate_user_path, write_output_bytes_cancellable, SavedFileInfo,
};
use base64::alphabet::{STANDARD as B64_STD_ALPHA, URL_SAFE as B64_URL_ALPHA};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_CODEC_TEXT_BYTES: usize = 2 * 1024 * 1024; // 2 MiB interactive UTF-8 text limit
pub const MAX_CODEC_FILE_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB raw file limit (2 MiB for binary bit encode)
pub const MAX_CODEC_BINARY_ENCODE_BYTES: usize = 2 * 1024 * 1024; // 2 MiB * 9 = 18 MiB bit output
pub const MAX_CODEC_OUTPUT_BYTES: usize = 20 * 1024 * 1024; // 20 MiB hard output ceiling
pub const PREVIEW_CHAR_LIMIT: usize = 65_536; // 64 Ki chars UI preview threshold
const HEX_PREVIEW_BYTE_LIMIT: usize = 256;

const ENGINE_STD_PAD: GeneralPurpose = GeneralPurpose::new(
    &B64_STD_ALPHA,
    GeneralPurposeConfig::new()
        .with_encode_padding(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

const ENGINE_STD_INDIFFERENT: GeneralPurpose = GeneralPurpose::new(
    &B64_STD_ALPHA,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

const ENGINE_URL_PAD: GeneralPurpose = GeneralPurpose::new(
    &B64_URL_ALPHA,
    GeneralPurposeConfig::new()
        .with_encode_padding(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

const ENGINE_URL_INDIFFERENT: GeneralPurpose = GeneralPurpose::new(
    &B64_URL_ALPHA,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodecFormat {
    Base64Standard,
    Base64Url,
    Hex,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodecOperation {
    Encode,
    Decode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Base64WrapWidth {
    None,
    Cols64,
    Cols76,
}

impl Base64WrapWidth {
    fn cols(self) -> Option<usize> {
        match self {
            Base64WrapWidth::None => None,
            Base64WrapWidth::Cols64 => Some(64),
            Base64WrapWidth::Cols76 => Some(76),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecOptions {
    pub format: CodecFormat,
    pub operation: CodecOperation,
    pub padding: bool,
    pub wrap: Base64WrapWidth,
    pub ignore_whitespace: bool,
    pub uppercase_hex: bool,
    pub group_bits: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecTransformResponse {
    pub input_byte_length: usize,
    pub output_byte_length: usize,
    pub is_valid_utf8: bool,
    pub preview_text: String,
    pub total_chars: usize,
    pub truncated: bool,
    pub hex_preview: Option<String>,
    pub file_name: Option<String>,
}

fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), AppError> {
    if cancel_flag.is_some_and(|f| f.load(Ordering::Relaxed)) {
        Err(AppError::cancelled())
    } else {
        Ok(())
    }
}

fn estimate_encoded_len(input_len: usize, opts: &CodecOptions) -> Result<usize, AppError> {
    let raw_len = match opts.format {
        CodecFormat::Base64Standard | CodecFormat::Base64Url => {
            if opts.padding {
                input_len.div_ceil(3).saturating_mul(4)
            } else {
                let full = (input_len / 3).saturating_mul(4);
                let rem = match input_len % 3 {
                    0 => 0,
                    1 => 2,
                    _ => 3,
                };
                full.saturating_add(rem)
            }
        }
        CodecFormat::Hex => input_len.saturating_mul(2),
        CodecFormat::Binary => {
            if input_len > MAX_CODEC_BINARY_ENCODE_BYTES {
                return Err(AppError::size_limit(format!(
                    "Binary bit encoding is capped at 2 MiB input ({:.2} MiB provided).",
                    input_len as f64 / (1024.0 * 1024.0)
                )));
            }
            if opts.group_bits && input_len > 1 {
                input_len.saturating_mul(9).saturating_sub(1)
            } else {
                input_len.saturating_mul(8)
            }
        }
    };

    let with_wrap = match (opts.format, opts.wrap.cols()) {
        (CodecFormat::Base64Standard | CodecFormat::Base64Url, Some(cols)) if raw_len > cols => {
            raw_len.saturating_add((raw_len - 1) / cols)
        }
        _ => raw_len,
    };

    if with_wrap > MAX_CODEC_OUTPUT_BYTES {
        return Err(AppError::size_limit(format!(
            "Estimated encoded output ({:.2} MiB) exceeds 20 MiB limit.",
            with_wrap as f64 / (1024.0 * 1024.0)
        )));
    }
    Ok(with_wrap)
}

pub fn encode_bytes_to_string(
    input: &[u8],
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<String, AppError> {
    check_cancelled(cancel_flag)?;
    let estimated = estimate_encoded_len(input.len(), opts)?;

    match opts.format {
        CodecFormat::Base64Standard | CodecFormat::Base64Url => {
            let raw = match (opts.format, opts.padding) {
                (CodecFormat::Base64Standard, true) => ENGINE_STD_PAD.encode(input),
                (CodecFormat::Base64Standard, false) => ENGINE_STD_INDIFFERENT.encode(input),
                (CodecFormat::Base64Url, true) => ENGINE_URL_PAD.encode(input),
                (CodecFormat::Base64Url, false) => ENGINE_URL_INDIFFERENT.encode(input),
                _ => unreachable!(),
            };
            check_cancelled(cancel_flag)?;
            if let Some(cols) = opts.wrap.cols() {
                if raw.len() > cols {
                    let mut wrapped = String::with_capacity(estimated);
                    for (idx, chunk) in raw.as_bytes().chunks(cols).enumerate() {
                        if idx > 0 {
                            wrapped.push('\n');
                        }
                        // Base64 output is strictly ASCII
                        wrapped.push_str(
                            std::str::from_utf8(chunk).expect("base64 chunk is valid ASCII"),
                        );
                    }
                    return Ok(wrapped);
                }
            }
            Ok(raw)
        }
        CodecFormat::Hex => {
            let table: &[u8; 16] = if opts.uppercase_hex {
                b"0123456789ABCDEF"
            } else {
                b"0123456789abcdef"
            };
            let mut out = String::with_capacity(estimated);
            for (i, &b) in input.iter().enumerate() {
                if (i & 0xFFFF) == 0 {
                    check_cancelled(cancel_flag)?;
                }
                out.push(table[(b >> 4) as usize] as char);
                out.push(table[(b & 0x0f) as usize] as char);
            }
            Ok(out)
        }
        CodecFormat::Binary => {
            let mut out = String::with_capacity(estimated);
            for (i, &b) in input.iter().enumerate() {
                if (i & 0x3FFF) == 0 {
                    check_cancelled(cancel_flag)?;
                }
                if opts.group_bits && i > 0 {
                    out.push(' ');
                }
                for shift in (0..8).rev() {
                    out.push(if ((b >> shift) & 1) == 1 { '1' } else { '0' });
                }
            }
            Ok(out)
        }
    }
}

fn format_char_display(ch: char) -> String {
    if ch.is_control() {
        format!("U+{:04X}", ch as u32)
    } else {
        format!("'{ch}'")
    }
}

fn decode_base64_checked(
    text: &str,
    url_safe: bool,
    require_padding: bool,
    ignore_whitespace: bool,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<u8>, AppError> {
    let mut cleaned = Vec::with_capacity(text.len());
    let mut line = 1usize;
    let mut col = 1usize;
    let mut pad_count = 0usize;
    let mut first_pad_offset = 0usize;

    for (idx, ch) in text.chars().enumerate() {
        if (idx & 0xFFFF) == 0 {
            check_cancelled(cancel_flag)?;
        }
        let offset = idx + 1; // 1-based character offset
        if ch == '\n' {
            if !ignore_whitespace {
                return Err(AppError::decode_failed(format!(
                    "Unexpected newline at offset {offset} (line {line}, col {col}); enable 'Ignore whitespace' to allow line breaks."
                )));
            }
            line += 1;
            col = 1;
            continue;
        }
        if ch.is_ascii_whitespace() {
            if !ignore_whitespace {
                return Err(AppError::decode_failed(format!(
                    "Unexpected whitespace ({}) at offset {offset} (line {line}, col {col}).",
                    format_char_display(ch)
                )));
            }
            col += 1;
            continue;
        }

        if ch == '=' {
            if pad_count == 0 {
                first_pad_offset = offset;
            }
            pad_count += 1;
            if pad_count > 2 {
                return Err(AppError::decode_failed(format!(
                    "Invalid Base64 padding: more than two '=' characters at offset {offset} (line {line}, col {col})."
                )));
            }
            cleaned.push(b'=');
            col += 1;
            continue;
        }

        if pad_count > 0 {
            return Err(AppError::decode_failed(format!(
                "Invalid Base64 padding: unexpected data character {} at offset {offset} (line {line}, col {col}) after '=' at offset {first_pad_offset}.",
                format_char_display(ch)
            )));
        }

        let is_valid_alpha = if url_safe {
            ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
        } else {
            ch.is_ascii_alphanumeric() || ch == '+' || ch == '/'
        };

        if !is_valid_alpha {
            let hint = if !url_safe && (ch == '-' || ch == '_') {
                " (looks like URL-Safe Base64; switch format to URL-Safe Base64)"
            } else if url_safe && (ch == '+' || ch == '/') {
                " (looks like Standard Base64; switch format to Standard Base64)"
            } else {
                ""
            };
            return Err(AppError::decode_failed(format!(
                "Invalid Base64 character {} at offset {offset} (line {line}, col {col}){hint}.",
                format_char_display(ch)
            )));
        }

        cleaned.push(ch as u8);
        col += 1;
    }

    if cleaned.is_empty() {
        return Ok(Vec::new());
    }

    if pad_count > 0 && cleaned.len() % 4 != 0 {
        return Err(AppError::decode_failed(format!(
            "Malformed Base64 padding: total encoded length ({}) is not a multiple of 4.",
            cleaned.len()
        )));
    }

    if require_padding && cleaned.len() % 4 != 0 {
        return Err(AppError::decode_failed(format!(
            "Missing '=' padding: Standard padded Base64 length ({}) must be a multiple of 4 (or disable strict padding).",
            cleaned.len()
        )));
    }

    let data_len = cleaned.len() - pad_count;
    if data_len % 4 == 1 {
        return Err(AppError::decode_failed(format!(
            "Invalid Base64 quantum length ({} data chars, mod 4 = 1 cannot form whole bytes).",
            data_len
        )));
    }

    // Use canonical decoding when padded (catches non-zero pad bits per RFC 4648 §3.5);
    // strip '=' and validate canonical unpadded tail when unpadded.
    let decoded = if pad_count > 0 {
        if url_safe {
            ENGINE_URL_PAD.decode(&cleaned)
        } else {
            ENGINE_STD_PAD.decode(&cleaned)
        }
    } else {
        // Re-pad canonically or check trailing bits so non-canonical pad bits are still rejected!
        let mut padded = cleaned;
        while padded.len() % 4 != 0 {
            padded.push(b'=');
        }
        if url_safe {
            ENGINE_URL_PAD.decode(&padded)
        } else {
            ENGINE_STD_PAD.decode(&padded)
        }
    }
    .map_err(|e| AppError::decode_failed(format!("Invalid Base64 stream (RFC 4648): {e}")))?;

    if decoded.len() > MAX_CODEC_OUTPUT_BYTES {
        return Err(AppError::size_limit("Decoded output exceeds 20 MiB limit."));
    }
    Ok(decoded)
}

fn decode_hex_checked(
    text: &str,
    ignore_whitespace: bool,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<u8>, AppError> {
    let mut nibbles = Vec::with_capacity(text.len());
    let mut line = 1usize;
    let mut col = 1usize;

    for (idx, ch) in text.chars().enumerate() {
        if (idx & 0xFFFF) == 0 {
            check_cancelled(cancel_flag)?;
        }
        let offset = idx + 1;
        if ch == '\n' {
            if !ignore_whitespace {
                return Err(AppError::decode_failed(format!(
                    "Unexpected newline in Hex input at offset {offset} (line {line}, col {col})."
                )));
            }
            line += 1;
            col = 1;
            continue;
        }
        if ch.is_ascii_whitespace() {
            if !ignore_whitespace {
                return Err(AppError::decode_failed(format!(
                    "Unexpected whitespace ({}) in Hex input at offset {offset} (line {line}, col {col}).",
                    format_char_display(ch)
                )));
            }
            col += 1;
            continue;
        }

        let Some(digit) = ch.to_digit(16) else {
            return Err(AppError::decode_failed(format!(
                "Invalid hexadecimal character {} at offset {offset} (line {line}, col {col}); expected 0–9 or a–f.",
                format_char_display(ch)
            )));
        };
        nibbles.push(digit as u8);
        col += 1;
    }

    if nibbles.len() % 2 != 0 {
        return Err(AppError::decode_failed(format!(
            "Odd hexadecimal length ({} hex digits); each byte requires an even pair of hex digits.",
            nibbles.len()
        )));
    }

    let mut out = Vec::with_capacity(nibbles.len() / 2);
    for pair in nibbles.chunks_exact(2) {
        out.push((pair[0] << 4) | pair[1]);
    }
    Ok(out)
}

fn decode_binary_checked(
    text: &str,
    ignore_whitespace: bool,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<u8>, AppError> {
    let mut bits = Vec::with_capacity(text.len());
    let mut line = 1usize;
    let mut col = 1usize;

    for (idx, ch) in text.chars().enumerate() {
        if (idx & 0xFFFF) == 0 {
            check_cancelled(cancel_flag)?;
        }
        let offset = idx + 1;
        if ch == '\n' {
            if !ignore_whitespace {
                return Err(AppError::decode_failed(format!(
                    "Unexpected newline in Binary input at offset {offset} (line {line}, col {col})."
                )));
            }
            line += 1;
            col = 1;
            continue;
        }
        if ch.is_ascii_whitespace() {
            if !ignore_whitespace {
                return Err(AppError::decode_failed(format!(
                    "Unexpected whitespace ({}) in Binary input at offset {offset} (line {line}, col {col}).",
                    format_char_display(ch)
                )));
            }
            col += 1;
            continue;
        }

        match ch {
            '0' => bits.push(0u8),
            '1' => bits.push(1u8),
            _ => {
                return Err(AppError::decode_failed(format!(
                    "Invalid binary bit {} at offset {offset} (line {line}, col {col}); expected '0' or '1'.",
                    format_char_display(ch)
                )));
            }
        }
        col += 1;
    }

    if bits.len() % 8 != 0 {
        return Err(AppError::decode_failed(format!(
            "Incomplete binary byte: got {} bits (must be a multiple of 8 bits per byte).",
            bits.len()
        )));
    }

    let mut out = Vec::with_capacity(bits.len() / 8);
    for group in bits.chunks_exact(8) {
        let mut byte = 0u8;
        for &b in group {
            byte = (byte << 1) | b;
        }
        out.push(byte);
    }
    Ok(out)
}

pub fn decode_string_to_bytes(
    text: &str,
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<u8>, AppError> {
    check_cancelled(cancel_flag)?;
    match opts.format {
        CodecFormat::Base64Standard => decode_base64_checked(
            text,
            false,
            opts.padding,
            opts.ignore_whitespace,
            cancel_flag,
        ),
        CodecFormat::Base64Url => decode_base64_checked(
            text,
            true,
            opts.padding,
            opts.ignore_whitespace,
            cancel_flag,
        ),
        CodecFormat::Hex => decode_hex_checked(text, opts.ignore_whitespace, cancel_flag),
        CodecFormat::Binary => decode_binary_checked(text, opts.ignore_whitespace, cancel_flag),
    }
}

fn format_hex_dump_preview(bytes: &[u8]) -> String {
    let slice = &bytes[..bytes.len().min(HEX_PREVIEW_BYTE_LIMIT)];
    let mut out = String::new();
    for (row_idx, row) in slice.chunks(16).enumerate() {
        if row_idx > 0 {
            out.push('\n');
        }
        out.push_str(&format!("{:04x}: ", row_idx * 16));
        for (i, b) in row.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            out.push_str(&format!("{b:02x}"));
        }
    }
    if bytes.len() > HEX_PREVIEW_BYTE_LIMIT {
        out.push_str(&format!(
            "\n… (+{} more bytes)",
            bytes.len() - HEX_PREVIEW_BYTE_LIMIT
        ));
    }
    out
}

fn truncate_preview(s: &str) -> (String, usize, bool) {
    let mut total_chars = 0usize;
    let mut cut_byte_idx = s.len();
    for (char_idx, (byte_idx, _)) in s.char_indices().enumerate() {
        total_chars = char_idx + 1;
        if char_idx == PREVIEW_CHAR_LIMIT {
            cut_byte_idx = byte_idx;
        }
    }
    if total_chars > PREVIEW_CHAR_LIMIT {
        (s[..cut_byte_idx].to_string(), total_chars, true)
    } else {
        (s.to_string(), total_chars, false)
    }
}

fn build_response_from_bytes(
    input_len: usize,
    output_bytes: &[u8],
    force_utf8_encoded: Option<String>,
    file_name: Option<String>,
) -> CodecTransformResponse {
    if let Some(encoded_str) = force_utf8_encoded {
        let out_bytes = encoded_str.len();
        let (preview_text, total_chars, truncated) = truncate_preview(&encoded_str);
        return CodecTransformResponse {
            input_byte_length: input_len,
            output_byte_length: out_bytes,
            is_valid_utf8: true,
            preview_text,
            total_chars,
            truncated,
            hex_preview: None,
            file_name,
        };
    }

    match std::str::from_utf8(output_bytes) {
        Ok(valid_str) => {
            let (preview_text, total_chars, truncated) = truncate_preview(valid_str);
            CodecTransformResponse {
                input_byte_length: input_len,
                output_byte_length: output_bytes.len(),
                is_valid_utf8: true,
                preview_text,
                total_chars,
                truncated,
                hex_preview: None,
                file_name,
            }
        }
        Err(_) => CodecTransformResponse {
            input_byte_length: input_len,
            output_byte_length: output_bytes.len(),
            is_valid_utf8: false,
            preview_text: String::new(),
            total_chars: 0,
            truncated: false,
            hex_preview: Some(format_hex_dump_preview(output_bytes)),
            file_name,
        },
    }
}

pub fn transform_text_payload(
    text: &str,
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CodecTransformResponse, AppError> {
    if text.len() > MAX_CODEC_TEXT_BYTES {
        return Err(AppError::size_limit(format!(
            "Interactive text input exceeds 2 MiB limit ({:.2} MiB).",
            text.len() as f64 / (1024.0 * 1024.0)
        )));
    }
    match opts.operation {
        CodecOperation::Encode => {
            let encoded = encode_bytes_to_string(text.as_bytes(), opts, cancel_flag)?;
            Ok(build_response_from_bytes(
                text.len(),
                &[],
                Some(encoded),
                None,
            ))
        }
        CodecOperation::Decode => {
            let decoded = decode_string_to_bytes(text, opts, cancel_flag)?;
            Ok(build_response_from_bytes(text.len(), &decoded, None, None))
        }
    }
}

fn read_bounded_raw_file(
    path: &Path,
    byte_len: u64,
    opts: &CodecOptions,
) -> Result<Vec<u8>, AppError> {
    if byte_len > MAX_CODEC_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "File exceeds 8 MiB safety limit for in-memory codec ({:.2} MiB).",
            byte_len as f64 / (1024.0 * 1024.0)
        )));
    }
    if opts.operation == CodecOperation::Encode
        && opts.format == CodecFormat::Binary
        && (byte_len as usize) > MAX_CODEC_BINARY_ENCODE_BYTES
    {
        return Err(AppError::size_limit(format!(
            "Binary bit encoding is capped at 2 MiB file size ({:.2} MiB selected).",
            byte_len as f64 / (1024.0 * 1024.0)
        )));
    }

    let mut file = OpenOptions::new()
        .read(true)
        .write(false)
        .open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open input file"))?;

    let mut buf = Vec::with_capacity(byte_len as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| AppError::from_io(e, "Failed reading file bytes"))?;
    Ok(buf)
}

pub fn transform_file_payload(
    raw_path: &str,
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CodecTransformResponse, AppError> {
    let (path, byte_len) = validate_existing_input_file(raw_path)?;
    let raw_bytes = read_bounded_raw_file(&path, byte_len, opts)?;
    let file_name = path.file_name().map(|s| s.to_string_lossy().into_owned());

    match opts.operation {
        CodecOperation::Encode => {
            // Raw file bytes are encoded directly — NEVER pre-decoded as UTF-8!
            let encoded = encode_bytes_to_string(&raw_bytes, opts, cancel_flag)?;
            Ok(build_response_from_bytes(
                raw_bytes.len(),
                &[],
                Some(encoded),
                file_name,
            ))
        }
        CodecOperation::Decode => {
            let as_ascii = std::str::from_utf8(&raw_bytes).map_err(|_| {
                AppError::decode_failed(
                    "Input file for Decode must contain ASCII/UTF-8 encoded Base64, Hex, or Binary text.",
                )
            })?;
            let decoded = decode_string_to_bytes(as_ascii, opts, cancel_flag)?;
            Ok(build_response_from_bytes(
                raw_bytes.len(),
                &decoded,
                None,
                file_name,
            ))
        }
    }
}

pub fn compute_full_utf8_result(
    text_input: Option<&str>,
    file_path: Option<&str>,
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<String, AppError> {
    let out_bytes = compute_output_bytes(text_input, file_path, opts, cancel_flag)?;
    std::str::from_utf8(&out_bytes)
        .map(|s| s.to_string())
        .map_err(|_| {
            AppError::decode_failed(
                "Decoded payload contains raw non-UTF-8 binary bytes; use 'Save As…' to export exact bytes without corruption.",
            )
        })
}

fn compute_output_bytes(
    text_input: Option<&str>,
    file_path: Option<&str>,
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<u8>, AppError> {
    if let Some(raw_path) = file_path {
        let (path, byte_len) = validate_existing_input_file(raw_path)?;
        let raw_bytes = read_bounded_raw_file(&path, byte_len, opts)?;
        match opts.operation {
            CodecOperation::Encode => {
                Ok(encode_bytes_to_string(&raw_bytes, opts, cancel_flag)?.into_bytes())
            }
            CodecOperation::Decode => {
                let as_ascii = std::str::from_utf8(&raw_bytes).map_err(|_| {
                    AppError::decode_failed("Input file for Decode is not valid ASCII/UTF-8 text.")
                })?;
                decode_string_to_bytes(as_ascii, opts, cancel_flag)
            }
        }
    } else {
        let text = text_input.unwrap_or("");
        if text.len() > MAX_CODEC_TEXT_BYTES {
            return Err(AppError::size_limit(
                "Interactive text input exceeds 2 MiB limit.",
            ));
        }
        match opts.operation {
            CodecOperation::Encode => {
                Ok(encode_bytes_to_string(text.as_bytes(), opts, cancel_flag)?.into_bytes())
            }
            CodecOperation::Decode => decode_string_to_bytes(text, opts, cancel_flag),
        }
    }
}

pub fn export_codec_result_to_file(
    text_input: Option<&str>,
    source_file_path: Option<&str>,
    output_path: &str,
    overwrite: bool,
    opts: &CodecOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SavedFileInfo, AppError> {
    let out_bytes = compute_output_bytes(text_input, source_file_path, opts, cancel_flag)?;
    let src_buf = match source_file_path {
        Some(raw) if !raw.trim().is_empty() => Some(validate_user_path(raw, "Source")?),
        _ => None,
    };
    write_output_bytes_cancellable(
        output_path,
        src_buf.as_deref(),
        &out_bytes,
        overwrite,
        cancel_flag,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn default_opts(format: CodecFormat, operation: CodecOperation) -> CodecOptions {
        CodecOptions {
            format,
            operation,
            padding: format == CodecFormat::Base64Standard,
            wrap: Base64WrapWidth::None,
            ignore_whitespace: true,
            uppercase_hex: false,
            group_bits: true,
        }
    }

    #[test]
    fn rfc_4648_vectors_for_base64_and_hex_and_binary() {
        // RFC 4648 §10 test vectors: "", "f", "fo", "foo", "foob", "fooba", "foobar"
        let b64_cases = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, expected) in b64_cases {
            let enc = transform_text_payload(
                plain,
                &default_opts(CodecFormat::Base64Standard, CodecOperation::Encode),
                None,
            )
            .expect("b64 encode");
            assert_eq!(enc.preview_text, expected);

            let dec = transform_text_payload(
                expected,
                &default_opts(CodecFormat::Base64Standard, CodecOperation::Decode),
                None,
            )
            .expect("b64 decode");
            assert!(dec.is_valid_utf8);
            assert_eq!(dec.preview_text, plain);
        }

        // RFC 4648 §10 Base16 (Hex) vector: "foobar" -> "666f6f626172"
        let hex_enc = transform_text_payload(
            "foobar",
            &default_opts(CodecFormat::Hex, CodecOperation::Encode),
            None,
        )
        .expect("hex encode");
        assert_eq!(hex_enc.preview_text, "666f6f626172");

        // Binary 8-bit vector: "Hi" -> "01001000 01101001"
        let bin_enc = transform_text_payload(
            "Hi",
            &default_opts(CodecFormat::Binary, CodecOperation::Encode),
            None,
        )
        .expect("bin encode");
        assert_eq!(bin_enc.preview_text, "01001000 01101001");
        let bin_dec = transform_text_payload(
            "01001000 01101001",
            &default_opts(CodecFormat::Binary, CodecOperation::Decode),
            None,
        )
        .expect("bin decode");
        assert_eq!(bin_dec.preview_text, "Hi");
    }

    #[test]
    fn handles_chinese_emoji_urlsafe_chars_and_line_wrapping() {
        let sample = "WinKit 编码测试 🚀🎉";
        let mut opts = default_opts(CodecFormat::Base64Url, CodecOperation::Encode);
        opts.padding = false;
        let enc = transform_text_payload(sample, &opts, None).expect("url encode");
        assert!(!enc.preview_text.contains('='));
        assert!(!enc.preview_text.contains('+'));
        assert!(!enc.preview_text.contains('/'));

        opts.operation = CodecOperation::Decode;
        let dec = transform_text_payload(&enc.preview_text, &opts, None).expect("url decode");
        assert_eq!(dec.preview_text, sample);

        // Verify bytes 0xFB, 0xFF, 0xBF produce '+'/'/' in standard vs '-'/'_' in URL-safe
        let tricky = [0xFBu8, 0xFFu8, 0xBFu8];
        let std_s = encode_bytes_to_string(
            &tricky,
            &default_opts(CodecFormat::Base64Standard, CodecOperation::Encode),
            None,
        )
        .unwrap();
        let url_s = encode_bytes_to_string(
            &tricky,
            &default_opts(CodecFormat::Base64Url, CodecOperation::Encode),
            None,
        )
        .unwrap();
        assert_eq!(std_s, "+/+/");
        assert_eq!(url_s, "-_-_");

        // Verify 64-col line wrap and whitespace-tolerant round-trip
        let mut wrap_opts = default_opts(CodecFormat::Base64Standard, CodecOperation::Encode);
        wrap_opts.wrap = Base64WrapWidth::Cols64;
        let long_in = vec![b'A'; 120];
        let wrapped = encode_bytes_to_string(&long_in, &wrap_opts, None).unwrap();
        let lines: Vec<&str> = wrapped.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].len(), 64);
        assert_eq!(lines[1].len(), 64);

        wrap_opts.operation = CodecOperation::Decode;
        let round = decode_string_to_bytes(&wrapped, &wrap_opts, None).unwrap();
        assert_eq!(round, long_in);
    }

    #[test]
    fn preserves_arbitrary_0x00_to_0xff_binary_file_roundtrip_and_flags_non_utf8_cleanly() {
        let dir = tempdir().expect("tempdir");
        let bin_in = dir.path().join("raw_all_bytes.bin");
        let encoded_txt = dir.path().join("raw_all_bytes.b64");
        let bin_out = dir.path().join("raw_restored.bin");

        let all_bytes: Vec<u8> = (0u8..=255u8).collect();
        fs::write(&bin_in, &all_bytes).expect("write raw 0..=255");

        let enc_opts = default_opts(CodecFormat::Base64Standard, CodecOperation::Encode);
        let enc_resp =
            transform_file_payload(&bin_in.to_string_lossy(), &enc_opts, None).expect("encode bin");
        assert!(enc_resp.is_valid_utf8);
        assert_eq!(enc_resp.input_byte_length, 256);

        export_codec_result_to_file(
            None,
            Some(&bin_in.to_string_lossy()),
            &encoded_txt.to_string_lossy(),
            false,
            &enc_opts,
            None,
        )
        .expect("save encoded");

        // Decoding 0x00..=0xFF produces invalid UTF-8 — must NOT fake valid UTF-8 text!
        let dec_opts = default_opts(CodecFormat::Base64Standard, CodecOperation::Decode);
        let dec_resp = transform_file_payload(&encoded_txt.to_string_lossy(), &dec_opts, None)
            .expect("decode bin");
        assert!(!dec_resp.is_valid_utf8);
        assert!(dec_resp.preview_text.is_empty());
        assert!(dec_resp
            .hex_preview
            .as_deref()
            .unwrap()
            .contains("00 01 02"));
        assert_eq!(dec_resp.output_byte_length, 256);

        // Saving decoded binary writes exact 0x00..=0xFF bytes without corruption and blocks overwriting source
        let same_err = export_codec_result_to_file(
            None,
            Some(&encoded_txt.to_string_lossy()),
            &encoded_txt.to_string_lossy(),
            true,
            &dec_opts,
            None,
        )
        .unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        export_codec_result_to_file(
            None,
            Some(&encoded_txt.to_string_lossy()),
            &bin_out.to_string_lossy(),
            false,
            &dec_opts,
            None,
        )
        .expect("export restored binary");

        let restored = fs::read(&bin_out).expect("read restored");
        assert_eq!(restored, all_bytes);
    }

    #[test]
    fn reports_exact_errors_for_invalid_alphabet_padding_odd_hex_and_incomplete_bits() {
        // URL-safe '-' fed to Standard Base64
        let err_alpha = decode_string_to_bytes(
            "Zm9-",
            &default_opts(CodecFormat::Base64Standard, CodecOperation::Decode),
            None,
        )
        .unwrap_err();
        assert!(err_alpha.message.contains("offset 4"));

        // Missing '=' when padding is required
        let err_pad = decode_string_to_bytes(
            "Zg",
            &default_opts(CodecFormat::Base64Standard, CodecOperation::Decode),
            None,
        )
        .unwrap_err();
        assert!(err_pad.message.contains("padding"));

        // Mid-stream '=' padding
        let err_mid = decode_string_to_bytes(
            "Zg==Zm9v",
            &default_opts(CodecFormat::Base64Standard, CodecOperation::Decode),
            None,
        )
        .unwrap_err();
        assert!(err_mid.message.contains("after '='"));

        // Odd-length hex
        let err_odd = decode_string_to_bytes(
            "4a6f6",
            &default_opts(CodecFormat::Hex, CodecOperation::Decode),
            None,
        )
        .unwrap_err();
        assert!(err_odd.message.contains("Odd hexadecimal length"));

        // Invalid hex char with offset
        let err_hex_ch = decode_string_to_bytes(
            "4a6g",
            &default_opts(CodecFormat::Hex, CodecOperation::Decode),
            None,
        )
        .unwrap_err();
        assert!(err_hex_ch.message.contains("offset 4"));

        // Incomplete binary byte (7 bits)
        let err_bits = decode_string_to_bytes(
            "0100001",
            &default_opts(CodecFormat::Binary, CodecOperation::Decode),
            None,
        )
        .unwrap_err();
        assert!(err_bits.message.contains("7 bits"));
    }
}
