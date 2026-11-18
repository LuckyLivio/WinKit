use crate::error::AppError;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Sha384, Sha512};

const MAX_JWT_TOKEN_BYTES: usize = 256 * 1024;
const MAX_JWT_SECRET_BYTES: usize = 64 * 1024;

type HmacSha256 = Hmac<Sha256>;
type HmacSha384 = Hmac<Sha384>;
type HmacSha512 = Hmac<Sha512>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JwtHmacAlgorithm {
    HS256,
    HS384,
    HS512,
}

impl JwtHmacAlgorithm {
    pub fn from_alg_name(name: &str) -> Option<Self> {
        match name {
            "HS256" => Some(Self::HS256),
            "HS384" => Some(Self::HS384),
            "HS512" => Some(Self::HS512),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::HS256 => "HS256",
            Self::HS384 => "HS384",
            Self::HS512 => "HS512",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JwtSecretEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtHmacVerifyRequest {
    pub raw_token: String,
    pub expected_algorithm: Option<JwtHmacAlgorithm>,
    pub secret: String,
    pub secret_encoding: JwtSecretEncoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JwtSignatureVerifyOutcome {
    Valid,
    InvalidSignature,
    AlgorithmMismatch,
    UnsignedAlgNone,
    UnsupportedAlgorithm,
    UnsupportedCritHeader,
    InvalidSecretBase64,
    EmptySecret,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtHmacVerifyResponse {
    pub outcome: JwtSignatureVerifyOutcome,
    pub header_alg: Option<String>,
    pub resolved_algorithm: Option<JwtHmacAlgorithm>,
    pub key_byte_length: usize,
    pub detail: String,
}

/// Strips outer whitespace, a single matching pair of outer quotes (`"..."` or `'...'`),
/// and an explicit `Bearer ` prefix without altering any internal token characters.
pub fn normalize_jwt_envelope(raw: &str) -> &str {
    let mut s = raw.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s = s[1..s.len() - 1].trim();
    }
    if s.len() > 7 && s[..6].eq_ignore_ascii_case("bearer") {
        let rest = &s[6..];
        if rest.starts_with(|c: char| c.is_ascii_whitespace()) {
            s = rest.trim_start();
        }
    }
    s
}

fn decode_secret_base64_strict(raw_secret: &str) -> Result<Vec<u8>, ()> {
    let compact: String = raw_secret
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.is_empty() {
        return Err(());
    }
    let has_std = compact.contains('+') || compact.contains('/');
    let has_url = compact.contains('-') || compact.contains('_');
    if has_std && has_url {
        return Err(());
    }
    let has_pad = compact.contains('=');
    let decoded = if has_url {
        if has_pad {
            URL_SAFE.decode(&compact)
        } else {
            URL_SAFE_NO_PAD.decode(&compact)
        }
    } else if has_pad {
        STANDARD.decode(&compact)
    } else {
        STANDARD_NO_PAD.decode(&compact)
    };
    decoded
        .map_err(|_| ())
        .and_then(|b| if b.is_empty() { Err(()) } else { Ok(b) })
}

fn verify_hmac_constant_time(
    alg: JwtHmacAlgorithm,
    key_bytes: &[u8],
    header_b64: &str,
    payload_b64: &str,
    sig_bytes: &[u8],
) -> bool {
    match alg {
        JwtHmacAlgorithm::HS256 => {
            let mut mac =
                HmacSha256::new_from_slice(key_bytes).expect("HMAC accepts any key length");
            mac.update(header_b64.as_bytes());
            mac.update(b".");
            mac.update(payload_b64.as_bytes());
            mac.verify_slice(sig_bytes).is_ok()
        }
        JwtHmacAlgorithm::HS384 => {
            let mut mac =
                HmacSha384::new_from_slice(key_bytes).expect("HMAC accepts any key length");
            mac.update(header_b64.as_bytes());
            mac.update(b".");
            mac.update(payload_b64.as_bytes());
            mac.verify_slice(sig_bytes).is_ok()
        }
        JwtHmacAlgorithm::HS512 => {
            let mut mac =
                HmacSha512::new_from_slice(key_bytes).expect("HMAC accepts any key length");
            mac.update(header_b64.as_bytes());
            mac.update(b".");
            mac.update(payload_b64.as_bytes());
            mac.verify_slice(sig_bytes).is_ok()
        }
    }
}

pub fn verify_jwt_hmac_token(
    req: &JwtHmacVerifyRequest,
) -> Result<JwtHmacVerifyResponse, AppError> {
    if req.raw_token.len() > MAX_JWT_TOKEN_BYTES {
        return Err(AppError::size_limit(
            "JWT input exceeds the 256 KB maximum size limit.",
        ));
    }
    if req.secret.len() > MAX_JWT_SECRET_BYTES {
        return Err(AppError::size_limit(
            "HMAC secret exceeds the 64 KB maximum size limit.",
        ));
    }

    let token = normalize_jwt_envelope(&req.raw_token);
    if token.is_empty() {
        return Err(AppError::invalid_param("JWT token must not be empty."));
    }

    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() == 5 {
        return Err(AppError::invalid_param(
            "5-part encrypted JWE tokens cannot be verified with JWS HMAC.",
        ));
    }
    if parts.len() != 3 {
        return Err(AppError::decode_failed(format!(
            "Expected a 3-part JWS token, found {} segment(s).",
            parts.len()
        )));
    }

    let header_b64 = parts[0];
    let payload_b64 = parts[1];
    let sig_b64 = parts[2];

    if header_b64.is_empty() {
        return Err(AppError::decode_failed("JWT header segment is empty."));
    }

    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .map_err(|_| AppError::decode_failed("JWT header is not valid RFC 7515 Base64url."))?;
    let _payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| AppError::decode_failed("JWT payload is not valid RFC 7515 Base64url."))?;

    let header_utf8 = std::str::from_utf8(&header_bytes)
        .map_err(|_| AppError::decode_failed("JWT header is not valid UTF-8."))?;
    let header_val: serde_json::Value = serde_json::from_str(header_utf8)
        .map_err(|_| AppError::decode_failed("JWT header is not valid JSON."))?;
    let header_obj = header_val
        .as_object()
        .ok_or_else(|| AppError::decode_failed("JWT header must be a JSON object."))?;

    let raw_alg = header_obj
        .get("alg")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // RFC 7515 Section 4.1.11: Critical header parameters (`crit`) that are not understood/supported
    // MUST cause the JWS to be rejected rather than silently ignored.
    if header_obj.contains_key("crit") {
        return Ok(JwtHmacVerifyResponse {
            outcome: JwtSignatureVerifyOutcome::UnsupportedCritHeader,
            header_alg: raw_alg,
            resolved_algorithm: None,
            key_byte_length: 0,
            detail: "JOSE 'crit' (critical extensions) header is present and not supported."
                .to_string(),
        });
    }

    let Some(alg_str) = raw_alg.clone() else {
        return Err(AppError::decode_failed(
            "JWT header is missing a string 'alg' parameter.",
        ));
    };

    if alg_str.eq_ignore_ascii_case("none") {
        return Ok(JwtHmacVerifyResponse {
            outcome: JwtSignatureVerifyOutcome::UnsignedAlgNone,
            header_alg: Some(alg_str),
            resolved_algorithm: None,
            key_byte_length: 0,
            detail: "Token declares alg=none and carries no cryptographic signature.".to_string(),
        });
    }

    let Some(header_hmac) = JwtHmacAlgorithm::from_alg_name(&alg_str) else {
        return Ok(JwtHmacVerifyResponse {
            outcome: JwtSignatureVerifyOutcome::UnsupportedAlgorithm,
            header_alg: Some(alg_str),
            resolved_algorithm: None,
            key_byte_length: 0,
            detail: "Only local HMAC algorithms (HS256, HS384, HS512) are supported in this phase."
                .to_string(),
        });
    };

    if let Some(expected) = req.expected_algorithm {
        if expected != header_hmac {
            return Ok(JwtHmacVerifyResponse {
                outcome: JwtSignatureVerifyOutcome::AlgorithmMismatch,
                header_alg: Some(alg_str),
                resolved_algorithm: Some(expected),
                key_byte_length: 0,
                detail: format!(
                    "Header alg '{}' does not match expected verifier algorithm '{}'.",
                    header_hmac.as_str(),
                    expected.as_str()
                ),
            });
        }
    }

    let key_bytes = match req.secret_encoding {
        JwtSecretEncoding::Utf8 => {
            if req.secret.is_empty() {
                return Ok(JwtHmacVerifyResponse {
                    outcome: JwtSignatureVerifyOutcome::EmptySecret,
                    header_alg: Some(alg_str),
                    resolved_algorithm: Some(header_hmac),
                    key_byte_length: 0,
                    detail: "Enter an HMAC secret key to verify signature.".to_string(),
                });
            }
            req.secret.as_bytes().to_vec()
        }
        JwtSecretEncoding::Base64 => {
            if req.secret.trim().is_empty() {
                return Ok(JwtHmacVerifyResponse {
                    outcome: JwtSignatureVerifyOutcome::EmptySecret,
                    header_alg: Some(alg_str),
                    resolved_algorithm: Some(header_hmac),
                    key_byte_length: 0,
                    detail: "Enter a Base64 / Base64url secret key to verify signature."
                        .to_string(),
                });
            }
            match decode_secret_base64_strict(&req.secret) {
                Ok(bytes) => bytes,
                Err(()) => {
                    return Ok(JwtHmacVerifyResponse {
                        outcome: JwtSignatureVerifyOutcome::InvalidSecretBase64,
                        header_alg: Some(alg_str),
                        resolved_algorithm: Some(header_hmac),
                        key_byte_length: 0,
                        detail: "Secret is not valid Base64 / Base64url data.".to_string(),
                    });
                }
            }
        }
    };

    if sig_b64.is_empty() {
        return Ok(JwtHmacVerifyResponse {
            outcome: JwtSignatureVerifyOutcome::InvalidSignature,
            header_alg: Some(alg_str),
            resolved_algorithm: Some(header_hmac),
            key_byte_length: key_bytes.len(),
            detail: "Signature segment is empty for a signed HMAC token.".to_string(),
        });
    }

    let sig_bytes = match URL_SAFE_NO_PAD.decode(sig_b64) {
        Ok(b) => b,
        Err(_) => {
            return Err(AppError::decode_failed(
                "JWT signature segment is not valid RFC 7515 Base64url.",
            ));
        }
    };

    let matched =
        verify_hmac_constant_time(header_hmac, &key_bytes, header_b64, payload_b64, &sig_bytes);

    Ok(JwtHmacVerifyResponse {
        outcome: if matched {
            JwtSignatureVerifyOutcome::Valid
        } else {
            JwtSignatureVerifyOutcome::InvalidSignature
        },
        header_alg: Some(alg_str),
        resolved_algorithm: Some(header_hmac),
        key_byte_length: key_bytes.len(),
        detail: if matched {
            format!(
                "{} HMAC signature verified against raw signing input.",
                header_hmac.as_str()
            )
        } else {
            "Computed HMAC does not match the token signature.".to_string()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Official IETF RFC 7515 Appendix A.1.1 JWS HMAC-SHA256 vector (contains CRLF inside raw JSON!)
    const RFC7515_A1_TOKEN: &str = "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC7515_A1_KEY_B64URL: &str =
        "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow";

    // Independent OpenSSL reference vectors across HS256, HS384, HS512
    const VEC_HS256: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.reGQzG3OKdoIMWLDKOZ4TICJit3EW69cQE72E2CfzRE";
    const VEC_HS384: &str = "eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.bQTnz6AuMJvmXXQsVPrxeQNvzDkimo7VNXxHeSBfClLufmCVZRUuyTwJF311JHuh";
    const VEC_HS512: &str = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.VFb0qJ1LRg_4ujbZoRMXnVkUgiuKq5KxWqNdbKq_G9Vvz-S1zZa9LPxtHWKa64zDl2ofkT8F6jBt_K4riU-fPg";

    #[test]
    fn verifies_rfc7515_a1_base64url_key_over_exact_unreformatted_segments() {
        let res = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: format!("  \"Bearer {RFC7515_A1_TOKEN}\"  "),
            expected_algorithm: Some(JwtHmacAlgorithm::HS256),
            secret: RFC7515_A1_KEY_B64URL.to_string(),
            secret_encoding: JwtSecretEncoding::Base64,
        })
        .expect("verify RFC 7515 A.1.1");

        assert_eq!(res.outcome, JwtSignatureVerifyOutcome::Valid);
        assert_eq!(res.key_byte_length, 64);

        // Treating the exact same Base64url string as raw UTF-8 bytes MUST NOT match!
        let wrong_mode = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: RFC7515_A1_TOKEN.to_string(),
            expected_algorithm: None,
            secret: RFC7515_A1_KEY_B64URL.to_string(),
            secret_encoding: JwtSecretEncoding::Utf8,
        })
        .expect("utf8 mode");
        assert_eq!(
            wrong_mode.outcome,
            JwtSignatureVerifyOutcome::InvalidSignature
        );
    }

    #[test]
    fn verifies_independent_hs256_hs384_hs512_vectors_and_detects_wrong_key_or_tampering() {
        for (token, alg, key) in [
            (VEC_HS256, JwtHmacAlgorithm::HS256, "your-256-bit-secret"),
            (VEC_HS384, JwtHmacAlgorithm::HS384, "your-384-bit-secret"),
            (VEC_HS512, JwtHmacAlgorithm::HS512, "your-512-bit-secret"),
        ] {
            let ok = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
                raw_token: token.to_string(),
                expected_algorithm: Some(alg),
                secret: key.to_string(),
                secret_encoding: JwtSecretEncoding::Utf8,
            })
            .expect("valid vector");
            assert_eq!(ok.outcome, JwtSignatureVerifyOutcome::Valid);

            let bad_key = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
                raw_token: token.to_string(),
                expected_algorithm: Some(alg),
                secret: format!("{key}-wrong"),
                secret_encoding: JwtSecretEncoding::Utf8,
            })
            .expect("wrong key");
            assert_eq!(bad_key.outcome, JwtSignatureVerifyOutcome::InvalidSignature);
        }

        // Tamper payload (admin:false instead of admin:true) keeping original HS256 signature
        let tampered_payload = URL_SAFE_NO_PAD
            .encode(br#"{"sub":"1234567890","name":"John Doe","admin":false,"iat":1516239022}"#);
        let parts: Vec<&str> = VEC_HS256.split('.').collect();
        let tampered_token = format!("{}.{}.{}", parts[0], tampered_payload, parts[2]);
        let tampered_res = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: tampered_token,
            expected_algorithm: None,
            secret: "your-256-bit-secret".to_string(),
            secret_encoding: JwtSecretEncoding::Utf8,
        })
        .expect("tampered");
        assert_eq!(
            tampered_res.outcome,
            JwtSignatureVerifyOutcome::InvalidSignature
        );
    }

    #[test]
    fn enforces_alg_mismatch_alg_none_unsupported_alg_and_crit_rejection() {
        // 1. Algorithm mismatch (Header HS256 vs Expected HS512)
        let mismatch = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: VEC_HS256.to_string(),
            expected_algorithm: Some(JwtHmacAlgorithm::HS512),
            secret: "your-256-bit-secret".to_string(),
            secret_encoding: JwtSecretEncoding::Utf8,
        })
        .expect("mismatch");
        assert_eq!(
            mismatch.outcome,
            JwtSignatureVerifyOutcome::AlgorithmMismatch
        );

        // 2. alg = none MUST NEVER verify as Valid
        let none_hdr = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"123"}"#);
        let none_token = format!("{none_hdr}.{payload}.");
        let none_res = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: none_token,
            expected_algorithm: None,
            secret: "".to_string(),
            secret_encoding: JwtSecretEncoding::Utf8,
        })
        .expect("none");
        assert_eq!(none_res.outcome, JwtSignatureVerifyOutcome::UnsignedAlgNone);

        // 3. Unsupported asymmetric algorithm (RS256)
        let rs_hdr = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let rs_token = format!("{rs_hdr}.{payload}.c2ln");
        let rs_res = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: rs_token,
            expected_algorithm: None,
            secret: "any".to_string(),
            secret_encoding: JwtSecretEncoding::Utf8,
        })
        .expect("rs256");
        assert_eq!(
            rs_res.outcome,
            JwtSignatureVerifyOutcome::UnsupportedAlgorithm
        );

        // 4. Unsupported critical header `crit` MUST reject even with matching HMAC signature!
        let crit_hdr =
            URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","crit":["customExt"],"customExt":1}"#);
        let mut mac = HmacSha256::new_from_slice(b"secret-key").unwrap();
        mac.update(format!("{crit_hdr}.{payload}").as_bytes());
        let crit_sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let crit_token = format!("{crit_hdr}.{payload}.{crit_sig}");
        let crit_res = verify_jwt_hmac_token(&JwtHmacVerifyRequest {
            raw_token: crit_token,
            expected_algorithm: None,
            secret: "secret-key".to_string(),
            secret_encoding: JwtSecretEncoding::Utf8,
        })
        .expect("crit");
        assert_eq!(
            crit_res.outcome,
            JwtSignatureVerifyOutcome::UnsupportedCritHeader
        );
    }
}
