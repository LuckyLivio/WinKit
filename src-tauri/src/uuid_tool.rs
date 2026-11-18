use crate::error::AppError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_UUID_BATCH: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UuidGenVersion {
    V4,
    V7,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UuidInspectResult {
    pub canonical: String,
    pub compact_hex: String,
    pub is_nil: bool,
    pub is_max: bool,
    pub version: Option<u8>,
    pub variant: String,
    pub unix_timestamp_ms: Option<u64>,
}

pub fn generate_uuid_batch(version: UuidGenVersion, count: usize) -> Result<Vec<String>, AppError> {
    if count == 0 || count > MAX_UUID_BATCH {
        return Err(AppError::invalid_param(format!(
            "UUID batch count must be between 1 and {MAX_UUID_BATCH} (got {count})."
        )));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let id = match version {
            UuidGenVersion::V4 => Uuid::new_v4(),
            UuidGenVersion::V7 => Uuid::now_v7(),
        };
        out.push(id.hyphenated().to_string());
    }
    Ok(out)
}

pub fn inspect_uuid_string(raw: &str) -> Result<UuidInspectResult, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_param("UUID input is empty."));
    }

    let parsed = Uuid::try_parse(trimmed).map_err(|_| {
        AppError::decode_failed(
            "Invalid UUID syntax: expected 32 hexadecimal digits (canonical 8-4-4-4-12, hyphenless, braced, or urn:uuid:).",
        )
    })?;

    let bytes = *parsed.as_bytes();
    let is_nil = bytes.iter().all(|&b| b == 0x00);
    let is_max = bytes.iter().all(|&b| b == 0xFF);

    let (variant, version, unix_timestamp_ms) = if is_nil {
        ("Nil (RFC 9562 §5.9)".to_string(), None, None)
    } else if is_max {
        ("Max (RFC 9562 §5.10)".to_string(), None, None)
    } else {
        let b8 = bytes[8];
        let variant_str = if (b8 & 0x80) == 0x00 {
            "NCS Backward Compatible (0xx)"
        } else if (b8 & 0xC0) == 0x80 {
            "RFC 9562 / RFC 4122 (10x)"
        } else if (b8 & 0xE0) == 0xC0 {
            "Microsoft Reserved (110)"
        } else {
            "Future Reserved (111)"
        };

        let is_rfc = (b8 & 0xC0) == 0x80;
        let ver = is_rfc.then_some((bytes[6] >> 4) & 0x0f);
        let ts_ms = if ver == Some(7) {
            let ms = (u64::from(bytes[0]) << 40)
                | (u64::from(bytes[1]) << 32)
                | (u64::from(bytes[2]) << 24)
                | (u64::from(bytes[3]) << 16)
                | (u64::from(bytes[4]) << 8)
                | u64::from(bytes[5]);
            Some(ms)
        } else {
            None
        };
        (variant_str.to_string(), ver, ts_ms)
    };

    Ok(UuidInspectResult {
        canonical: parsed.hyphenated().to_string(),
        compact_hex: parsed.simple().to_string(),
        is_nil,
        is_max,
        version,
        variant,
        unix_timestamp_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_valid_rfc_9562_v4_and_v7_batches_and_enforces_limits() {
        assert!(generate_uuid_batch(UuidGenVersion::V4, 0).is_err());
        assert!(generate_uuid_batch(UuidGenVersion::V7, 501).is_err());

        let v4_list = generate_uuid_batch(UuidGenVersion::V4, 16).expect("v4 batch");
        assert_eq!(v4_list.len(), 16);
        for item in &v4_list {
            let info = inspect_uuid_string(item).expect("inspect v4");
            assert_eq!(info.version, Some(4));
            assert_eq!(info.variant, "RFC 9562 / RFC 4122 (10x)");
            assert_eq!(info.unix_timestamp_ms, None);
        }

        let v7_list = generate_uuid_batch(UuidGenVersion::V7, 16).expect("v7 batch");
        assert_eq!(v7_list.len(), 16);
        for item in &v7_list {
            let info = inspect_uuid_string(item).expect("inspect v7");
            assert_eq!(info.version, Some(7));
            assert_eq!(info.variant, "RFC 9562 / RFC 4122 (10x)");
            assert!(info.unix_timestamp_ms.expect("v7 has ms") > 1_700_000_000_000);
        }
    }

    #[test]
    fn inspects_rfc_9562_appendix_a_vectors_nil_max_and_rejects_malformed() {
        // RFC 9562 Appendix A.4 v4 vector — MUST NOT fabricate a timestamp
        let v4 = inspect_uuid_string("919108f7-52d1-4320-9bac-f847db4148a8").expect("A.4 v4");
        assert_eq!(v4.version, Some(4));
        assert_eq!(v4.variant, "RFC 9562 / RFC 4122 (10x)");
        assert_eq!(v4.unix_timestamp_ms, None);

        // RFC 9562 Appendix A.6 v7 vector: 2022-02-22T19:22:22.000Z = 1645557742000 ms
        let v7 = inspect_uuid_string("017f22e2-79b0-7cc3-98c4-dc0c0c07398f").expect("A.6 v7");
        assert_eq!(v7.version, Some(7));
        assert_eq!(v7.variant, "RFC 9562 / RFC 4122 (10x)");
        assert_eq!(v7.unix_timestamp_ms, Some(1_645_557_742_000));

        // Braced & urn:uuid: & Nil & Max
        let nil = inspect_uuid_string("00000000-0000-0000-0000-000000000000").expect("nil");
        assert!(nil.is_nil);
        assert_eq!(nil.version, None);

        let max = inspect_uuid_string("{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}").expect("max");
        assert!(max.is_max);
        assert_eq!(max.version, None);

        assert!(inspect_uuid_string("not-a-uuid").is_err());
    }
}
