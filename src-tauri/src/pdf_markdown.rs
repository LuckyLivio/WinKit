//! P23 Markdown to PDF (`pulldown-cmark` AST sanitizer + hardened offline Edge print-to-PDF
//! + PDFium/lopdf heading bookmark `/Outlines` injection).
//!
//! Security & offline invariants:
//! - Parses Markdown strictly through `pulldown-cmark` AST (CommonMark + GFM tables, strikethrough,
//!   task lists) and escapes ALL raw HTML blocks/inline HTML by default (`Event::Html` /
//!   `Event::InlineHtml`) so embedded `<script>`, `<iframe>`, `on*=` attributes, and raw `<img src>`
//!   tags can NEVER execute or load external URLs.
//! - Link URLs are allow-listed to `http://`, `https://`, `mailto:`, and `#anchor` (rejecting
//!   `javascript:`, `vbscript:`, `data:`, and `file:`).
//! - Image URLs:
//!   - `http://` / `https://` remote URLs are blocked offline by default (never auto-fetched),
//!     rendered as an explicit offline placeholder, and counted in `blockedRemoteImages`.
//!   - `file://`, absolute paths, UNC shares, and `..` parent traversal escaping `sourceDir` are
//!     strictly blocked (`blockedLocalImages`).
//!   - Relative local images that canonicalize strictly inside `sourceDir` and pass `image::guess_format`
//!     (PNG/JPEG/WebP/GIF/BMP, <= 20 MiB) are inlined as verified `data:image/...;base64,...` URIs.
//! - Headless PDF rendering runs Windows Microsoft Edge (`msedge.exe --headless=new`) with
//!   `--disable-javascript`, `--disable-extensions`, `--disable-background-networking`,
//!   `--host-resolver-rules=MAP * ~NOTFOUND`, an isolated temp profile auto-deleted on Drop, strict
//!   HTML CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:;`), and a Windows
//!   Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) for clean tree termination on cancel/timeout.
//! - Post-processes the rendered PDF with PDFium text lookup + `lopdf` to inject genuine UTF-16BE
//!   hierarchical PDF `/Outlines` bookmarks matching H1–H3 headings while preserving selectable text,
//!   vector fonts, and clickable links.

use crate::error::AppError;
use crate::pdf_core::{AtomicPdfOutput, PdfSessionManager, PdfTaskProgressPayload};
use crate::pdf_pdfium::{extract_page_text_with_pdfium, inspect_with_pdfium};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use lopdf::{dictionary, Document, Object, ObjectId};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_MARKDOWN_BYTES: usize = 10 * 1024 * 1024; // 10 MiB Markdown cap
const MAX_LOCAL_IMAGE_BYTES: u64 = 20 * 1024 * 1024; // 20 MiB per embedded local image
const EDGE_RENDER_TIMEOUT: Duration = Duration::from_secs(75);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownHeadingInfo {
    pub level: u8,
    pub title: String,
    pub slug: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownPreviewRequest {
    pub markdown: String,
    pub source_dir: Option<String>,
    /// `"clean"` | `"github"`
    pub theme: String,
    /// `"a4"` | `"letter"`
    pub paper_size: String,
    /// `"narrow"` | `"normal"` | `"wide"`
    pub margin_preset: String,
    pub header_text: Option<String>,
    pub footer_text: Option<String>,
    pub show_page_numbers: bool,
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownPreviewResult {
    pub html_document: String,
    pub headings: Vec<MarkdownHeadingInfo>,
    pub embedded_local_images: usize,
    pub blocked_remote_images: usize,
    pub blocked_local_images: usize,
    pub stripped_raw_html_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownToPdfRequest {
    pub markdown: String,
    pub source_dir: Option<String>,
    pub output_path: String,
    pub overwrite: bool,
    /// `"clean"` | `"github"`
    pub theme: String,
    /// `"a4"` | `"letter"`
    pub paper_size: String,
    /// `"narrow"` | `"normal"` | `"wide"`
    pub margin_preset: String,
    pub header_text: Option<String>,
    pub footer_text: Option<String>,
    pub show_page_numbers: bool,
    pub include_bookmarks: bool,
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownToPdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub page_count: usize,
    pub bookmark_count: usize,
    pub embedded_local_images: usize,
    pub blocked_remote_images: usize,
    pub blocked_local_images: usize,
    pub stripped_raw_html_count: usize,
    pub has_text_layer: bool,
    pub warnings: Vec<String>,
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn escape_html_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn escape_css_string(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' | '\r' => out.push(' '),
            c if c.is_control() => {}
            other => out.push(other),
        }
    }
    out
}

fn slugify_heading(title: &str, seen: &mut HashMap<String, usize>) -> String {
    let mut base = String::new();
    let mut prev_dash = false;
    for ch in title.trim().chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                base.push(lc);
            }
            prev_dash = false;
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !prev_dash && !base.is_empty() {
            base.push('-');
            prev_dash = true;
        }
    }
    let trimmed = base.trim_matches('-');
    let root = if trimmed.is_empty() {
        "section".to_string()
    } else {
        trimmed.to_string()
    };
    let count = seen.entry(root.clone()).or_insert(0);
    *count += 1;
    if *count == 1 {
        root
    } else {
        format!("{root}-{}", *count)
    }
}

fn sanitize_link_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('#') {
        return Some(trimmed.to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        return Some(trimmed.to_string());
    }
    // Reject javascript:, vbscript:, data:, file:, relative arbitrary paths
    None
}

enum ResolvedImage {
    DataUri(String),
    BlockedRemote(String),
    BlockedLocal(String),
    Missing(String),
}

