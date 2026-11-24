//! P15 PDF Encryption & P16 PDF Decryption powered by bundled QPDF v12.4.2 (`qpdf30.dll`).
//!
//! Security & honesty guarantees:
//! - Uses battle-tested `qpdf` AES-256 (ISO 32000-2 R6) for encryption and supports standard
//!   RC4-40, RC4-128, AES-128, AES-256 R5, and AES-256 R6 PDFs for user-authorized decryption.
//! - Passwords NEVER appear in command-line arguments, temporary files, persisted settings,
//!   telemetry, `Debug` output, or returned error strings.
//! - P15 enforces non-empty distinct owner passwords: when the user leaves the separate owner
//!   password blank, WinKit generates a cryptographically strong random 32-character owner password
//!   via `OsRng` so no insecure empty-owner-password PDF is created.
//! - P16 strictly uses the user's known password (zero brute-force or dictionary attempts),
//!   distinguishes unencrypted / wrong password / unsupported security / corrupt files accurately,
//!   and independently verifies that the output opens without a password via both QPDF and PDFium
//!   before atomically committing the output file.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::pdf_core::{
    inspect_structural_flags_lopdf, AtomicPdfOutput, PdfSessionManager, PdfTaskProgressPayload,
};
use crate::pdf_pdfium::{inspect_with_pdfium, MAX_PDF_FILE_BYTES};
use crate::pdf_qpdf::{
    run_qpdf_job, DEFAULT_QPDF_TIMEOUT, QPDF_EXIT_ERROR, QPDF_EXIT_SUCCESS, QPDF_EXIT_WARNING,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_PASSWORD_LEN: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSecurityStatus {
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    /// `"unencrypted"` | `"encrypted_password_required"` | `"encrypted_owner_only"` | `"unsupported_security"` | `"corrupt_or_invalid"`
    pub status: String,
    pub is_encrypted: bool,
    pub requires_open_password: bool,
    pub has_owner_restrictions: bool,
    pub encryption_revision: Option<u32>,
    pub encryption_label: Option<String>,
    pub print_permission: Option<String>,
    pub allow_copy: Option<bool>,
    pub allow_modify: Option<bool>,
    pub page_count: Option<usize>,
    pub has_signatures: bool,
    pub signature_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptPdfRequest {
    pub input_path: String,
    pub output_path: String,
    pub overwrite: bool,
    pub user_password: String,
    pub owner_password: Option<String>,
    /// `"none"` | `"low"` | `"full"`
    pub print_permission: String,
    pub allow_copy: bool,
    /// `"none"` | `"annotate"` | `"all"`
    pub allow_modify: String,
    pub encrypt_metadata: Option<bool>,
}

impl fmt::Debug for EncryptPdfRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptPdfRequest")
            .field("input_path", &self.input_path)
            .field("output_path", &self.output_path)
            .field("overwrite", &self.overwrite)
            .field("user_password", &"[REDACTED]")
            .field(
                "owner_password",
                &self.owner_password.as_ref().map(|_| "[REDACTED]"),
            )
            .field("print_permission", &self.print_permission)
            .field("allow_copy", &self.allow_copy)
            .field("allow_modify", &self.allow_modify)
            .field("encrypt_metadata", &self.encrypt_metadata)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptPdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub page_count: usize,
    pub algorithm: String,
    pub has_open_password: bool,
    pub used_generated_owner_password: bool,
    pub print_permission: String,
    pub allow_copy: bool,
    pub allow_modify: String,
    pub signature_invalidated: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptPdfRequest {
    pub input_path: String,
    pub output_path: String,
    pub overwrite: bool,
    pub password: String,
}

impl fmt::Debug for DecryptPdfRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecryptPdfRequest")
            .field("input_path", &self.input_path)
            .field("output_path", &self.output_path)
            .field("overwrite", &self.overwrite)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptPdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub page_count: usize,
    pub original_encryption: Option<String>,
    pub verified_open_without_password: bool,
    pub has_text_layer: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
struct ParsedEncryptionInfo {
    is_encrypted: bool,
    incorrect_empty_password: bool,
    revision: Option<u32>,
    stream_method: Option<String>,
    print_low: Option<bool>,
    print_high: Option<bool>,
    extract_any: Option<bool>,
    modify_anything: Option<bool>,
}

fn parse_show_encryption_info(info: &str) -> ParsedEncryptionInfo {
    let mut parsed = ParsedEncryptionInfo::default();
    let trimmed = info.trim();
    if trimmed.is_empty() || trimmed.starts_with("File is not encrypted") {
        return parsed;
    }
    parsed.is_encrypted = true;
    for raw_line in trimmed.lines() {
        let line = raw_line.trim();
        if line.eq_ignore_ascii_case("Incorrect password supplied") {
            parsed.incorrect_empty_password = true;
        } else if let Some(val) = line.strip_prefix("R = ") {
            parsed.revision = val.trim().parse::<u32>().ok();
        } else if let Some(val) = line.strip_prefix("stream encryption method:") {
            parsed.stream_method = Some(val.trim().to_string());
        } else if let Some(val) = line.strip_prefix("print low resolution:") {
            parsed.print_low = Some(val.trim() == "allowed");
        } else if let Some(val) = line.strip_prefix("print high resolution:") {
            parsed.print_high = Some(val.trim() == "allowed");
        } else if let Some(val) = line.strip_prefix("extract for any purpose:") {
            parsed.extract_any = Some(val.trim() == "allowed");
        } else if let Some(val) = line.strip_prefix("modify anything:") {
            parsed.modify_anything = Some(val.trim() == "allowed");
        }
    }
    parsed
}

fn format_encryption_label(parsed: &ParsedEncryptionInfo) -> Option<String> {
    if !parsed.is_encrypted {
        return None;
    }
    let method = parsed.stream_method.as_deref().unwrap_or("");
    let rev = parsed.revision;
    let algo = match (method, rev) {
        ("AESv3", Some(6)) => "AES-256 (PDF 2.0 R6)".to_string(),
        ("AESv3", Some(5)) => "AES-256 (R5)".to_string(),
        ("AESv3", _) => "AES-256".to_string(),
        ("AESv2", Some(r)) => format!("AES-128 (R{r})"),
        ("AESv2", None) => "AES-128".to_string(),
        ("RC4", Some(2)) => "RC4-40 (R2)".to_string(),
        ("RC4", Some(3)) => "RC4-128 (R3)".to_string(),
        ("RC4", Some(r)) => format!("RC4-128 (R{r})"),
        ("RC4", None) => "RC4".to_string(),
        ("", Some(6)) => "AES-256 (R6)".to_string(),
        ("", Some(5)) => "AES-256 (R5)".to_string(),
        ("", Some(4)) => "128-bit (R4)".to_string(),
        ("", Some(3)) => "RC4-128 (R3)".to_string(),
        ("", Some(2)) => "RC4-40 (R2)".to_string(),
        (other, Some(r)) => format!("{other} (R{r})"),
        (other, None) => other.to_string(),
    };
    Some(algo)
}

fn classify_qpdf_error_message(error_text: &str) -> (&'static str, String) {
    let lower = error_text.to_ascii_lowercase();
    if lower.contains("invalid password") {
        return (
            "PDF_WRONG_PASSWORD",
            "The supplied password is incorrect.".to_string(),
        );
    }
    if lower.contains("unsupported")
        || lower.contains("security handler")
        || lower.contains("pubsec")
        || lower.contains("public key")
        || lower.contains("crypt filter")
        || lower.contains("unimplemented encryption")
        || lower.contains("unknown encryption")
    {
        return (
            "PDF_UNSUPPORTED_SECURITY",
            "This PDF uses an unsupported encryption or security handler (for example certificate/DRM encryption)."
                .to_string(),
        );
    }
    if lower.contains("no space") || lower.contains("disk full") {
        return (
            "DISK_FULL",
            "Not enough free disk space in the output folder.".to_string(),
        );
    }
    if lower.contains("permission denied") || lower.contains("access is denied") {
        return (
            "PERMISSION_DENIED",
            "Access was denied while reading or writing the PDF file.".to_string(),
        );
    }
    (
        "PDF_CORRUPT_OR_INVALID",
        "This file is not a valid PDF document or its structure is corrupted.".to_string(),
    )
}

fn generate_strong_owner_password() -> String {
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

fn validate_password_input(pw: &str, label: &str) -> Result<(), AppError> {
    if pw.len() > MAX_PASSWORD_LEN {
        return Err(AppError::invalid_param(format!(
            "{label} exceeds the {MAX_PASSWORD_LEN}-byte limit."
        )));
    }
    if pw.contains('\0') {
        return Err(AppError::invalid_param(format!(
            "{label} contains an invalid NUL character."
        )));
    }
    Ok(())
}

fn query_page_count_qpdf(
    resource_dir: Option<&Path>,
    path: &Path,
    password: Option<&str>,
) -> Result<usize, AppError> {
    let mut job = serde_json::Map::new();
    job.insert("inputFile".to_string(), json!(path.to_string_lossy()));
    job.insert("showNpages".to_string(), json!(""));
    if let Some(pw) = password {
        if !pw.is_empty() {
            job.insert("password".to_string(), json!(pw));
        }
    }
    let out = run_qpdf_job(
        resource_dir,
        &serde_json::Value::Object(job),
        None,
        DEFAULT_QPDF_TIMEOUT,
        None,
    )?;
    if out.exit_code != QPDF_EXIT_SUCCESS && out.exit_code != QPDF_EXIT_WARNING {
        let (code, msg) = classify_qpdf_error_message(&out.error);
        return Err(AppError::new(code, msg));
    }
    out.info.trim().parse::<usize>().map_err(|_| {
        AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "Unable to read page count from PDF document.",
        )
    })
}

pub fn inspect_pdf_security_impl(
    pdf_session: &PdfSessionManager,
    path_raw: &str,
) -> Result<PdfSecurityStatus, AppError> {
    let (canonical, byte_length) = validate_existing_input_file(path_raw)?;
    let path_str = canonical.to_string_lossy().into_owned();
    let file_name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document.pdf".to_string());

    if byte_length == 0 {
        return Ok(PdfSecurityStatus {
            path: path_str,
            file_name,
            byte_length,
            status: "corrupt_or_invalid".to_string(),
            is_encrypted: false,
            requires_open_password: false,
            has_owner_restrictions: false,
            encryption_revision: None,
            encryption_label: None,
            print_permission: None,
            allow_copy: None,
            allow_modify: None,
            page_count: None,
            has_signatures: false,
            signature_count: 0,
            warnings: vec!["PDF file is empty (0 bytes).".to_string()],
        });
    }
    if byte_length > MAX_PDF_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "PDF file exceeds the {} MiB safety limit.",
            MAX_PDF_FILE_BYTES / (1024 * 1024)
        )));
    }

    let resource_dir = pdf_session.resource_dir();
    let job = json!({
        "inputFile": path_str,
        "showEncryption": ""
    });
    let out = run_qpdf_job(
        resource_dir.as_deref(),
        &job,
        None,
        DEFAULT_QPDF_TIMEOUT,
        None,
    )?;

    if out.exit_code == QPDF_EXIT_ERROR {
        let (code, msg) = classify_qpdf_error_message(&out.error);
        if code == "PERMISSION_DENIED" {
            return Err(AppError::new(code, msg));
        }
        let status = if code == "PDF_UNSUPPORTED_SECURITY" {
            "unsupported_security"
        } else {
            "corrupt_or_invalid"
        };
        return Ok(PdfSecurityStatus {
            path: path_str,
            file_name,
            byte_length,
            status: status.to_string(),
            is_encrypted: status == "unsupported_security",
            requires_open_password: false,
            has_owner_restrictions: false,
            encryption_revision: None,
            encryption_label: None,
            print_permission: None,
            allow_copy: None,
            allow_modify: None,
            page_count: None,
            has_signatures: false,
            signature_count: 0,
            warnings: vec![msg],
        });
    }

    let parsed = parse_show_encryption_info(&out.info);
    let encryption_label = format_encryption_label(&parsed);
    let print_permission = if parsed.is_encrypted {
        Some(match (parsed.print_high, parsed.print_low) {
            (Some(true), _) => "full".to_string(),
            (_, Some(true)) => "low".to_string(),
            _ => "none".to_string(),
        })
    } else {
        None
    };

    let (status, requires_open_password, has_owner_restrictions) = if !parsed.is_encrypted {
        ("unencrypted".to_string(), false, false)
    } else if parsed.incorrect_empty_password {
        ("encrypted_password_required".to_string(), true, true)
    } else {
        ("encrypted_owner_only".to_string(), false, true)
    };

    let page_count = if !requires_open_password {
        query_page_count_qpdf(resource_dir.as_deref(), &canonical, None).ok()
    } else {
        None
    };

    let struct_flags = if !parsed.is_encrypted {
        inspect_structural_flags_lopdf(&canonical)
    } else {
        Default::default()
    };

    let mut warnings = Vec::new();
    if struct_flags.has_signatures {
        warnings.push(format!(
            "This PDF contains {} digital signature field(s). Encrypting or rewriting the PDF invalidates original cryptographic signatures.",
            struct_flags.signature_count.max(1)
        ));
    }

    Ok(PdfSecurityStatus {
        path: path_str,
        file_name,
        byte_length,
        status,
        is_encrypted: parsed.is_encrypted,
        requires_open_password,
        has_owner_restrictions,
        encryption_revision: parsed.revision,
        encryption_label,
        print_permission,
        allow_copy: parsed.extract_any,
        allow_modify: parsed.modify_anything,
        page_count,
        has_signatures: struct_flags.has_signatures,
        signature_count: struct_flags.signature_count,
        warnings,
    })
}

