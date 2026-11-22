use crate::error::AppError;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const MIN_PASSWORD_LENGTH: usize = 8;
pub const MAX_PASSWORD_LENGTH: usize = 128;
pub const MIN_PASSPHRASE_WORDS: usize = 3;
pub const MAX_PASSPHRASE_WORDS: usize = 12;
pub const MIN_BATCH_COUNT: usize = 1;
pub const MAX_BATCH_COUNT: usize = 50;

pub const UPPERCASE_CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
pub const LOWERCASE_CHARS: &str = "abcdefghijklmnopqrstuvwxyz";
pub const DIGIT_CHARS: &str = "0123456789";
pub const SYMBOL_CHARS: &str = "!@#$%^&*()-_=+[]{};:,.<>?/|~";
pub const LOOKALIKE_CHARS: &str = "0Oo1lI|";

const MAX_UNIFORM_DRAW_ATTEMPTS: usize = 4_096;
const MAX_CONSTRAINED_CANDIDATE_ATTEMPTS: usize = 4_096;
const APPENDED_NUMBER_MODULUS: usize = 100; // 00..=99

const EFF_WORDLIST_RAW: &str = include_str!("eff_wordlist_7772.txt");

static EFF_WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();

pub fn eff_wordlist() -> &'static [&'static str] {
    EFF_WORDS
        .get_or_init(|| {
            EFF_WORDLIST_RAW
                .lines()
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .collect()
        })
        .as_slice()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SecretGenRequest {
    Password {
        length: usize,
        count: usize,
        uppercase: bool,
        lowercase: bool,
        digits: bool,
        symbols: bool,
        #[serde(rename = "excludeLookAlikes")]
        exclude_look_alikes: bool,
        #[serde(rename = "requireEachSelectedClass")]
        require_each_selected_class: bool,
    },
    Passphrase {
        #[serde(rename = "wordCount")]
        word_count: usize,
        count: usize,
        separator: String,
        #[serde(rename = "capitalizeWords")]
        capitalize_words: bool,
        #[serde(rename = "includeNumber")]
        include_number: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StrengthTier {
    Weak,
    Fair,
    Strong,
    VeryStrong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntropyModelKind {
    IndependentUniformChars,
    ConstrainedAllSelectedClasses,
    IndependentWordsWithReplacement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStrengthEstimate {
    pub estimated_bits: f64,
    pub unconstrained_upper_bound_bits: f64,
    pub is_upper_bound: bool,
    pub tier: StrengthTier,
    pub model_kind: EntropyModelKind,
    pub pool_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretGenResponse {
    pub items: Vec<String>,
    pub strength: SecretStrengthEstimate,
}

fn classify_tier(bits: f64) -> StrengthTier {
    if bits < 50.0 {
        StrengthTier::Weak
    } else if bits < 70.0 {
        StrengthTier::Fair
    } else if bits < 100.0 {
        StrengthTier::Strong
    } else {
        StrengthTier::VeryStrong
    }
}

fn round_bits(bits: f64) -> f64 {
    (bits * 100.0).round() / 100.0
}

/// Unbiased uniform integer sampling on `0..upper_exclusive` via 32-bit zone rejection.
/// Never falls back to non-cryptographic RNGs on error.
pub fn sample_uniform_index<R: RngCore + ?Sized>(
    rng: &mut R,
    upper_exclusive: usize,
) -> Result<usize, AppError> {
    if upper_exclusive == 0 || upper_exclusive > (u32::MAX as usize) {
        return Err(AppError::invalid_param("Invalid sampling pool size."));
    }
    if upper_exclusive == 1 {
        return Ok(0);
    }

    let n = upper_exclusive as u64;
    let total_space = 1u64 << 32;
    let zone = total_space - (total_space % n);

    for _ in 0..MAX_UNIFORM_DRAW_ATTEMPTS {
        let mut bytes = [0u8; 4];
        rng.try_fill_bytes(&mut bytes).map_err(|_| {
            AppError::new(
                "CSPRNG_FAILED",
                "Operating system cryptographic random source failed.",
            )
        })?;
        let candidate = u32::from_le_bytes(bytes) as u64;
        if candidate < zone {
            return Ok((candidate % n) as usize);
        }
    }

    Err(AppError::new(
        "SAMPLING_BUDGET_EXCEEDED",
        "Unbiased random rejection budget was exhausted.",
    ))
}

/// Computes exact model entropy `log2(|V|)` where `V` is the set of length-`L` strings over
/// disjoint selected character classes of sizes `class_sizes` containing at least one char
/// from every selected class:
/// `|V| = sum_{T subseteq {1..k}} (-1)^|T| * (S - sum_{i in T} s_i)^L`.
pub fn compute_constrained_password_bits(length: usize, class_sizes: &[usize]) -> f64 {
    let total: usize = class_sizes.iter().sum();
    if total == 0 || length == 0 {
        return 0.0;
    }
    let k = class_sizes.len();
    if k <= 1 {
        return (length as f64) * (total as f64).log2();
    }

    let s_f64 = total as f64;
    let mut prob_valid = 0.0f64;
    let subset_count = 1usize << k;

    for mask in 0..subset_count {
        let mut excluded_sum = 0usize;
        let mut bits_set = 0u32;
        for (i, &sz) in class_sizes.iter().enumerate() {
            if (mask & (1usize << i)) != 0 {
                excluded_sum += sz;
                bits_set += 1;
            }
        }
        let remaining = total.saturating_sub(excluded_sum);
        let ratio = if remaining == 0 {
            0.0
        } else {
            (remaining as f64 / s_f64).powi(length as i32)
        };
        if bits_set.is_multiple_of(2) {
            prob_valid += ratio;
        } else {
            prob_valid -= ratio;
        }
    }

    let clamped_prob = prob_valid.clamp(f64::MIN_POSITIVE, 1.0);
    (length as f64) * s_f64.log2() + clamped_prob.log2()
}

pub fn generate_secrets_with_os_rng(req: &SecretGenRequest) -> Result<SecretGenResponse, AppError> {
    generate_secrets_with_rng(req, &mut OsRng)
}

pub fn generate_secrets_with_rng<R: RngCore + ?Sized>(
    req: &SecretGenRequest,
    rng: &mut R,
) -> Result<SecretGenResponse, AppError> {
    match req {
        SecretGenRequest::Password {
            length,
            count,
            uppercase,
            lowercase,
            digits,
            symbols,
            exclude_look_alikes,
            require_each_selected_class,
        } => {
            if !(MIN_PASSWORD_LENGTH..=MAX_PASSWORD_LENGTH).contains(length) {
                return Err(AppError::invalid_param(format!(
                    "Password length must be between {MIN_PASSWORD_LENGTH} and {MAX_PASSWORD_LENGTH}."
                )));
            }
            if !(MIN_BATCH_COUNT..=MAX_BATCH_COUNT).contains(count) {
                return Err(AppError::invalid_param(format!(
                    "Batch count must be between {MIN_BATCH_COUNT} and {MAX_BATCH_COUNT}."
                )));
            }

            let filter_chars = |src: &str| -> Vec<char> {
                let mut out = Vec::with_capacity(src.len());
                for ch in src.chars() {
                    if *exclude_look_alikes && LOOKALIKE_CHARS.contains(ch) {
                        continue;
                    }
                    if !out.contains(&ch) {
                        out.push(ch);
                    }
                }
                out
            };

            let mut active_classes: Vec<Vec<char>> = Vec::with_capacity(4);
            if *uppercase {
                active_classes.push(filter_chars(UPPERCASE_CHARS));
            }
            if *lowercase {
                active_classes.push(filter_chars(LOWERCASE_CHARS));
            }
            if *digits {
                active_classes.push(filter_chars(DIGIT_CHARS));
            }
            if *symbols {
                active_classes.push(filter_chars(SYMBOL_CHARS));
            }

            if active_classes.is_empty() {
                return Err(AppError::invalid_param(
                    "Select at least one character category (A–Z, a–z, 0–9, or symbols).",
                ));
            }
            if active_classes.iter().any(|cls| cls.is_empty()) {
                return Err(AppError::invalid_param(
                    "One of the selected character categories became empty after filtering.",
                ));
            }
            if *require_each_selected_class && *length < active_classes.len() {
                return Err(AppError::invalid_param(
                    "Password length is shorter than the number of required character categories.",
                ));
            }

            // Build deduplicated combined alphabet paired with each character's class bit
            let mut pool: Vec<(char, u8)> = Vec::new();
            let mut class_sizes: Vec<usize> = Vec::with_capacity(active_classes.len());
            for (class_idx, cls) in active_classes.iter().enumerate() {
                let mut added_for_class = 0usize;
                let bit = 1u8 << class_idx;
                for &ch in cls {
                    if !pool.iter().any(|(existing, _)| *existing == ch) {
                        pool.push((ch, bit));
                        added_for_class += 1;
                    }
                }
                class_sizes.push(added_for_class);
            }

            let pool_size = pool.len();
            let required_mask: u8 = if *require_each_selected_class {
                ((1u16 << active_classes.len()) - 1) as u8
            } else {
                0
            };

            let mut items = Vec::with_capacity(*count);
            for _ in 0..*count {
                let mut accepted: Option<String> = None;
                let max_attempts = if *require_each_selected_class {
                    MAX_CONSTRAINED_CANDIDATE_ATTEMPTS
                } else {
                    1
                };

                for _ in 0..max_attempts {
                    let mut candidate = String::with_capacity(*length);
                    let mut seen_mask = 0u8;
                    for _ in 0..*length {
                        let idx = sample_uniform_index(rng, pool_size)?;
                        let (ch, bit) = pool[idx];
                        candidate.push(ch);
                        seen_mask |= bit;
                    }
                    if !*require_each_selected_class || (seen_mask & required_mask) == required_mask
                    {
                        accepted = Some(candidate);
                        break;
                    }
                }

                match accepted {
                    Some(pw) => items.push(pw),
                    None => {
                        return Err(AppError::new(
                            "SAMPLING_BUDGET_EXCEEDED",
                            "Bounded rejection sampling could not satisfy character category constraints.",
                        ));
                    }
                }
            }

            let unconstrained_bits = (*length as f64) * (pool_size as f64).log2();
            let (raw_bits, model_kind) = if *require_each_selected_class {
                (
                    compute_constrained_password_bits(*length, &class_sizes),
                    EntropyModelKind::ConstrainedAllSelectedClasses,
                )
            } else {
                (
                    unconstrained_bits,
                    EntropyModelKind::IndependentUniformChars,
                )
            };

            let estimated_bits = round_bits(raw_bits);
            Ok(SecretGenResponse {
                items,
                strength: SecretStrengthEstimate {
                    estimated_bits,
                    unconstrained_upper_bound_bits: round_bits(unconstrained_bits),
                    is_upper_bound: false,
                    tier: classify_tier(raw_bits),
                    model_kind,
                    pool_size,
                },
            })
        }

        SecretGenRequest::Passphrase {
            word_count,
            count,
            separator,
            capitalize_words,
            include_number,
        } => {
            if !(MIN_PASSPHRASE_WORDS..=MAX_PASSPHRASE_WORDS).contains(word_count) {
                return Err(AppError::invalid_param(format!(
                    "Passphrase word count must be between {MIN_PASSPHRASE_WORDS} and {MAX_PASSPHRASE_WORDS}."
                )));
            }
            if !(MIN_BATCH_COUNT..=MAX_BATCH_COUNT).contains(count) {
                return Err(AppError::invalid_param(format!(
                    "Batch count must be between {MIN_BATCH_COUNT} and {MAX_BATCH_COUNT}."
                )));
            }
            let allowed_separators = ["-", " ", ".", "_", ""];
            if !allowed_separators.contains(&separator.as_str()) {
                return Err(AppError::invalid_param("Unsupported passphrase separator."));
            }

            let words = eff_wordlist();
            let dict_len = words.len();
            if dict_len < 1_000 {
                return Err(AppError::new(
                    "WORDLIST_CORRUPTED",
                    "Embedded passphrase wordlist failed integrity check.",
                ));
            }

            let mut items = Vec::with_capacity(*count);
            for _ in 0..*count {
                let mut chosen: Vec<String> = Vec::with_capacity(*word_count);
                for _ in 0..*word_count {
                    // Independent uniform draw WITH replacement (never secretly deduplicating)
                    let idx = sample_uniform_index(rng, dict_len)?;
                    let raw_word = words[idx];
                    if *capitalize_words {
                        let mut chars = raw_word.chars();
                        let formatted = match chars.next() {
                            Some(first) => {
                                format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                            }
                            None => String::new(),
                        };
                        chosen.push(formatted);
                    } else {
                        chosen.push(raw_word.to_string());
                    }
                }

                let mut phrase = chosen.join(separator);
                if *include_number {
                    let num = sample_uniform_index(rng, APPENDED_NUMBER_MODULUS)?;
                    if separator.is_empty() {
                        phrase.push_str(&format!("{num:02}"));
                    } else {
                        phrase.push_str(&format!("{separator}{num:02}"));
                    }
                }
                items.push(phrase);
            }

            let choice_bits = (*word_count as f64) * (dict_len as f64).log2()
                + if *include_number {
                    (APPENDED_NUMBER_MODULUS as f64).log2()
                } else {
                    0.0
                };
            // Empty separator with all-lowercase words can merge compound sequences (e.g. cat+walk vs catwalk)
            let is_upper_bound = separator.is_empty() && !*capitalize_words;

            Ok(SecretGenResponse {
                items,
                strength: SecretStrengthEstimate {
                    estimated_bits: round_bits(choice_bits),
                    unconstrained_upper_bound_bits: round_bits(choice_bits),
                    is_upper_bound,
                    tier: classify_tier(choice_bits),
                    model_kind: EntropyModelKind::IndependentWordsWithReplacement,
                    pool_size: dict_len,
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    struct ConstantZeroRng;
    impl RngCore for ConstantZeroRng {
        fn next_u32(&mut self) -> u32 {
            0
        }
        fn next_u64(&mut self) -> u64 {
            0
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            dest.fill(0);
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> {
            dest.fill(0);
            Ok(())
        }
    }

    struct FailingRng;
    impl RngCore for FailingRng {
        fn next_u32(&mut self) -> u32 {
            0
        }
        fn next_u64(&mut self) -> u64 {
            0
        }
        fn fill_bytes(&mut self, _dest: &mut [u8]) {}
        fn try_fill_bytes(&mut self, _dest: &mut [u8]) -> Result<(), rand::Error> {
            Err(rand::Error::new("simulated OS RNG failure"))
        }
    }

    #[test]
    fn eff_wordlist_is_strictly_lowercase_ascii_alpha_and_case_insensitively_unique() {
        let words = eff_wordlist();
        assert_eq!(words.len(), 7_772);
        let mut seen = HashSet::with_capacity(words.len());
        for &w in words {
            assert!(w.len() >= 3, "word too short: {w}");
            assert!(
                w.bytes().all(|b| b.is_ascii_lowercase()),
                "non-lowercase-alpha word: {w}"
            );
            assert!(seen.insert(w.to_ascii_lowercase()), "duplicate word: {w}");
        }
    }

    #[test]
    fn password_constraints_lookalike_exclusion_budget_and_csprng_errors_are_enforced() {
        let req = SecretGenRequest::Password {
            length: 16,
            count: 20,
            uppercase: true,
            lowercase: true,
            digits: true,
            symbols: true,
            exclude_look_alikes: true,
            require_each_selected_class: true,
        };
        let resp = generate_secrets_with_os_rng(&req).expect("os rng generation");
        assert_eq!(resp.items.len(), 20);
        for pw in &resp.items {
            assert_eq!(pw.chars().count(), 16);
            assert!(!pw.chars().any(|c| LOOKALIKE_CHARS.contains(c)));
            assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
            assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
            assert!(pw.chars().any(|c| c.is_ascii_digit()));
            assert!(pw.chars().any(|c| SYMBOL_CHARS.contains(c)));
        }
        assert!(resp.strength.estimated_bits < resp.strength.unconstrained_upper_bound_bits);

        // ConstantZeroRng always picks index 0 (only class 0) -> must fail bounded rejection budget
        // rather than looping infinitely or weakening constraints!
        let budget_err = generate_secrets_with_rng(&req, &mut ConstantZeroRng).unwrap_err();
        assert_eq!(budget_err.code, "SAMPLING_BUDGET_EXCEEDED");

        // Failing CSPRNG must fail closed rather than falling back to non-CSPRNG
        let rng_err = generate_secrets_with_rng(&req, &mut FailingRng).unwrap_err();
        assert_eq!(rng_err.code, "CSPRNG_FAILED");
    }

    #[test]
    fn inclusion_exclusion_bits_and_passphrase_upper_bound_flag_match_exact_combinatorics() {
        // Exact combinatorial check: 2 classes of size 1 each (`S = 2`), length 8:
        // Total strings = 2^8 = 256; strings missing at least one class = 2 (`AAAAAAAA`, `BBBBBBBB`);
        // Valid strings |V| = 254 -> log2(254) = 7.9886846867721655
        let exact_bits = compute_constrained_password_bits(8, &[1, 1]);
        assert!((exact_bits - 254.0_f64.log2()).abs() < 1e-12);

        // Passphrase with ConstantZeroRng proves natural with-replacement repeats are allowed (`abacus-abacus-abacus-00`)
        let pp_sep = generate_secrets_with_rng(
            &SecretGenRequest::Passphrase {
                word_count: 3,
                count: 1,
                separator: "-".to_string(),
                capitalize_words: true,
                include_number: true,
            },
            &mut ConstantZeroRng,
        )
        .expect("passphrase with '-'");
        assert_eq!(pp_sep.items[0], "Abacus-Abacus-Abacus-00");
        assert!(!pp_sep.strength.is_upper_bound);

        // Empty separator without capitalization marks entropy as selection upper bound
        let pp_empty_lower = generate_secrets_with_rng(
            &SecretGenRequest::Passphrase {
                word_count: 4,
                count: 1,
                separator: String::new(),
                capitalize_words: false,
                include_number: false,
            },
            &mut ConstantZeroRng,
        )
        .expect("passphrase empty sep");
        assert!(pp_empty_lower.strength.is_upper_bound);
    }
}
