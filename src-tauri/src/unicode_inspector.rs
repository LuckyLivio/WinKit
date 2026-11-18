use crate::error::AppError;
use serde::{Deserialize, Serialize};
use unicode_general_category::{get_general_category, GeneralCategory};
use unicode_script::{Script, UnicodeScript};
use unicode_security::confusable_detection::skeleton;
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_UNICODE_TEXT_BYTES: usize = 512 * 1024; // 512 KiB
pub const MAX_UNICODE_CODE_POINTS: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnicodeAttentionFlag {
    Bom,
    ZeroWidth,
    JoinerOrVariationSelector,
    BidiControl,
    SpecialWhitespace,
    ControlChar,
    CombiningMark,
    PotentialConfusable,
    PrivateOrUnassigned,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnicodeCodePointEntry {
    pub code_point_index: usize,
    pub utf16_offset: usize,
    pub utf16_length: usize,
    pub grapheme_index: usize,
    pub scalar_value: u32,
    pub code_point_hex: String,
    pub display_glyph: String,
    pub name: String,
    pub general_category: String,
    pub script: String,
    pub utf8_bytes_hex: String,
    pub flags: Vec<UnicodeAttentionFlag>,
    pub is_attention_item: bool,
    pub confusable_prototype: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnicodeSanitizeOptions {
    pub remove_bom: bool,
    pub remove_zero_width: bool,
    pub normalize_special_spaces: bool,
    pub remove_c0_c1_controls: bool,
    pub remove_bidi_controls: bool,
    pub remove_joiners_and_vs: bool,
    pub replace_confusables: bool,
}

impl Default for UnicodeSanitizeOptions {
    fn default() -> Self {
        Self {
            remove_bom: true,
            remove_zero_width: true,
            normalize_special_spaces: true,
            remove_c0_c1_controls: true,
            remove_bidi_controls: false,
            remove_joiners_and_vs: false,
            replace_confusables: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizeChangePreview {
    pub code_point_index: usize,
    pub utf16_offset: usize,
    pub code_point_hex: String,
    pub original_label: String,
    pub action: &'static str,
    pub replacement_label: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnicodeInspectSummary {
    pub unicode_version: String,
    pub total_code_points: usize,
    pub total_utf16_units: usize,
    pub total_graphemes: usize,
    pub total_utf8_bytes: usize,
    pub attention_count: usize,
    pub zero_width_count: usize,
    pub bidi_control_count: usize,
    pub special_whitespace_count: usize,
    pub confusable_count: usize,
    pub joiner_or_vs_count: usize,
    pub combining_mark_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnicodeInspectionResponse {
    pub summary: UnicodeInspectSummary,
    pub entries: Vec<UnicodeCodePointEntry>,
    pub sanitized_text: String,
    pub changes: Vec<SanitizeChangePreview>,
    pub changes_truncated: bool,
    pub total_change_count: usize,
}

const MAX_PREVIEW_CHANGES: usize = 500;

fn is_unicode_noncharacter(u: u32) -> bool {
    (0xFDD0..=0xFDEF).contains(&u) || (u & 0xFFFE) == 0xFFFE && (u <= 0x10FFFF)
}

fn c0_c1_control_alias(u: u32) -> Option<&'static str> {
    match u {
        0x0000 => Some("NULL"),
        0x0001 => Some("START OF HEADING"),
        0x0002 => Some("START OF TEXT"),
        0x0003 => Some("END OF TEXT"),
        0x0004 => Some("END OF TRANSMISSION"),
        0x0005 => Some("ENQUIRY"),
        0x0006 => Some("ACKNOWLEDGE"),
        0x0007 => Some("BELL"),
        0x0008 => Some("BACKSPACE"),
        0x0009 => Some("CHARACTER TABULATION"),
        0x000A => Some("LINE FEED"),
        0x000B => Some("LINE TABULATION"),
        0x000C => Some("FORM FEED"),
        0x000D => Some("CARRIAGE RETURN"),
        0x000E => Some("SHIFT OUT"),
        0x000F => Some("SHIFT IN"),
        0x0010 => Some("DATA LINK ESCAPE"),
        0x0011 => Some("DEVICE CONTROL ONE"),
        0x0012 => Some("DEVICE CONTROL TWO"),
        0x0013 => Some("DEVICE CONTROL THREE"),
        0x0014 => Some("DEVICE CONTROL FOUR"),
        0x0015 => Some("NEGATIVE ACKNOWLEDGE"),
        0x0016 => Some("SYNCHRONOUS IDLE"),
        0x0017 => Some("END OF TRANSMISSION BLOCK"),
        0x0018 => Some("CANCEL"),
        0x0019 => Some("END OF MEDIUM"),
        0x001A => Some("SUBSTITUTE"),
        0x001B => Some("ESCAPE"),
        0x001C => Some("INFORMATION SEPARATOR FOUR"),
        0x001D => Some("INFORMATION SEPARATOR THREE"),
        0x001E => Some("INFORMATION SEPARATOR TWO"),
        0x001F => Some("INFORMATION SEPARATOR ONE"),
        0x007F => Some("DELETE"),
        0x0085 => Some("NEXT LINE"),
        _ if (0x0080..=0x009F).contains(&u) => Some("C1 CONTROL"),
        _ => None,
    }
}

fn format_code_point_hex(u: u32) -> String {
    format!("U+{u:04X}")
}

fn resolve_official_name_or_label(ch: char, cat: GeneralCategory) -> String {
    let u = ch as u32;
    if let Some(name) = unicode_names2::name(ch) {
        return name.to_string();
    }
    if let Some(alias) = c0_c1_control_alias(u) {
        return format!("<control-{u:04X}> ({alias})");
    }
    if cat == GeneralCategory::PrivateUse {
        return format!("<private-use-{u:04X}>");
    }
    if is_unicode_noncharacter(u) {
        return format!("<noncharacter-{u:04X}>");
    }
    if cat == GeneralCategory::Unassigned {
        return format!("<reserved-{u:04X}>");
    }
    format!("<code-point-{u:04X}>")
}

fn format_general_category(cat: GeneralCategory) -> &'static str {
    match cat {
        GeneralCategory::UppercaseLetter => "Lu · Uppercase_Letter",
        GeneralCategory::LowercaseLetter => "Ll · Lowercase_Letter",
        GeneralCategory::TitlecaseLetter => "Lt · Titlecase_Letter",
        GeneralCategory::ModifierLetter => "Lm · Modifier_Letter",
        GeneralCategory::OtherLetter => "Lo · Other_Letter",
        GeneralCategory::NonspacingMark => "Mn · Nonspacing_Mark",
        GeneralCategory::SpacingMark => "Mc · Spacing_Mark",
        GeneralCategory::EnclosingMark => "Me · Enclosing_Mark",
        GeneralCategory::DecimalNumber => "Nd · Decimal_Number",
        GeneralCategory::LetterNumber => "Nl · Letter_Number",
        GeneralCategory::OtherNumber => "No · Other_Number",
        GeneralCategory::ConnectorPunctuation => "Pc · Connector_Punctuation",
        GeneralCategory::DashPunctuation => "Pd · Dash_Punctuation",
        GeneralCategory::OpenPunctuation => "Ps · Open_Punctuation",
        GeneralCategory::ClosePunctuation => "Pe · Close_Punctuation",
        GeneralCategory::InitialPunctuation => "Pi · Initial_Punctuation",
        GeneralCategory::FinalPunctuation => "Pf · Final_Punctuation",
        GeneralCategory::OtherPunctuation => "Po · Other_Punctuation",
        GeneralCategory::MathSymbol => "Sm · Math_Symbol",
        GeneralCategory::CurrencySymbol => "Sc · Currency_Symbol",
        GeneralCategory::ModifierSymbol => "Sk · Modifier_Symbol",
        GeneralCategory::OtherSymbol => "So · Other_Symbol",
        GeneralCategory::SpaceSeparator => "Zs · Space_Separator",
        GeneralCategory::LineSeparator => "Zl · Line_Separator",
        GeneralCategory::ParagraphSeparator => "Zp · Paragraph_Separator",
        GeneralCategory::Control => "Cc · Control",
        GeneralCategory::Format => "Cf · Format",
        GeneralCategory::Surrogate => "Cs · Surrogate",
        GeneralCategory::PrivateUse => "Co · Private_Use",
        GeneralCategory::Unassigned => "Cn · Unassigned",
        _ => "Other",
    }
}

fn is_bidi_control(u: u32) -> bool {
    matches!(
        u,
        0x061C | 0x200E | 0x200F | 0x202A..=0x202E | 0x2066..=0x2069
    )
}

fn is_joiner_or_variation_selector(u: u32) -> bool {
    matches!(
        u,
        0x200C | 0x200D | 0xFE00..=0xFE0F | 0xE0100..=0xE01EF
    )
}

fn is_non_joiner_zero_width(u: u32, cat: GeneralCategory) -> bool {
    if u == 0xFEFF || is_bidi_control(u) || is_joiner_or_variation_selector(u) {
        return false;
    }
    matches!(
        u,
        0x00AD | 0x034F | 0x180E | 0x200B | 0x2060 | 0x2061..=0x2064
    ) || cat == GeneralCategory::Format
}

fn is_special_non_ascii_whitespace(u: u32, cat: GeneralCategory) -> bool {
    if u <= 0x007F {
        return false;
    }
    matches!(
        cat,
        GeneralCategory::SpaceSeparator
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
    ) || u == 0x0085
}

fn is_combining_mark(cat: GeneralCategory) -> bool {
    matches!(
        cat,
        GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    )
}

fn format_visible_glyph(ch: char, cat: GeneralCategory) -> String {
    let u = ch as u32;
    match u {
        0x0009 => "[TAB]".to_string(),
        0x000A => "[LF]".to_string(),
        0x000D => "[CR]".to_string(),
        0x0020 => "[SP]".to_string(),
        0x00A0 => "[NBSP]".to_string(),
        0x00AD => "[SHY]".to_string(),
        0x061C => "[ALM]".to_string(),
        0x200B => "[ZWSP]".to_string(),
        0x200C => "[ZWNJ]".to_string(),
        0x200D => "[ZWJ]".to_string(),
        0x200E => "[LRM]".to_string(),
        0x200F => "[RLM]".to_string(),
        0x2028 => "[LSEP]".to_string(),
        0x2029 => "[PSEP]".to_string(),
        0x202A => "[LRE]".to_string(),
        0x202B => "[RLE]".to_string(),
        0x202C => "[PDF]".to_string(),
        0x202D => "[LRO]".to_string(),
        0x202E => "[RLO]".to_string(),
        0x202F => "[NNBSP]".to_string(),
        0x2060 => "[WJ]".to_string(),
        0x2066 => "[LRI]".to_string(),
        0x2067 => "[RLI]".to_string(),
        0x2068 => "[FSI]".to_string(),
        0x2069 => "[PDI]".to_string(),
        0x3000 => "[IDSP]".to_string(),
        0xFEFF => "[BOM]".to_string(),
        0xFE00..=0xFE0F => format!("[VS{}]", u - 0xFE00 + 1),
        0xE0100..=0xE01EF => format!("[VS{}]", u - 0xE0100 + 17),
        _ if cat == GeneralCategory::Control => format!("[CTRL {:02X}]", u),
        _ if is_special_non_ascii_whitespace(u, cat) => format!("[WS {:04X}]", u),
        _ if cat == GeneralCategory::Format => format!("[FMT {:04X}]", u),
        _ if cat == GeneralCategory::Unassigned || is_unicode_noncharacter(u) => {
            format!("[{:04X}]", u)
        }
        _ if is_combining_mark(cat) => format!("\u{25CC}{ch}"),
        _ => ch.to_string(),
    }
}

/// Uses UTS #39 `skeleton(c)` to identify non-ASCII characters whose UTS #39 visual prototype
/// resolves cleanly to printable ASCII (e.g. Cyrillic 'а' U+0430 -> 'a' U+0061, Greek ';' -> ';').
/// Precomposed accented Latin letters ('é' -> 'e' + U+0301) retain non-ASCII marks in `skeleton`
/// and are therefore NOT misclassified as ASCII confusables.
fn detect_uts39_ascii_confusable(ch: char, cat: GeneralCategory) -> Option<(String, String)> {
    if ch.is_ascii() {
        return None;
    }
    let u = ch as u32;
    if u == 0xFEFF
        || is_bidi_control(u)
        || is_joiner_or_variation_selector(u)
        || is_special_non_ascii_whitespace(u, cat)
        || is_combining_mark(cat)
        || matches!(
            cat,
            GeneralCategory::Control
                | GeneralCategory::Format
                | GeneralCategory::PrivateUse
                | GeneralCategory::Unassigned
        )
    {
        return None;
    }

    let mut ch_buf = [0u8; 4];
    let s = ch.encode_utf8(&mut ch_buf);
    let skel: String = skeleton(s).collect();
    if skel.is_empty() || skel.len() > 4 {
        return None;
    }
    if !skel.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return None;
    }

    let hex_codes: Vec<String> = skel
        .chars()
        .map(|c| format!("U+{:04X}", c as u32))
        .collect();
    let label = format!("'{}' ({})", skel, hex_codes.join(" "));
    Some((skel, label))
}

fn encode_utf8_hex(ch: char) -> String {
    let mut buf = [0u8; 4];
    let slice = ch.encode_utf8(&mut buf).as_bytes();
    slice
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn inspect_and_sanitize_unicode(
    text: &str,
    options: &UnicodeSanitizeOptions,
) -> Result<UnicodeInspectionResponse, AppError> {
    if text.len() > MAX_UNICODE_TEXT_BYTES {
        return Err(AppError::size_limit(format!(
            "Input exceeds the 512 KB Unicode inspection limit ({} bytes).",
            text.len()
        )));
    }

    let char_count = text.chars().count();
    if char_count > MAX_UNICODE_CODE_POINTS {
        return Err(AppError::size_limit(format!(
            "Input exceeds the {} code-point inspection limit ({} code points).",
            MAX_UNICODE_CODE_POINTS, char_count
        )));
    }

    // Build byte-offset -> grapheme_index lookup via UAX #29 extended grapheme clusters
    let mut grapheme_ends: Vec<usize> = Vec::new();
    for (byte_start, cluster) in text.grapheme_indices(true) {
        grapheme_ends.push(byte_start + cluster.len());
    }

    let mut entries = Vec::with_capacity(char_count);
    let mut sanitized = String::with_capacity(text.len());
    let mut changes = Vec::new();
    let mut total_change_count = 0usize;

    let mut utf16_offset = 0usize;
    let mut grapheme_idx = 0usize;

    let mut attention_count = 0usize;
    let mut zero_width_count = 0usize;
    let mut bidi_control_count = 0usize;
    let mut special_whitespace_count = 0usize;
    let mut confusable_count = 0usize;
    let mut joiner_or_vs_count = 0usize;
    let mut combining_mark_count = 0usize;

    for (cp_idx, (byte_idx, ch)) in text.char_indices().enumerate() {
        while grapheme_idx + 1 < grapheme_ends.len() && byte_idx >= grapheme_ends[grapheme_idx] {
            grapheme_idx += 1;
        }

        let u = ch as u32;
        let utf16_len = ch.len_utf16();
        let cat = get_general_category(ch);
        let script: Script = ch.script();
        let code_point_hex = format_code_point_hex(u);
        let display_glyph = format_visible_glyph(ch, cat);
        let name = resolve_official_name_or_label(ch, cat);

        let mut flags = Vec::new();
        let mut confusable_ascii: Option<String> = None;
        let mut confusable_prototype: Option<String> = None;

        if u == 0xFEFF {
            flags.push(UnicodeAttentionFlag::Bom);
        }
        if is_bidi_control(u) {
            flags.push(UnicodeAttentionFlag::BidiControl);
            bidi_control_count += 1;
        }
        if is_joiner_or_variation_selector(u) {
            flags.push(UnicodeAttentionFlag::JoinerOrVariationSelector);
            joiner_or_vs_count += 1;
        }
        if is_non_joiner_zero_width(u, cat) {
            flags.push(UnicodeAttentionFlag::ZeroWidth);
            zero_width_count += 1;
        }
        if is_special_non_ascii_whitespace(u, cat) {
            flags.push(UnicodeAttentionFlag::SpecialWhitespace);
            special_whitespace_count += 1;
        }
        let is_non_standard_control =
            cat == GeneralCategory::Control && !matches!(u, 0x0009 | 0x000A | 0x000D);
        if is_non_standard_control {
            flags.push(UnicodeAttentionFlag::ControlChar);
        }
        if is_combining_mark(cat) {
            flags.push(UnicodeAttentionFlag::CombiningMark);
            combining_mark_count += 1;
        }
        if matches!(
            cat,
            GeneralCategory::PrivateUse | GeneralCategory::Unassigned
        ) || is_unicode_noncharacter(u)
        {
            flags.push(UnicodeAttentionFlag::PrivateOrUnassigned);
        }
        if let Some((ascii_target, proto_label)) = detect_uts39_ascii_confusable(ch, cat) {
            flags.push(UnicodeAttentionFlag::PotentialConfusable);
            confusable_count += 1;
            confusable_ascii = Some(ascii_target);
            confusable_prototype = Some(proto_label);
        }

        let is_attention_item = !flags.is_empty();
        if is_attention_item {
            attention_count += 1;
        }

        // Apply non-destructive previewable sanitizer rules
        let mut record_change = |action: &'static str, rep_label: String, reason: &'static str| {
            total_change_count += 1;
            if changes.len() < MAX_PREVIEW_CHANGES {
                changes.push(SanitizeChangePreview {
                    code_point_index: cp_idx,
                    utf16_offset,
                    code_point_hex: code_point_hex.clone(),
                    original_label: display_glyph.clone(),
                    action,
                    replacement_label: rep_label,
                    reason,
                });
            }
        };

        if u == 0xFEFF && options.remove_bom {
            record_change("removed", String::new(), "bom");
        } else if is_bidi_control(u) && options.remove_bidi_controls {
            record_change("removed", String::new(), "bidi_control");
        } else if is_joiner_or_variation_selector(u) && options.remove_joiners_and_vs {
            record_change("removed", String::new(), "joiner_or_vs");
        } else if is_non_joiner_zero_width(u, cat) && options.remove_zero_width {
            record_change("removed", String::new(), "zero_width");
        } else if is_non_standard_control && options.remove_c0_c1_controls {
            record_change("removed", String::new(), "control_char");
        } else if is_special_non_ascii_whitespace(u, cat) && options.normalize_special_spaces {
            if matches!(u, 0x2028 | 0x2029 | 0x0085) {
                sanitized.push('\n');
                record_change("replaced", "[LF]".to_string(), "special_whitespace");
            } else {
                sanitized.push(' ');
                record_change("replaced", "[SP]".to_string(), "special_whitespace");
            }
        } else if options.replace_confusables && confusable_ascii.is_some() {
            let ascii_rep = confusable_ascii.as_deref().unwrap_or("");
            sanitized.push_str(ascii_rep);
            record_change("replaced", ascii_rep.to_string(), "confusable");
        } else {
            sanitized.push(ch);
        }

        entries.push(UnicodeCodePointEntry {
            code_point_index: cp_idx,
            utf16_offset,
            utf16_length: utf16_len,
            grapheme_index: grapheme_idx,
            scalar_value: u,
            code_point_hex,
            display_glyph,
            name,
            general_category: format_general_category(cat).to_string(),
            script: format!("{script:?}"),
            utf8_bytes_hex: encode_utf8_hex(ch),
            flags,
            is_attention_item,
            confusable_prototype,
        });

        utf16_offset += utf16_len;
    }

    let (maj, min, pat) = unicode_general_category::UNICODE_VERSION;
    let summary = UnicodeInspectSummary {
        unicode_version: format!("{maj}.{min}.{pat}"),
        total_code_points: entries.len(),
        total_utf16_units: utf16_offset,
        total_graphemes: grapheme_ends.len(),
        total_utf8_bytes: text.len(),
        attention_count,
        zero_width_count,
        bidi_control_count,
        special_whitespace_count,
        confusable_count,
        joiner_or_vs_count,
        combining_mark_count,
    };

    Ok(UnicodeInspectionResponse {
        summary,
        entries,
        sanitized_text: sanitized,
        changes_truncated: total_change_count > MAX_PREVIEW_CHANGES,
        total_change_count,
        changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_official_names_offsets_graphemes_and_attention_categories_accurately() {
        // Covers: leading BOM, Latin 'a', Cyrillic 'а' (U+0430), CJK '中', Hangul '한',
        // NBSP, ZWSP, mid BOM, RLO (U+202E), combining acute (e + U+0301), PUA U+E000, unassigned U+0378
        let sample =
            "\u{FEFF}a\u{0430}中한\u{00A0}\u{200B}\u{FEFF}\u{202E}e\u{0301}\u{E000}\u{0378}";
        let res = inspect_and_sanitize_unicode(sample, &UnicodeSanitizeOptions::default())
            .expect("inspect");

        assert_eq!(res.summary.unicode_version, "16.0.0");
        assert_eq!(res.entries[0].code_point_hex, "U+FEFF");
        assert!(res.entries[0].flags.contains(&UnicodeAttentionFlag::Bom));

        // Latin 'a' (U+0061) vs Cyrillic 'а' (U+0430)
        assert_eq!(res.entries[1].name, "LATIN SMALL LETTER A");
        assert!(!res.entries[1].is_attention_item);

        assert_eq!(res.entries[2].code_point_hex, "U+0430");
        assert_eq!(res.entries[2].name, "CYRILLIC SMALL LETTER A");
        assert!(res.entries[2]
            .flags
            .contains(&UnicodeAttentionFlag::PotentialConfusable));
        assert_eq!(
            res.entries[2].confusable_prototype.as_deref(),
            Some("'a' (U+0061)")
        );

        // CJK & Hangul algorithmic/UCD names + exact UTF-8 hex
        assert_eq!(res.entries[3].name, "CJK UNIFIED IDEOGRAPH-4E2D");
        assert_eq!(res.entries[3].utf8_bytes_hex, "E4 B8 AD");
        assert_eq!(res.entries[4].name, "HANGUL SYLLABLE HAN");

        // NBSP, ZWSP, mid-BOM, RLO
        assert!(res.entries[5]
            .flags
            .contains(&UnicodeAttentionFlag::SpecialWhitespace));
        assert!(res.entries[6]
            .flags
            .contains(&UnicodeAttentionFlag::ZeroWidth));
        assert!(res.entries[7].flags.contains(&UnicodeAttentionFlag::Bom));
        assert!(res.entries[8]
            .flags
            .contains(&UnicodeAttentionFlag::BidiControl));

        // Combining sequence 'e' + U+0301 shares grapheme_index!
        assert_eq!(
            res.entries[9].grapheme_index,
            res.entries[10].grapheme_index
        );
        assert!(res.entries[10]
            .flags
            .contains(&UnicodeAttentionFlag::CombiningMark));

        // Private Use & Unassigned never fabricate fake names
        assert_eq!(res.entries[11].name, "<private-use-E000>");
        assert_eq!(res.entries[12].name, "<reserved-0378>");
    }

    #[test]
    fn default_sanitizer_preserves_zwj_family_emoji_combining_marks_and_persian_zwnj() {
        // Family emoji 👨‍👩‍👧‍👦 (7 code points, 11 UTF-16 units, 1 grapheme) + Persian "می‌خواهم" (contains U+200C ZWNJ)
        let emoji_and_persian = "\u{FEFF}👨‍👩‍👧‍👦\u{200B}\u{00A0}می\u{200C}خواهم\n";
        let default_opts = UnicodeSanitizeOptions::default();
        let res = inspect_and_sanitize_unicode(emoji_and_persian, &default_opts)
            .expect("sanitize default");

        // Verify all 7 family emoji code points belong to grapheme_index 1 (after leading BOM at 0)
        // and advance UTF-16 offsets accurately (surrogate pairs = +2, ZWJ = +1)
        assert_eq!(res.entries[1].code_point_hex, "U+1F468");
        assert_eq!(res.entries[1].utf16_offset, 1);
        assert_eq!(res.entries[1].utf16_length, 2);
        assert_eq!(res.entries[2].code_point_hex, "U+200D");
        assert_eq!(res.entries[2].utf16_offset, 3);
        assert_eq!(res.entries[1].grapheme_index, res.entries[7].grapheme_index);

        // Default cleanup removes BOM & ZWSP and normalizes NBSP -> ' ', while keeping ZWJ emoji, Persian ZWNJ, and '\n'!
        assert_eq!(res.sanitized_text, "👨‍👩‍👧‍👦 می\u{200C}خواهم\n");

        // Opt-in confusable replacement converts Cyrillic 'а' -> 'a' ONLY when explicitly enabled
        let mixed = "p\u{0430}ypal";
        let keep_res = inspect_and_sanitize_unicode(mixed, &default_opts).expect("keep");
        assert_eq!(keep_res.sanitized_text, "p\u{0430}ypal");

        let replace_opts = UnicodeSanitizeOptions {
            replace_confusables: true,
            ..default_opts
        };
        let rep_res = inspect_and_sanitize_unicode(mixed, &replace_opts).expect("replace");
        assert_eq!(rep_res.sanitized_text, "paypal");
    }
}