pub fn encrypt_pdf_impl<F>(
    pdf_session: &PdfSessionManager,
    req: &EncryptPdfRequest,
    task_id: &str,
    cancel: &AtomicBool,
    mut emit_progress: F,
) -> Result<EncryptPdfResult, AppError>
where
    F: FnMut(PdfTaskProgressPayload),
{
    validate_password_input(&req.user_password, "Open password")?;
    let explicit_owner = req
        .owner_password
        .as_deref()
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    if let Some(ref owner) = explicit_owner {
        validate_password_input(owner, "Owner password")?;
    }

    if req.user_password.is_empty() && explicit_owner.is_none() {
        return Err(AppError::invalid_param(
            "Provide an open password or an explicit owner password.",
        ));
    }
    if let Some(ref owner) = explicit_owner {
        if !req.user_password.is_empty() && owner == &req.user_password {
            return Err(AppError::invalid_param(
                "Open password and owner password must be different. Leave owner password blank to generate a strong random owner password automatically.",
            ));
        }
    }

    let print_perm = match req.print_permission.as_str() {
        "none" | "low" | "full" => req.print_permission.as_str(),
        _ => {
            return Err(AppError::invalid_param(
                "Invalid print permission (expected 'none', 'low', or 'full').",
            ))
        }
    };
    let modify_perm = match req.allow_modify.as_str() {
        "none" | "annotate" | "all" => req.allow_modify.as_str(),
        _ => {
            return Err(AppError::invalid_param(
                "Invalid modify permission (expected 'none', 'annotate', or 'all').",
            ))
        }
    };

    let (canonical, byte_length) = validate_existing_input_file(&req.input_path)?;
    if byte_length == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF file is empty (0 bytes).",
        ));
    }
    if byte_length > MAX_PDF_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "PDF file exceeds the {} MiB safety limit.",
            MAX_PDF_FILE_BYTES / (1024 * 1024)
        )));
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P15".to_string(),
        current: 5,
        total: 100,
        percent: 5.0,
        detail: "Inspecting PDF document".to_string(),
    });

    let status = inspect_pdf_security_impl(pdf_session, &canonical.to_string_lossy())?;
    match status.status.as_str() {
        "corrupt_or_invalid" => {
            return Err(AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                "This file is not a valid PDF document or its structure is corrupted.",
            ));
        }
        "unsupported_security" => {
            return Err(AppError::new(
                "PDF_UNSUPPORTED_SECURITY",
                "This PDF uses an unsupported security handler.",
            ));
        }
        "encrypted_password_required" | "encrypted_owner_only" => {
            return Err(AppError::new(
                "PDF_ALREADY_ENCRYPTED",
                "This PDF is already encrypted. Remove existing protection with PDF Decrypt (P16) before re-encrypting.",
            ));
        }
        _ => {}
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (owner_password, used_generated_owner_password) = match explicit_owner {
        Some(pw) => (pw, false),
        None => {
            let mut gen = generate_strong_owner_password();
            while gen == req.user_password {
                gen = generate_strong_owner_password();
            }
            (gen, true)
        }
    };

    let atomic = AtomicPdfOutput::prepare(
        &req.output_path,
        std::slice::from_ref(&canonical),
        req.overwrite,
    )?;

    let mut aes256_opts = serde_json::Map::new();
    aes256_opts.insert("print".to_string(), json!(print_perm));
    aes256_opts.insert(
        "extract".to_string(),
        json!(if req.allow_copy { "y" } else { "n" }),
    );
    aes256_opts.insert("modify".to_string(), json!(modify_perm));
    aes256_opts.insert("accessibility".to_string(), json!("y"));
    if req.encrypt_metadata == Some(false) {
        aes256_opts.insert("cleartextMetadata".to_string(), json!(""));
    }

    let job = json!({
        "inputFile": canonical.to_string_lossy(),
        "outputFile": atomic.temp_path().to_string_lossy(),
        "progress": "",
        "encrypt": {
            "userPassword": req.user_password,
            "ownerPassword": owner_password,
            "256bit": serde_json::Value::Object(aes256_opts),
        }
    });

    let resource_dir = pdf_session.resource_dir();
    let progress_cb = std::cell::RefCell::new(&mut emit_progress);
    let out = run_qpdf_job(
        resource_dir.as_deref(),
        &job,
        Some(cancel),
        DEFAULT_QPDF_TIMEOUT,
        Some(&|pct| {
            let scaled = 10 + ((pct as usize) * 75) / 100;
            (progress_cb.borrow_mut())(PdfTaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "P15".to_string(),
                current: scaled,
                total: 100,
                percent: scaled as f64,
                detail: "Encrypting PDF (AES-256)".to_string(),
            });
        }),
    )?;

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    if out.exit_code == QPDF_EXIT_ERROR {
        let (code, msg) = classify_qpdf_error_message(&out.error);
        return Err(AppError::new(code, msg));
    }

    // Independent post-encryption verification before atomic commit
    (progress_cb.borrow_mut())(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P15".to_string(),
        current: 90,
        total: 100,
        percent: 90.0,
        detail: "Verifying encrypted output".to_string(),
    });

    let verify_show = run_qpdf_job(
        resource_dir.as_deref(),
        &json!({
            "inputFile": atomic.temp_path().to_string_lossy(),
            "showEncryption": ""
        }),
        Some(cancel),
        DEFAULT_QPDF_TIMEOUT,
        None,
    )?;
    let verified_info = parse_show_encryption_info(&verify_show.info);
    if !verified_info.is_encrypted {
        return Err(AppError::new(
            "PDF_ENCRYPT_VERIFY_FAILED",
            "Encrypted output verification failed: file does not carry an encryption dictionary.",
        ));
    }
    let has_open_password = !req.user_password.is_empty();
    if has_open_password && !verified_info.incorrect_empty_password {
        return Err(AppError::new(
            "PDF_ENCRYPT_VERIFY_FAILED",
            "Encrypted output verification failed: empty password unexpectedly opened protected PDF.",
        ));
    }

    let check_pw = if has_open_password {
        req.user_password.as_str()
    } else {
        owner_password.as_str()
    };
    let verified_pages =
        query_page_count_qpdf(resource_dir.as_deref(), atomic.temp_path(), Some(check_pw))?;
    if verified_pages == 0 {
        return Err(AppError::new(
            "PDF_ENCRYPT_VERIFY_FAILED",
            "Encrypted output verification failed: document reported 0 pages.",
        ));
    }

    let (final_path, out_bytes) = atomic.commit_existing_tmp()?;

    (progress_cb.borrow_mut())(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P15".to_string(),
        current: 100,
        total: 100,
        percent: 100.0,
        detail: "Encryption complete".to_string(),
    });

    let mut warnings = status.warnings;
    if used_generated_owner_password {
        warnings.push(
            "A unique random owner password was generated automatically so the PDF does not use an insecure empty owner password."
                .to_string(),
        );
    }

    Ok(EncryptPdfResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_length: out_bytes,
        page_count: verified_pages,
        algorithm: format_encryption_label(&verified_info)
            .unwrap_or_else(|| "AES-256 (PDF 2.0 R6)".to_string()),
        has_open_password,
        used_generated_owner_password,
        print_permission: print_perm.to_string(),
        allow_copy: req.allow_copy,
        allow_modify: modify_perm.to_string(),
        signature_invalidated: status.has_signatures,
        warnings,
    })
}