fn resolve_safe_local_image(raw_url: &str, canonical_source_dir: Option<&Path>) -> ResolvedImage {
    let trimmed = raw_url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//") {
        return ResolvedImage::BlockedRemote(trimmed.to_string());
    }
    if lower.starts_with("file:")
        || lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || trimmed.starts_with("\\\\")
        || trimmed.starts_with('/')
    {
        return ResolvedImage::BlockedLocal(trimmed.to_string());
    }

    let Some(base_dir) = canonical_source_dir else {
        return ResolvedImage::BlockedLocal(trimmed.to_string());
    };

    // Strip optional query/fragment & decode basic %20 spaces for Markdown relative links
    let path_part = trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or(trimmed)
        .replace("%20", " ");
    let rel = Path::new(&path_part);
    if rel.is_absolute() {
        return ResolvedImage::BlockedLocal(trimmed.to_string());
    }
    for comp in rel.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return ResolvedImage::BlockedLocal(trimmed.to_string());
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }

    let candidate = base_dir.join(rel);
    let Ok(canonical_img) = fs::canonicalize(&candidate) else {
        return ResolvedImage::Missing(trimmed.to_string());
    };
    if !canonical_img.starts_with(base_dir) {
        return ResolvedImage::BlockedLocal(trimmed.to_string());
    }
    let Ok(meta) = fs::metadata(&canonical_img) else {
        return ResolvedImage::Missing(trimmed.to_string());
    };
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_LOCAL_IMAGE_BYTES {
        return ResolvedImage::BlockedLocal(trimmed.to_string());
    }
    let Ok(bytes) = fs::read(&canonical_img) else {
        return ResolvedImage::Missing(trimmed.to_string());
    };
    let mime = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        Ok(image::ImageFormat::Bmp) => "image/bmp",
        _ => return ResolvedImage::BlockedLocal(trimmed.to_string()),
    };
    let b64 = BASE64_STANDARD.encode(&bytes);
    ResolvedImage::DataUri(format!("data:{mime};base64,{b64}"))
}