pub fn decrypt_pdf_impl<F>(
    pdf_session: &PdfSessionManager,
    req: &DecryptPdfRequest,
    task_id: &str,
    cancel: &AtomicBool,
    mut emit_progress: F,
) -> Result<DecryptPdfResult, AppError>
where
    F: FnMut(PdfTaskProgressPayload),
{
    validate_password_input(&req.password, "PDF password")?;
    let (canonical, byte_length) = validate_existing_input_file(&req.input_path)?;
    if byte_length == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF file is empty (0 bytes).",
        ));
    }
    if byte_length > MAX_PDF_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "PDF file exceeds the {} MiB safety limit.",
            MAX_PDF_FILE_BYTES / (1024 * 1024)
        )));
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P16".to_string(),
        current: 5,
        total: 100,
        percent: 5.0,
        detail: "Inspecting PDF encryption status".to_string(),
    });

    let status = inspect_pdf_security_impl(pdf_session, &canonical.to_string_lossy())?;
    match status.status.as_str() {
        "corrupt_or_invalid" => {
            return Err(AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                "This file is not a valid PDF document or its structure is corrupted.",
            ));
        }
        "unsupported_security" => {
            return Err(AppError::new(
                "PDF_UNSUPPORTED_SECURITY",
                "This PDF uses an unsupported security handler.",
            ));
        }
        "unencrypted" => {
            return Err(AppError::new(
                "PDF_NOT_ENCRYPTED",
                "This PDF is not encrypted and does not require password removal.",
            ));
        }
        "encrypted_password_required" if req.password.is_empty() => {
            return Err(AppError::new(
                "PDF_PASSWORD_REQUIRED",
                "Enter the known password for this PDF to export an unlocked copy.",
            ));
        }
        _ => {}
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let atomic = AtomicPdfOutput::prepare(
        &req.output_path,
        std::slice::from_ref(&canonical),
        req.overwrite,
    )?;

    let mut job = serde_json::Map::new();
    job.insert("inputFile".to_string(), json!(canonical.to_string_lossy()));
    job.insert(
        "outputFile".to_string(),
        json!(atomic.temp_path().to_string_lossy()),
    );
    job.insert("decrypt".to_string(), json!(""));
    job.insert("progress".to_string(), json!(""));
    if !req.password.is_empty() {
        job.insert("password".to_string(), json!(req.password));
    }

    let resource_dir = pdf_session.resource_dir();
    let progress_cb = std::cell::RefCell::new(&mut emit_progress);
    let out = run_qpdf_job(
        resource_dir.as_deref(),
        &serde_json::Value::Object(job),
        Some(cancel),
        DEFAULT_QPDF_TIMEOUT,
        Some(&|pct| {
            let scaled = 10 + ((pct as usize) * 70) / 100;
            (progress_cb.borrow_mut())(PdfTaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "P16".to_string(),
                current: scaled,
                total: 100,
                percent: scaled as f64,
                detail: "Decrypting PDF".to_string(),
            });
        }),
    )?;

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    if out.exit_code == QPDF_EXIT_ERROR {
        let (code, msg) = classify_qpdf_error_message(&out.error);
        return Err(AppError::new(code, msg));
    }

    // Independently verify decrypted output BEFORE atomic commit:
    // 1. QPDF confirms zero encryption dictionary remains.
    // 2. PDFium opens the unlocked file with EMPTY password and validates page count & text layer.
    (progress_cb.borrow_mut())(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P16".to_string(),
        current: 86,
        total: 100,
        percent: 86.0,
        detail: "Verifying unlocked PDF opens without password".to_string(),
    });

    let verify_qpdf = run_qpdf_job(
        resource_dir.as_deref(),
        &json!({
            "inputFile": atomic.temp_path().to_string_lossy(),
            "showEncryption": ""
        }),
        Some(cancel),
        DEFAULT_QPDF_TIMEOUT,
        None,
    )?;
    let verify_parsed = parse_show_encryption_info(&verify_qpdf.info);
    if verify_parsed.is_encrypted {
        return Err(AppError::new(
            "PDF_DECRYPT_VERIFY_FAILED",
            "Decrypted output verification failed: file still reports encryption.",
        ));
    }

    let pdfium_info = inspect_with_pdfium(resource_dir.as_deref(), atomic.temp_path())?;
    if pdfium_info.page_count == 0 {
        return Err(AppError::new(
            "PDF_DECRYPT_VERIFY_FAILED",
            "Decrypted output verification failed: PDFium reported 0 pages.",
        ));
    }

    let (final_path, out_bytes) = atomic.commit_existing_tmp()?;

    (progress_cb.borrow_mut())(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P16".to_string(),
        current: 100,
        total: 100,
        percent: 100.0,
        detail: "Decryption complete".to_string(),
    });

    let mut warnings = pdfium_info.warnings;
    if !out.warn.trim().is_empty() {
        warnings.push(
            "The source PDF had minor structural warnings that were normalized in the unlocked copy."
                .to_string(),
        );
    }

    Ok(DecryptPdfResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_length: out_bytes,
        page_count: pdfium_info.page_count,
        original_encryption: status.encryption_label,
        verified_open_without_password: true,
        has_text_layer: pdfium_info.has_text_layer,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_pdfium::extract_page_text_with_pdfium;
    use lopdf::{dictionary, Document, Object, Stream};
    use tempfile::tempdir;

    fn build_sample_text_pdf(path: &Path) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content = b"BT /F1 18 Tf 72 720 Td (WinKit Phase 5B Crypto Sample) Tj ET";
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).expect("save sample pdf");
    }

    #[test]
    fn p15_and_p16_roundtrip_unicode_symbols_wrong_password_and_legacy_ciphers() {
        let dir = tempdir().expect("tempdir");
        let session = PdfSessionManager::default();
        let src = dir.path().join("原始 测试.pdf");
        build_sample_text_pdf(&src);
        let cancel = AtomicBool::new(false);

        // 1. Inspect plain PDF
        let plain_status = inspect_pdf_security_impl(&session, &src.to_string_lossy()).unwrap();
        assert_eq!(plain_status.status, "unencrypted");
        assert!(!plain_status.is_encrypted);
        assert_eq!(plain_status.page_count, Some(1));

        // 2. Reject decrypting an unencrypted PDF cleanly
        let dec_plain_err = decrypt_pdf_impl(
            &session,
            &DecryptPdfRequest {
                input_path: src.to_string_lossy().into_owned(),
                output_path: dir.path().join("nope.pdf").to_string_lossy().into_owned(),
                overwrite: false,
                password: "any".to_string(),
            },
            "t0",
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(dec_plain_err.code, "PDF_NOT_ENCRYPTED");

        // 3. Encrypt with Chinese + emoji + spaces + quotes + shell symbols (auto random owner pw)
        let unicode_pw = " 中文密码🔐 P@ss!#$%^&*()[]\"' --flag ";
        let enc_path = dir.path().join("加密 输出.pdf");
        let enc_res = encrypt_pdf_impl(
            &session,
            &EncryptPdfRequest {
                input_path: src.to_string_lossy().into_owned(),
                output_path: enc_path.to_string_lossy().into_owned(),
                overwrite: false,
                user_password: unicode_pw.to_string(),
                owner_password: None,
                print_permission: "low".to_string(),
                allow_copy: false,
                allow_modify: "none".to_string(),
                encrypt_metadata: Some(true),
            },
            "t1",
            &cancel,
            |_| {},
        )
        .expect("encrypt AES-256 with unicode password");

        assert!(enc_res.has_open_password);
        assert!(enc_res.used_generated_owner_password);
        assert!(enc_res.algorithm.contains("AES-256"));
        assert_eq!(enc_res.page_count, 1);

        // Ensure Debug redacts password
        let dbg_str = format!(
            "{:?}",
            EncryptPdfRequest {
                input_path: "a.pdf".into(),
                output_path: "b.pdf".into(),
                overwrite: false,
                user_password: "SUPER_SECRET_123".into(),
                owner_password: Some("OWNER_SECRET_456".into()),
                print_permission: "none".into(),
                allow_copy: false,
                allow_modify: "none".into(),
                encrypt_metadata: None,
            }
        );
        assert!(!dbg_str.contains("SUPER_SECRET_123"));
        assert!(!dbg_str.contains("OWNER_SECRET_456"));

        // 4. Inspect encrypted PDF & confirm PDFium returns PDF_PASSWORD_REQUIRED (not corrupt!)
        let enc_status = inspect_pdf_security_impl(&session, &enc_path.to_string_lossy()).unwrap();
        assert_eq!(enc_status.status, "encrypted_password_required");
        assert!(enc_status.is_encrypted);
        assert!(enc_status.requires_open_password);
        assert_eq!(enc_status.print_permission.as_deref(), Some("low"));
        assert_eq!(enc_status.allow_copy, Some(false));

        let pdfium_locked = inspect_with_pdfium(None, &enc_path).unwrap_err();
        assert_eq!(pdfium_locked.code, "PDF_PASSWORD_REQUIRED");

        // 5. Reject wrong password cleanly (NEVER corrupt!) and verify error never leaks password
        let wrong_out = dir.path().join("wrong_out.pdf");
        let wrong_err = decrypt_pdf_impl(
            &session,
            &DecryptPdfRequest {
                input_path: enc_path.to_string_lossy().into_owned(),
                output_path: wrong_out.to_string_lossy().into_owned(),
                overwrite: false,
                password: "WRONG_SECRET_PASSWORD".to_string(),
            },
            "t2",
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(wrong_err.code, "PDF_WRONG_PASSWORD");
        assert!(!wrong_err.message.contains("WRONG_SECRET_PASSWORD"));
        assert!(!wrong_out.exists());

        // 6. Reject empty password on open-password-protected PDF
        let empty_err = decrypt_pdf_impl(
            &session,
            &DecryptPdfRequest {
                input_path: enc_path.to_string_lossy().into_owned(),
                output_path: wrong_out.to_string_lossy().into_owned(),
                overwrite: false,
                password: String::new(),
            },
            "t3",
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(empty_err.code, "PDF_PASSWORD_REQUIRED");

        // 7. Decrypt with exact Unicode password and verify text preserved + opens without password
        let dec_path = dir.path().join("解密 输出.pdf");
        let dec_res = decrypt_pdf_impl(
            &session,
            &DecryptPdfRequest {
                input_path: enc_path.to_string_lossy().into_owned(),
                output_path: dec_path.to_string_lossy().into_owned(),
                overwrite: false,
                password: unicode_pw.to_string(),
            },
            "t4",
            &cancel,
            |_| {},
        )
        .expect("decrypt with unicode password");
        assert!(dec_res.verified_open_without_password);
        assert_eq!(dec_res.page_count, 1);
        assert!(dec_res.has_text_layer);

        let text = extract_page_text_with_pdfium(None, &dec_path, 1).unwrap();
        assert!(
            text.full_text.contains("WinKit Phase 5B Crypto Sample"),
            "Decrypted text mismatch: {}",
            text.full_text
        );

        // 8. Verify legacy RC4-128 & AES-128 decryption compatibility
        for (label, extra) in [
            ("rc4_128", json!({"128bit": {"useAes": "n"}})),
            ("aes_128", json!({"128bit": {"useAes": "y"}})),
        ] {
            let legacy_enc = dir.path().join(format!("{label}.pdf"));
            let legacy_dec = dir.path().join(format!("{label}_dec.pdf"));
            let mut enc_obj = extra.as_object().unwrap().clone();
            enc_obj.insert("userPassword".to_string(), json!("Legacy#2026"));
            enc_obj.insert("ownerPassword".to_string(), json!("LegacyOwner#2026"));
            let create_job = json!({
                "inputFile": src.to_string_lossy(),
                "outputFile": legacy_enc.to_string_lossy(),
                "allowWeakCrypto": "",
                "encrypt": serde_json::Value::Object(enc_obj)
            });
            let r = run_qpdf_job(None, &create_job, None, DEFAULT_QPDF_TIMEOUT, None).unwrap();
            assert_eq!(
                r.exit_code, QPDF_EXIT_SUCCESS,
                "create {label}: {}",
                r.error
            );

            let res = decrypt_pdf_impl(
                &session,
                &DecryptPdfRequest {
                    input_path: legacy_enc.to_string_lossy().into_owned(),
                    output_path: legacy_dec.to_string_lossy().into_owned(),
                    overwrite: false,
                    password: "Legacy#2026".to_string(),
                },
                "t_leg",
                &cancel,
                |_| {},
            )
            .expect("decrypt legacy PDF");
            assert!(res.verified_open_without_password);
            assert_eq!(res.page_count, 1);
        }

        // 9. Verify corrupt non-PDF classification (never confused with wrong password)
        let bad_pdf = dir.path().join("corrupt.pdf");
        std::fs::write(&bad_pdf, b"This is definitely not a PDF file").unwrap();
        let bad_status = inspect_pdf_security_impl(&session, &bad_pdf.to_string_lossy()).unwrap();
        assert_eq!(bad_status.status, "corrupt_or_invalid");
        let bad_dec = decrypt_pdf_impl(
            &session,
            &DecryptPdfRequest {
                input_path: bad_pdf.to_string_lossy().into_owned(),
                output_path: dir
                    .path()
                    .join("bad_out.pdf")
                    .to_string_lossy()
                    .into_owned(),
                overwrite: false,
                password: "pw".to_string(),
            },
            "t_bad",
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(bad_dec.code, "PDF_CORRUPT_OR_INVALID");
    }

    #[test]
    fn p15_rejects_same_user_and_owner_password_and_allows_owner_only_unlock() {
        let dir = tempdir().expect("tempdir");
        let session = PdfSessionManager::default();
        let src = dir.path().join("sample.pdf");
        build_sample_text_pdf(&src);
        let cancel = AtomicBool::new(false);

        let same_err = encrypt_pdf_impl(
            &session,
            &EncryptPdfRequest {
                input_path: src.to_string_lossy().into_owned(),
                output_path: dir.path().join("out.pdf").to_string_lossy().into_owned(),
                overwrite: false,
                user_password: "SamePassword123".to_string(),
                owner_password: Some("SamePassword123".to_string()),
                print_permission: "full".to_string(),
                allow_copy: true,
                allow_modify: "all".to_string(),
                encrypt_metadata: Some(true),
            },
            "t_same",
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(same_err.code, "INVALID_PARAMETER");

        // Owner-only protection (no open password, only permissions)
        let owner_only_path = dir.path().join("owner_only.pdf");
        let enc = encrypt_pdf_impl(
            &session,
            &EncryptPdfRequest {
                input_path: src.to_string_lossy().into_owned(),
                output_path: owner_only_path.to_string_lossy().into_owned(),
                overwrite: false,
                user_password: String::new(),
                owner_password: Some("OwnerOnly#2026".to_string()),
                print_permission: "none".to_string(),
                allow_copy: false,
                allow_modify: "none".to_string(),
                encrypt_metadata: Some(true),
            },
            "t_owner",
            &cancel,
            |_| {},
        )
        .expect("encrypt owner-only");
        assert!(!enc.has_open_password);
        assert!(!enc.used_generated_owner_password);

        let st = inspect_pdf_security_impl(&session, &owner_only_path.to_string_lossy()).unwrap();
        assert_eq!(st.status, "encrypted_owner_only");
        assert!(!st.requires_open_password);
        assert!(st.has_owner_restrictions);

        // Unlock owner-only PDF with owner password
        let unlocked = dir.path().join("owner_unlocked.pdf");
        let dec = decrypt_pdf_impl(
            &session,
            &DecryptPdfRequest {
                input_path: owner_only_path.to_string_lossy().into_owned(),
                output_path: unlocked.to_string_lossy().into_owned(),
                overwrite: false,
                password: "OwnerOnly#2026".to_string(),
            },
            "t_owner_dec",
            &cancel,
            |_| {},
        )
        .expect("unlock owner-only PDF");
        assert!(dec.verified_open_without_password);
        assert_eq!(dec.page_count, 1);
    }
}