fn heading_level_num(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn build_css(
    theme: &str,
    paper_size: &str,
    margin_preset: &str,
    header_text: &str,
    footer_text: &str,
    show_page_numbers: bool,
    is_zh: bool,
) -> String {
    let page_size_css = if paper_size == "letter" {
        "Letter"
    } else {
        "A4"
    };
    let margin_mm = match margin_preset {
        "narrow" => "14mm 14mm 16mm 14mm",
        "wide" => "26mm 24mm 26mm 24mm",
        _ => "20mm 18mm 20mm 18mm",
    };

    let top_header_css = if header_text.trim().is_empty() {
        String::new()
    } else {
        format!(
            "@top-left {{ content: \"{}\"; font-size: 8.5pt; color: #64748b; font-family: \"Microsoft YaHei UI\", \"Segoe UI\", sans-serif; }}",
            escape_css_string(header_text.trim())
        )
    };
    let bottom_footer_css = if footer_text.trim().is_empty() {
        String::new()
    } else {
        format!(
            "@bottom-left {{ content: \"{}\"; font-size: 8.5pt; color: #64748b; font-family: \"Microsoft YaHei UI\", \"Segoe UI\", sans-serif; }}",
            escape_css_string(footer_text.trim())
        )
    };
    let page_num_css = if show_page_numbers {
        let content_expr = if is_zh {
            "\"第 \" counter(page) \" / \" counter(pages) \" 页\""
        } else {
            "\"Page \" counter(page) \" of \" counter(pages)"
        };
        format!(
            "@bottom-right {{ content: {content_expr}; font-size: 8.5pt; color: #64748b; font-family: \"Microsoft YaHei UI\", \"Segoe UI\", sans-serif; }}"
        )
    } else {
        String::new()
    };

    let theme_vars = if theme == "github" {
        r#"
:root {
  --fg: #1f2328;
  --fg-muted: #59636e;
  --border: #d0d7de;
  --bg-code: #f6f8fa;
  --bg-quote: #f6f8fa;
  --accent: #0969da;
  --table-stripe: #f6f8fa;
  --heading-border: 1px solid #d8dee4;
}
body { font-size: 10.5pt; line-height: 1.62; }
h1 { font-size: 20pt; padding-bottom: 6pt; border-bottom: var(--heading-border); margin-top: 0; }
h2 { font-size: 15pt; padding-bottom: 4pt; border-bottom: var(--heading-border); }
h3 { font-size: 12.5pt; }
"#
    } else {
        r#"
:root {
  --fg: #18181b;
  --fg-muted: #52525b;
  --border: #e4e4e7;
  --bg-code: #f4f4f5;
  --bg-quote: #fafafa;
  --accent: #2563eb;
  --table-stripe: #fafafa;
  --heading-border: none;
}
body { font-size: 11pt; line-height: 1.72; }
h1 { font-size: 21pt; letter-spacing: -0.01em; margin-top: 0; }
h2 { font-size: 15.5pt; }
h3 { font-size: 12.5pt; }
"#
    };

    format!(
        r#"@page {{
  size: {page_size_css};
  margin: {margin_mm};
  {top_header_css}
  {bottom_footer_css}
  {page_num_css}
}}
{theme_vars}
* {{ box-sizing: border-box; }}
html, body {{
  margin: 0;
  padding: 0;
  color: var(--fg);
  background: #ffffff;
  font-family: "Microsoft YaHei UI", "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}
main.md-doc {{
  max-width: 100%;
  padding: 4px 2px;
}}
@media screen {{
  main.md-doc {{
    max-width: 780px;
    margin: 0 auto;
    padding: 24px 28px 36px;
  }}
}}
h1, h2, h3, h4, h5, h6 {{
  color: var(--fg);
  font-weight: 600;
  line-height: 1.3;
  margin: 1.35em 0 0.55em;
  break-after: avoid;
  page-break-after: avoid;
}}
p {{
  margin: 0 0 0.85em;
  orphans: 3;
  widows: 3;
  overflow-wrap: break-word;
}}
a {{
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  word-break: break-word;
}}
ul, ol {{
  margin: 0 0 0.9em;
  padding-left: 1.65em;
}}
li {{
  margin: 0.25em 0;
}}
li > ul, li > ol {{
  margin-top: 0.25em;
  margin-bottom: 0.25em;
}}
li.task-item {{
  list-style: none;
  margin-left: -1.35em;
}}
.task-box {{
  display: inline-block;
  width: 11px;
  height: 11px;
  margin-right: 6px;
  border: 1.2px solid var(--fg-muted);
  border-radius: 2px;
  vertical-align: -1px;
  text-align: center;
  line-height: 9px;
  font-size: 9px;
  font-weight: 700;
}}
.task-box.is-checked {{
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}}
blockquote {{
  margin: 0.9em 0;
  padding: 8px 14px;
  border-left: 3.5px solid var(--border);
  background: var(--bg-quote);
  color: var(--fg-muted);
  border-radius: 0 4px 4px 0;
  break-inside: avoid;
}}
blockquote > :last-child {{
  margin-bottom: 0;
}}
code {{
  font-family: "Cascadia Code", "Consolas", "Courier New", monospace;
  font-size: 0.9em;
  background: var(--bg-code);
  padding: 1.5px 5px;
  border-radius: 4px;
  overflow-wrap: anywhere;
}}
pre {{
  margin: 0.9em 0;
  padding: 11px 14px;
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.5;
  font-size: 9pt;
}}
pre code {{
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}}
hr {{
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.4em 0;
}}
table {{
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 9.5pt;
  table-layout: auto;
}}
thead {{
  display: table-header-group;
}}
tr {{
  break-inside: avoid;
  page-break-inside: avoid;
}}
th, td {{
  border: 1px solid var(--border);
  padding: 6px 9px;
  vertical-align: top;
  overflow-wrap: break-word;
  word-break: break-word;
}}
th {{
  background: var(--bg-code);
  font-weight: 600;
}}
tbody tr:nth-child(even) {{
  background: var(--table-stripe);
}}
figure.md-img-wrap {{
  margin: 1em 0;
  text-align: center;
  break-inside: avoid;
}}
figure.md-img-wrap img {{
  max-width: 100%;
  max-height: 210mm;
  height: auto;
  border-radius: 4px;
  border: 1px solid var(--border);
}}
figure.md-img-wrap figcaption {{
  margin-top: 4px;
  font-size: 8.5pt;
  color: var(--fg-muted);
}}
.md-blocked-img {{
  display: inline-block;
  margin: 0.4em 0;
  padding: 5px 9px;
  border: 1px dashed var(--border);
  border-radius: 4px;
  background: var(--bg-code);
  color: var(--fg-muted);
  font-size: 8.5pt;
}}
"#
    )
}

pub fn render_markdown_preview_impl(
    req: &MarkdownPreviewRequest,
) -> Result<MarkdownPreviewResult, AppError> {
    if req.markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(AppError::size_limit(format!(
            "Markdown input exceeds the {} MiB safety limit.",
            MAX_MARKDOWN_BYTES / (1024 * 1024)
        )));
    }
    let is_zh = req.locale.as_deref().unwrap_or("zh-CN") == "zh-CN";
    let canonical_source_dir = req
        .source_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| fs::canonicalize(s).ok())
        .filter(|p| p.is_dir());

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);

    let parser = Parser::new_ext(&req.markdown, options);
    let mut body = String::with_capacity(req.markdown.len() * 2);
    let mut headings: Vec<MarkdownHeadingInfo> = Vec::new();
    let mut slug_counts: HashMap<String, usize> = HashMap::new();

    let mut embedded_local_images = 0usize;
    let mut blocked_remote_images = 0usize;
    let mut blocked_local_images = 0usize;
    let mut stripped_raw_html_count = 0usize;

    // Heading capture state
    let mut active_heading: Option<(u8, String, String)> = None; // (level, inner_html, plain_text)
                                                                 // Link safety stack (true if an <a> tag was opened)
    let mut link_stack: Vec<bool> = Vec::new();
    // Image capture state (dest_url, alt_text)
    let mut active_image: Option<(String, String)> = None;
    // Table alignment state
    let mut table_alignments: Vec<Alignment> = Vec::new();
    let mut in_table_head = false;
    let mut table_col_idx = 0usize;
    // Pending list item open (to attach class="task-item" when TaskListMarker arrives)
    let mut pending_li = false;

    let flush_pending_li = |pending: &mut bool, target: &mut String, is_task: bool| {
        if *pending {
            if is_task {
                target.push_str("<li class=\"task-item\">");
            } else {
                target.push_str("<li>");
            }
            *pending = false;
        }
    };

    for event in parser {
        // Inside an image tag, only collect alt text until TagEnd::Image
        if let Some((ref dest, ref mut alt)) = active_image {
            match event {
                Event::Text(t) | Event::Code(t) => {
                    alt.push_str(&t);
                    continue;
                }
                Event::SoftBreak | Event::HardBreak => {
                    alt.push(' ');
                    continue;
                }
                Event::End(TagEnd::Image) => {
                    let dest_owned = dest.clone();
                    let alt_owned = alt.clone();
                    active_image = None;
                    let target = if let Some((_, ref mut h_html, _)) = active_heading {
                        h_html
                    } else {
                        flush_pending_li(&mut pending_li, &mut body, false);
                        &mut body
                    };
                    match resolve_safe_local_image(&dest_owned, canonical_source_dir.as_deref()) {
                        ResolvedImage::DataUri(uri) => {
                            embedded_local_images += 1;
                            let alt_esc = escape_html_text(&alt_owned);
                            target.push_str("<figure class=\"md-img-wrap\"><img src=\"");
                            target.push_str(&uri);
                            target.push_str("\" alt=\"");
                            target.push_str(&alt_esc);
                            target.push_str("\" />");
                            if !alt_owned.trim().is_empty() {
                                target.push_str("<figcaption>");
                                target.push_str(&alt_esc);
                                target.push_str("</figcaption>");
                            }
                            target.push_str("</figure>");
                        }
                        ResolvedImage::BlockedRemote(url) => {
                            blocked_remote_images += 1;
                            let note = if is_zh {
                                format!("离线模式已阻止加载远程图片：{}", escape_html_text(&url))
                            } else {
                                format!(
                                    "Remote image blocked in offline mode: {}",
                                    escape_html_text(&url)
                                )
                            };
                            target.push_str("<span class=\"md-blocked-img\">");
                            target.push_str(&note);
                            target.push_str("</span>");
                        }
                        ResolvedImage::BlockedLocal(url) => {
                            blocked_local_images += 1;
                            let note = if is_zh {
                                format!(
                                    "已阻止访问文档目录外的图片路径：{}",
                                    escape_html_text(&url)
                                )
                            } else {
                                format!(
                                    "Blocked local image outside document folder: {}",
                                    escape_html_text(&url)
                                )
                            };
                            target.push_str("<span class=\"md-blocked-img\">");
                            target.push_str(&note);
                            target.push_str("</span>");
                        }
                        ResolvedImage::Missing(url) => {
                            let note = if is_zh {
                                format!("未找到本地图片：{}", escape_html_text(&url))
                            } else {
                                format!("Local image not found: {}", escape_html_text(&url))
                            };
                            target.push_str("<span class=\"md-blocked-img\">");
                            target.push_str(&note);
                            target.push_str("</span>");
                        }
                    }
                    continue;
                }
                _ => continue,
            }
        }

        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str("<p>");
                }
                Tag::Heading { level, .. } => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    active_heading = Some((heading_level_num(level), String::new(), String::new()));
                }
                Tag::BlockQuote(_) => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str("<blockquote>");
                }
                Tag::CodeBlock(kind) => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    let lang = match kind {
                        CodeBlockKind::Fenced(info) => {
                            info.split_whitespace().next().unwrap_or("").to_string()
                        }
                        CodeBlockKind::Indented => String::new(),
                    };
                    if lang.is_empty() {
                        body.push_str("<pre><code>");
                    } else {
                        body.push_str("<pre><code class=\"language-");
                        body.push_str(&escape_html_text(&lang));
                        body.push_str("\">");
                    }
                }
                Tag::List(Some(start)) => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    if start == 1 {
                        body.push_str("<ol>");
                    } else {
                        body.push_str(&format!("<ol start=\"{start}\">"));
                    }
                }
                Tag::List(None) => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str("<ul>");
                }
                Tag::Item => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    pending_li = true;
                }
                Tag::Table(aligns) => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    table_alignments = aligns;
                    body.push_str("<table>");
                }
                Tag::TableHead => {
                    in_table_head = true;
                    table_col_idx = 0;
                    body.push_str("<thead><tr>");
                }
                Tag::TableRow => {
                    table_col_idx = 0;
                    body.push_str("<tr>");
                }
                Tag::TableCell => {
                    let align_attr = match table_alignments.get(table_col_idx) {
                        Some(Alignment::Left) => " style=\"text-align:left\"",
                        Some(Alignment::Center) => " style=\"text-align:center\"",
                        Some(Alignment::Right) => " style=\"text-align:right\"",
                        _ => "",
                    };
                    table_col_idx += 1;
                    if in_table_head {
                        body.push_str(&format!("<th{align_attr}>"));
                    } else {
                        body.push_str(&format!("<td{align_attr}>"));
                    }
                }
                Tag::Emphasis => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        flush_pending_li(&mut pending_li, &mut body, false);
                        &mut body
                    };
                    target.push_str("<em>");
                }
                Tag::Strong => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        flush_pending_li(&mut pending_li, &mut body, false);
                        &mut body
                    };
                    target.push_str("<strong>");
                }
                Tag::Strikethrough => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        flush_pending_li(&mut pending_li, &mut body, false);
                        &mut body
                    };
                    target.push_str("<del>");
                }
                Tag::Link { dest_url, .. } => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        flush_pending_li(&mut pending_li, &mut body, false);
                        &mut body
                    };
                    if let Some(safe) = sanitize_link_url(&dest_url) {
                        target.push_str("<a href=\"");
                        target.push_str(&escape_html_text(&safe));
                        target.push_str("\">");
                        link_stack.push(true);
                    } else {
                        link_stack.push(false);
                    }
                }
                Tag::Image { dest_url, .. } => {
                    active_image = Some((dest_url.into_string(), String::new()));
                }
                _ => {}
            },
            Event::End(tag_end) => match tag_end {
                TagEnd::Paragraph => body.push_str("</p>\n"),
                TagEnd::Heading(_) => {
                    if let Some((lvl, inner_html, plain)) = active_heading.take() {
                        let clean_title = plain.trim().to_string();
                        let slug = slugify_heading(&clean_title, &mut slug_counts);
                        headings.push(MarkdownHeadingInfo {
                            level: lvl,
                            title: clean_title,
                            slug: slug.clone(),
                        });
                        body.push_str(&format!(
                            "<h{lvl} id=\"{}\">{inner_html}</h{lvl}>\n",
                            escape_html_text(&slug)
                        ));
                    }
                }
                TagEnd::BlockQuote(_) => body.push_str("</blockquote>\n"),
                TagEnd::CodeBlock => body.push_str("</code></pre>\n"),
                TagEnd::List(ordered) => {
                    if ordered {
                        body.push_str("</ol>\n");
                    } else {
                        body.push_str("</ul>\n");
                    }
                }
                TagEnd::Item => {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str("</li>\n");
                }
                TagEnd::Table => {
                    body.push_str("</tbody></table>\n");
                    table_alignments.clear();
                }
                TagEnd::TableHead => {
                    in_table_head = false;
                    body.push_str("</tr></thead><tbody>\n");
                }
                TagEnd::TableRow => body.push_str("</tr>\n"),
                TagEnd::TableCell => {
                    if in_table_head {
                        body.push_str("</th>");
                    } else {
                        body.push_str("</td>");
                    }
                }
                TagEnd::Emphasis => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        &mut body
                    };
                    target.push_str("</em>");
                }
                TagEnd::Strong => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        &mut body
                    };
                    target.push_str("</strong>");
                }
                TagEnd::Strikethrough => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        &mut body
                    };
                    target.push_str("</del>");
                }
                TagEnd::Link if link_stack.pop().unwrap_or(false) => {
                    let target = if let Some((_, ref mut h, _)) = active_heading {
                        h
                    } else {
                        &mut body
                    };
                    target.push_str("</a>");
                }
                _ => {}
            },
            Event::Text(text) => {
                let escaped = escape_html_text(&text);
                if let Some((_, ref mut h_html, ref mut h_plain)) = active_heading {
                    h_html.push_str(&escaped);
                    h_plain.push_str(&text);
                } else {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str(&escaped);
                }
            }
            Event::Code(code) => {
                let escaped = escape_html_text(&code);
                if let Some((_, ref mut h_html, ref mut h_plain)) = active_heading {
                    h_html.push_str("<code>");
                    h_html.push_str(&escaped);
                    h_html.push_str("</code>");
                    h_plain.push_str(&code);
                } else {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str("<code>");
                    body.push_str(&escaped);
                    body.push_str("</code>");
                }
            }
            Event::Html(raw) | Event::InlineHtml(raw) => {
                // Strictly escape ALL raw HTML by default (zero script / iframe / raw img injection)
                stripped_raw_html_count += 1;
                let escaped = escape_html_text(&raw);
                if let Some((_, ref mut h_html, ref mut h_plain)) = active_heading {
                    h_html.push_str(&escaped);
                    h_plain.push_str(&raw);
                } else {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str(&escaped);
                }
            }
            Event::SoftBreak => {
                if let Some((_, ref mut h_html, ref mut h_plain)) = active_heading {
                    h_html.push(' ');
                    h_plain.push(' ');
                } else {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push('\n');
                }
            }
            Event::HardBreak => {
                if let Some((_, ref mut h_html, ref mut h_plain)) = active_heading {
                    h_html.push(' ');
                    h_plain.push(' ');
                } else {
                    flush_pending_li(&mut pending_li, &mut body, false);
                    body.push_str("<br />");
                }
            }
            Event::Rule => {
                flush_pending_li(&mut pending_li, &mut body, false);
                body.push_str("<hr />\n");
            }
            Event::TaskListMarker(checked) => {
                flush_pending_li(&mut pending_li, &mut body, true);
                if checked {
                    body.push_str("<span class=\"task-box is-checked\">&#10003;</span>");
                } else {
                    body.push_str("<span class=\"task-box\"></span>");
                }
            }
            _ => {}
        }
    }

    let css = build_css(
        &req.theme,
        &req.paper_size,
        &req.margin_preset,
        req.header_text.as_deref().unwrap_or(""),
        req.footer_text.as_deref().unwrap_or(""),
        req.show_page_numbers,
        is_zh,
    );

    let lang_attr = if is_zh { "zh-CN" } else { "en-US" };
    let html_document = format!(
        "<!DOCTYPE html>\n<html lang=\"{lang_attr}\">\n<head>\n<meta charset=\"utf-8\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:;\">\n<title>WinKit Markdown Export</title>\n<style>\n{css}\n</style>\n</head>\n<body>\n<main class=\"md-doc\">\n{body}\n</main>\n</body>\n</html>\n"
    );

    let mut warnings = Vec::new();
    if blocked_remote_images > 0 {
        warnings.push(format!(
            "Blocked {blocked_remote_images} remote image URL(s) to keep conversion strictly offline."
        ));
    }
    if blocked_local_images > 0 {
        warnings.push(format!(
            "Blocked {blocked_local_images} unsafe or out-of-directory local image path(s)."
        ));
    }
    if stripped_raw_html_count > 0 {
        warnings.push(format!(
            "Escaped {stripped_raw_html_count} raw HTML fragment(s) as plain text for security."
        ));
    }

    Ok(MarkdownPreviewResult {
        html_document,
        headings,
        embedded_local_images,
        blocked_remote_images,
        blocked_local_images,
        stripped_raw_html_count,
        warnings,
    })
}

fn find_windows_edge_binary() -> Result<PathBuf, AppError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(&pf86)
                .join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(&pf)
                .join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(&local)
                .join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
    }

    for cand in candidates {
        if cand.is_file() {
            return Ok(cand);
        }
    }

    Err(AppError::new(
        "PDF_MARKDOWN_ENGINE_MISSING",
        "Microsoft Edge (msedge.exe) was not found in standard Windows installation directories.",
    ))
}

fn path_to_file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let forward = stripped.replace('\\', "/");
    let mut encoded = String::with_capacity(forward.len() + 16);
    encoded.push_str("file:///");
    for byte in forward.as_bytes() {
        let b = *byte;
        if b.is_ascii_alphanumeric() || matches!(b, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    encoded
}

fn encode_pdf_utf16be_string(text: &str) -> Object {
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    bytes.push(0xFE);
    bytes.push(0xFF);
    for unit in text.encode_utf16() {
        bytes.push((unit >> 8) as u8);
        bytes.push((unit & 0xFF) as u8);
    }
    Object::String(bytes, lopdf::StringFormat::Literal)
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Inject genuine hierarchical PDF `/Outlines` bookmarks (H1–H3) into a printed PDF, locating
/// each heading's exact rendered 1-based page number sequentially via PDFium text extraction.
fn inject_heading_bookmarks(
    pdf_path: &Path,
    resource_dir: Option<&Path>,
    headings: &[MarkdownHeadingInfo],
    page_count: usize,
) -> Result<usize, AppError> {
    let filtered: Vec<&MarkdownHeadingInfo> = headings
        .iter()
        .filter(|h| h.level <= 3 && !h.title.trim().is_empty())
        .collect();
    if filtered.is_empty() || page_count == 0 {
        return Ok(0);
    }

    // Extract normalized text of every rendered page in order
    let mut page_texts: Vec<String> = Vec::with_capacity(page_count);
    for p in 1..=page_count {
        let txt = extract_page_text_with_pdfium(resource_dir, pdf_path, p)
            .map(|res| normalize_ws(&res.full_text))
            .unwrap_or_default();
        page_texts.push(txt);
    }

    // Sequentially match each heading to its rendered page (monotonic forward scan)
    let mut resolved_pages: Vec<usize> = Vec::with_capacity(filtered.len());
    let mut cursor_page = 0usize;
    for h in &filtered {
        let needle = normalize_ws(&h.title);
        let short_needle: String = needle.chars().take(28).collect();
        let mut found = None;
        for (idx, ptext) in page_texts.iter().enumerate().skip(cursor_page) {
            if ptext.contains(&needle)
                || (!short_needle.is_empty() && ptext.contains(&short_needle))
            {
                found = Some(idx);
                break;
            }
        }
        let matched_idx = found.unwrap_or(cursor_page);
        cursor_page = matched_idx;
        resolved_pages.push(matched_idx + 1);
    }

    let mut doc = Document::load(pdf_path).map_err(|_| {
        AppError::new(
            "PDF_WRITE_FAILED",
            "Unable to open rendered PDF for bookmark injection.",
        )
    })?;
    let pages_map = doc.get_pages();
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|_| AppError::new("PDF_WRITE_FAILED", "Rendered PDF has no Catalog object."))?;

    // Build flat/nested outline nodes: H1 at root, H2 under last H1 (or root), H3 under last H2 (or H1/root)
    struct Node {
        title: String,
        page_id: ObjectId,
        obj_id: ObjectId,
        parent: Option<usize>,
        children: Vec<usize>,
    }

    let mut nodes: Vec<Node> = Vec::new();
    let mut root_children: Vec<usize> = Vec::new();
    let mut last_h1: Option<usize> = None;
    let mut last_h2: Option<usize> = None;

    for (h, &page_num) in filtered.iter().zip(resolved_pages.iter()) {
        let Some(&page_id) = pages_map.get(&(page_num as u32)) else {
            continue;
        };
        let obj_id = doc.new_object_id();
        let node_idx = nodes.len();
        let parent = match h.level {
            1 => {
                last_h1 = Some(node_idx);
                last_h2 = None;
                None
            }
            2 => {
                last_h2 = Some(node_idx);
                last_h1
            }
            _ => last_h2.or(last_h1),
        };
        nodes.push(Node {
            title: h.title.clone(),
            page_id,
            obj_id,
            parent,
            children: Vec::new(),
        });
        if let Some(p_idx) = parent {
            nodes[p_idx].children.push(node_idx);
        } else {
            root_children.push(node_idx);
        }
    }

    if nodes.is_empty() {
        return Ok(0);
    }

    let outlines_root_id = doc.new_object_id();

    // Helper to count visible descendants
    fn count_descendants(nodes: &[Node], idx: usize) -> usize {
        let mut total = nodes[idx].children.len();
        for &c in &nodes[idx].children {
            total += count_descendants(nodes, c);
        }
        total
    }

    // Write every outline node with accurate Parent/Prev/Next/First/Last/Count/Dest
    for i in 0..nodes.len() {
        let parent_obj_id = nodes[i]
            .parent
            .map(|p| nodes[p].obj_id)
            .unwrap_or(outlines_root_id);
        let siblings: &[usize] = match nodes[i].parent {
            Some(p) => &nodes[p].children,
            None => &root_children,
        };
        let pos = siblings.iter().position(|&x| x == i).unwrap_or(0);
        let prev_id = if pos > 0 {
            Some(nodes[siblings[pos - 1]].obj_id)
        } else {
            None
        };
        let next_id = if pos + 1 < siblings.len() {
            Some(nodes[siblings[pos + 1]].obj_id)
        } else {
            None
        };

        let mut dict = dictionary! {
            "Title" => encode_pdf_utf16be_string(&nodes[i].title),
            "Parent" => parent_obj_id,
            "Dest" => vec![
                Object::Reference(nodes[i].page_id),
                Object::Name(b"FitH".to_vec()),
                Object::Null,
            ],
        };
        if let Some(prev) = prev_id {
            dict.set("Prev", prev);
        }
        if let Some(next) = next_id {
            dict.set("Next", next);
        }
        if !nodes[i].children.is_empty() {
            let first = nodes[*nodes[i].children.first().unwrap()].obj_id;
            let last = nodes[*nodes[i].children.last().unwrap()].obj_id;
            let desc = count_descendants(&nodes, i) as i64;
            dict.set("First", first);
            dict.set("Last", last);
            dict.set("Count", Object::Integer(desc));
        }
        doc.objects
            .insert(nodes[i].obj_id, Object::Dictionary(dict));
    }

    let first_root = nodes[*root_children.first().unwrap()].obj_id;
    let last_root = nodes[*root_children.last().unwrap()].obj_id;
    let root_dict = dictionary! {
        "Type" => "Outlines",
        "First" => first_root,
        "Last" => last_root,
        "Count" => Object::Integer(nodes.len() as i64),
    };
    doc.objects
        .insert(outlines_root_id, Object::Dictionary(root_dict));

    if let Ok(Object::Dictionary(ref mut cat)) = doc.get_object_mut(catalog_id) {
        cat.set("Outlines", outlines_root_id);
        cat.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
    }

    let mut out_bytes = Vec::new();
    doc.save_to(&mut out_bytes).map_err(|e| {
        AppError::new(
            "PDF_WRITE_FAILED",
            format!("Failed saving PDF with heading bookmarks: {e}"),
        )
    })?;
    fs::write(pdf_path, &out_bytes)
        .map_err(|e| AppError::from_io(e, "Failed updating rendered PDF with bookmarks"))?;

    Ok(nodes.len())
}

pub fn export_markdown_to_pdf_impl<F>(
    pdf_session: &PdfSessionManager,
    req: &MarkdownToPdfRequest,
    task_id: &str,
    cancel: &AtomicBool,
    mut emit_progress: F,
) -> Result<MarkdownToPdfResult, AppError>
where
    F: FnMut(PdfTaskProgressPayload),
{
    if req.markdown.trim().is_empty() {
        return Err(AppError::invalid_param(
            "Markdown content must not be empty.",
        ));
    }
    if req.markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(AppError::size_limit(format!(
            "Markdown input exceeds the {} MiB safety limit.",
            MAX_MARKDOWN_BYTES / (1024 * 1024)
        )));
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P23".to_string(),
        current: 10,
        total: 100,
        percent: 10.0,
        detail: "Parsing and sanitizing Markdown AST".to_string(),
    });

    let preview = render_markdown_preview_impl(&MarkdownPreviewRequest {
        markdown: req.markdown.clone(),
        source_dir: req.source_dir.clone(),
        theme: req.theme.clone(),
        paper_size: req.paper_size.clone(),
        margin_preset: req.margin_preset.clone(),
        header_text: req.header_text.clone(),
        footer_text: req.footer_text.clone(),
        show_page_numbers: req.show_page_numbers,
        locale: req.locale.clone(),
    })?;

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let edge_bin = find_windows_edge_binary()?;
    let atomic = AtomicPdfOutput::prepare(&req.output_path, &[], req.overwrite)?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let work_dir = std::env::temp_dir().join(format!("winkit_p23_{}_{stamp}", std::process::id()));
    fs::create_dir_all(&work_dir).map_err(|e| {
        AppError::from_io(e, "Unable to create temporary workspace for Markdown PDF")
    })?;
    let _work_guard = TempDirGuard(work_dir.clone());

    let html_path = work_dir.join("document.html");
    let edge_profile = work_dir.join("edge_profile");
    fs::write(&html_path, preview.html_document.as_bytes())
        .map_err(|e| AppError::from_io(e, "Unable to write sanitized HTML for PDF export"))?;

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P23".to_string(),
        current: 35,
        total: 100,
        percent: 35.0,
        detail: "Rendering paginated vector PDF offline".to_string(),
    });

    let file_uri = path_to_file_uri(&html_path);
    let mut cmd = Command::new(&edge_bin);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--disable-javascript",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-pdf-header-footer",
    ])
    .arg(format!(
        "--user-data-dir={}",
        edge_profile.to_string_lossy()
    ))
    .arg(format!(
        "--print-to-pdf={}",
        atomic.temp_path().to_string_lossy()
    ))
    .arg(file_uri)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::new(
            "PDF_MARKDOWN_ENGINE_MISSING",
            format!("Unable to launch offline PDF renderer: {e}"),
        )
    })?;

    #[cfg(windows)]
    let job_guard =
        crate::pdf_worker::job_guard::WindowsJobGuard::attach_tree_kill_on_close(&child);

    let deadline = Instant::now() + EDGE_RENDER_TIMEOUT;
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            #[cfg(windows)]
            if let Some(ref g) = job_guard {
                g.killer().terminate_now();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::cancelled());
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() >= deadline {
                    #[cfg(windows)]
                    if let Some(ref g) = job_guard {
                        g.killer().terminate_now();
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::new(
                        "PDF_WORKER_TIMEOUT",
                        "Markdown PDF rendering timed out and was terminated safely.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => {
                return Err(AppError::new(
                    "PDF_WRITE_FAILED",
                    format!("Failed waiting for offline PDF renderer: {e}"),
                ));
            }
        }
    };

    // Explicitly terminate any remaining Chromium helper processes in the Job Object before accessing the PDF
    #[cfg(windows)]
    drop(job_guard);

    if !status.success() || !atomic.temp_path().is_file() {
        return Err(AppError::new(
            "PDF_WRITE_FAILED",
            "Offline PDF renderer did not produce a valid PDF output.",
        ));
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let resource_dir = pdf_session.resource_dir();
    let initial_info = inspect_with_pdfium(resource_dir.as_deref(), atomic.temp_path())?;
    if initial_info.page_count == 0 {
        return Err(AppError::new(
            "PDF_WRITE_FAILED",
            "Rendered Markdown PDF reported 0 pages.",
        ));
    }

    let mut bookmark_count = 0usize;
    let mut warnings = preview.warnings;
    if req.include_bookmarks && !preview.headings.is_empty() {
        emit_progress(PdfTaskProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "P23".to_string(),
            current: 78,
            total: 100,
            percent: 78.0,
            detail: "Building PDF heading bookmarks".to_string(),
        });
        match inject_heading_bookmarks(
            atomic.temp_path(),
            resource_dir.as_deref(),
            &preview.headings,
            initial_info.page_count,
        ) {
            Ok(n) => bookmark_count = n,
            Err(_) => {
                warnings.push(
                    "PDF exported cleanly, but heading bookmark injection was skipped.".to_string(),
                );
            }
        }
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P23".to_string(),
        current: 92,
        total: 100,
        percent: 92.0,
        detail: "Verifying final PDF output".to_string(),
    });

    let final_info = inspect_with_pdfium(resource_dir.as_deref(), atomic.temp_path())?;
    let (final_path, byte_length) = atomic.commit_existing_tmp()?;

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P23".to_string(),
        current: 100,
        total: 100,
        percent: 100.0,
        detail: "Markdown PDF export complete".to_string(),
    });

    Ok(MarkdownToPdfResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_length,
        page_count: final_info.page_count,
        bookmark_count,
        embedded_local_images: preview.embedded_local_images,
        blocked_remote_images: preview.blocked_remote_images,
        blocked_local_images: preview.blocked_local_images,
        stripped_raw_html_count: preview.stripped_raw_html_count,
        has_text_layer: final_info.has_text_layer,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use tempfile::tempdir;

    #[test]
    fn p23_sanitizes_xss_remote_images_traversal_and_exports_bookmarked_cjk_pdf() {
        let dir = tempdir().expect("tempdir");
        // Create a valid relative PNG inside the document folder
        let img_path = dir.path().join("diagram.png");
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(64, 32, Rgba([37, 99, 235, 255]));
        img.save(&img_path).expect("save local png");

        let md = r#"# 第一章：WinKit 离线文档导出

这是一段 **中英文混排** 示例，包含 [官方文档外链](https://example.com/winkit-docs) 与 [恶意脚本链接](javascript:alert(1))。

<script>window.pwned = true;</script>
<img src="https://evil.example/tracker.png" />

![本地示意图](diagram.png)
![远程拦截图](https://evil.example/remote.png)
![越权路径拦截](../secret.png)
![绝对路径拦截](file:///C:/Windows/win.ini)

## 1.1 功能矩阵表格

| 模块 | 状态 | 说明 |
| :--- | :---: | ---: |
| 离线排版 | 通过 | 零远程网络请求 |
| 代码换行 | 通过 | 超长代码行自动折行 |

> 引用块：支持嵌套列表与任务清单。

- [x] 已完成离线渲染
- [ ] 待人工验收
  - 嵌套子项 Alpha
  - 嵌套子项 Beta

```ts
export const veryLongLineForWrappingVerification = "这是一段很长的中英文代码测试行_abcdefghijklmnopqrstuvwxyz_0123456789_用于验证不会截断超出页面宽度";
```

---

# 第二章：书签与多页验证

这里补充多段正文以确保内容自然排布并在导出 PDF 中生成清晰的多级标题书签。
"#;

        // 1. Verify HTML preview security invariants
        let prev = render_markdown_preview_impl(&MarkdownPreviewRequest {
            markdown: md.to_string(),
            source_dir: Some(dir.path().to_string_lossy().into_owned()),
            theme: "github".to_string(),
            paper_size: "a4".to_string(),
            margin_preset: "normal".to_string(),
            header_text: Some("WinKit P23 Header".to_string()),
            footer_text: Some("Local Offline Export".to_string()),
            show_page_numbers: true,
            locale: Some("zh-CN".to_string()),
        })
        .expect("render markdown preview");

        assert_eq!(prev.embedded_local_images, 1);
        assert_eq!(prev.blocked_remote_images, 1);
        assert_eq!(prev.blocked_local_images, 2);
        assert!(prev.stripped_raw_html_count >= 2);
        assert!(!prev.html_document.contains("<script>"));
        assert!(!prev.html_document.contains("javascript:alert"));
        assert!(prev.html_document.contains("data:image/png;base64,"));
        assert_eq!(prev.headings.len(), 3);

        // 2. Verify full offline PDF export + selectable text + clickable URI link + PDF bookmarks!
        let out_pdf = dir.path().join("中文 Markdown 导出.pdf");
        let session = PdfSessionManager::default();
        let cancel = AtomicBool::new(false);
        let res = export_markdown_to_pdf_impl(
            &session,
            &MarkdownToPdfRequest {
                markdown: md.to_string(),
                source_dir: Some(dir.path().to_string_lossy().into_owned()),
                output_path: out_pdf.to_string_lossy().into_owned(),
                overwrite: false,
                theme: "github".to_string(),
                paper_size: "a4".to_string(),
                margin_preset: "normal".to_string(),
                header_text: Some("WinKit P23 Header".to_string()),
                footer_text: Some("Local Offline Export".to_string()),
                show_page_numbers: true,
                include_bookmarks: true,
                locale: Some("zh-CN".to_string()),
            },
            "p23-test",
            &cancel,
            |_| {},
        )
        .expect("export markdown to pdf");

        assert!(res.page_count >= 1);
        assert!(res.has_text_layer);
        assert_eq!(res.bookmark_count, 3);
        assert_eq!(res.embedded_local_images, 1);
        assert_eq!(res.blocked_remote_images, 1);
        assert_eq!(res.blocked_local_images, 2);

        let inspected = inspect_with_pdfium(None, &out_pdf).expect("pdfium inspect exported pdf");
        assert_eq!(
            inspected.outlines.len(),
            2,
            "two H1 root bookmarks (H2 nested under first H1)"
        );
        assert_eq!(inspected.outlines[0].title, "第一章：WinKit 离线文档导出");
        assert_eq!(inspected.outlines[0].children.len(), 1);
        assert_eq!(inspected.outlines[0].children[0].title, "1.1 功能矩阵表格");
        assert_eq!(inspected.outlines[1].title, "第二章：书签与多页验证");

        let p1 = extract_page_text_with_pdfium(None, &out_pdf, 1).expect("page 1 text");
        assert!(p1.full_text.contains("中英文混排"));
        assert!(p1.full_text.contains("WinKit P23 Header"));
        assert!(
            p1.links
                .iter()
                .any(|l| l.uri.as_deref() == Some("https://example.com/winkit-docs")),
            "expected clickable https URI link in rendered PDF, got: {:?}",
            p1.links
        );
        assert!(
            !p1.links
                .iter()
                .any(|l| l.uri.as_deref().unwrap_or("").starts_with("javascript:")),
            "javascript: URI must never appear as a link"
        );
    }
}
