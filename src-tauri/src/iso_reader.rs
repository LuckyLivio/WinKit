use crate::error::AppError;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};

const ISO_SECTOR_SIZE: u64 = 2048;
const MAX_ISO_DESCRIPTORS: u64 = 64;
const MAX_ISO_ENTRIES: usize = 50_000;
const MAX_ISO_DEPTH: usize = 64;
const MAX_ISO_DIR_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct IsoEntry {
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub extent_lba: u32,
    pub size: u64,
}

#[derive(Debug, Clone, Copy)]
struct RootDirLocation {
    extent_lba: u32,
    data_len: u32,
    is_joliet: bool,
}

fn read_u32_le(slice: &[u8]) -> u32 {
    u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]])
}

fn is_joliet_escape(esc: &[u8]) -> bool {
    esc.len() >= 3 && esc[0] == 0x25 && esc[1] == 0x2F && matches!(esc[2], 0x40 | 0x43 | 0x45)
}

fn decode_joliet_name(raw: &[u8]) -> String {
    let mut u16s = Vec::with_capacity(raw.len() / 2);
    let mut i = 0;
    while i + 1 < raw.len() {
        u16s.push(u16::from_be_bytes([raw[i], raw[i + 1]]));
        i += 2;
    }
    let decoded = String::from_utf16_lossy(&u16s);
    strip_iso_version_suffix(&decoded)
}

fn strip_iso_version_suffix(name: &str) -> String {
    let without_ver = match name.rfind(';') {
        Some(idx) if name[idx + 1..].chars().all(|c| c.is_ascii_digit()) => &name[..idx],
        _ => name,
    };
    without_ver.trim_end_matches('.').to_string()
}

/// Inspects Rock Ridge System Use fields (`NM` alternate name, `PX` POSIX symlink mode, `SL` symlink).
fn parse_rock_ridge_su(su: &[u8]) -> (Option<String>, bool) {
    let mut i = 0usize;
    let mut nm_bytes: Vec<u8> = Vec::new();
    let mut has_nm = false;
    let mut is_symlink = false;

    while i + 4 <= su.len() {
        let sig0 = su[i];
        let sig1 = su[i + 1];
        let len = su[i + 2] as usize;
        let ver = su[i + 3];
        if len < 4 || i + len > su.len() {
            break;
        }
        if ver == 1 {
            if sig0 == b'N' && sig1 == b'M' && len >= 5 {
                let flags = su[i + 4];
                // Ignore CURRENT (0x02) / PARENT (0x04) markers
                if (flags & 0x06) == 0 {
                    has_nm = true;
                    nm_bytes.extend_from_slice(&su[i + 5..i + len]);
                }
            } else if sig0 == b'S' && sig1 == b'L' {
                is_symlink = true;
            } else if sig0 == b'P' && sig1 == b'X' && len >= 12 {
                let mode = read_u32_le(&su[i + 4..i + 8]);
                if (mode & 0o170000) == 0o120000 {
                    is_symlink = true;
                }
            }
        }
        i += len;
    }

    let alt_name = if has_nm && !nm_bytes.is_empty() {
        Some(String::from_utf8_lossy(&nm_bytes).into_owned())
    } else {
        None
    };
    (alt_name, is_symlink)
}

fn locate_root_dir(file: &mut File, file_len: u64) -> Result<RootDirLocation, AppError> {
    let mut pvd: Option<RootDirLocation> = None;
    let mut joliet: Option<RootDirLocation> = None;
    let mut sector = [0u8; ISO_SECTOR_SIZE as usize];

    for idx in 0..MAX_ISO_DESCRIPTORS {
        let offset = (16 + idx) * ISO_SECTOR_SIZE;
        if offset + ISO_SECTOR_SIZE > file_len {
            break;
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| AppError::from_io(e, "Failed seeking ISO volume descriptor"))?;
        file.read_exact(&mut sector)
            .map_err(|e| AppError::from_io(e, "Failed reading ISO volume descriptor"))?;

        if &sector[1..6] != b"CD001" {
            break;
        }

        let desc_type = sector[0];
        if desc_type == 255 {
            break;
        }

        // Root directory record starts at byte 156 (34 bytes minimum)
        let root_rec = &sector[156..190];
        if root_rec[0] < 34 {
            continue;
        }
        let extent_lba = read_u32_le(&root_rec[2..6]);
        let data_len = read_u32_le(&root_rec[10..14]);

        if desc_type == 1 && pvd.is_none() {
            pvd = Some(RootDirLocation {
                extent_lba,
                data_len,
                is_joliet: false,
            });
        } else if desc_type == 2 && is_joliet_escape(&sector[88..91]) && joliet.is_none() {
            joliet = Some(RootDirLocation {
                extent_lba,
                data_len,
                is_joliet: true,
            });
        }
    }

    joliet.or(pvd).ok_or_else(|| {
        AppError::decode_failed("File does not contain a valid ISO 9660 volume descriptor.")
    })
}

pub fn list_iso_entries(file: &mut File) -> Result<Vec<IsoEntry>, AppError> {
    let file_len = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Cannot inspect ISO file"))?
        .len();
    let root = locate_root_dir(file, file_len)?;

    let mut entries: Vec<IsoEntry> = Vec::new();
    let mut visited_dirs: HashSet<(u32, u32)> = HashSet::new();
    let mut stack: Vec<(String, u32, u32, usize)> =
        vec![(String::new(), root.extent_lba, root.data_len, 0)];

    while let Some((prefix, lba, data_len, depth)) = stack.pop() {
        if depth > MAX_ISO_DEPTH || !visited_dirs.insert((lba, data_len)) {
            continue;
        }
        let len_usize = data_len as usize;
        if len_usize == 0 || len_usize > MAX_ISO_DIR_BYTES {
            continue;
        }
        let byte_offset = (lba as u64).saturating_mul(ISO_SECTOR_SIZE);
        if byte_offset.saturating_add(data_len as u64) > file_len {
            return Err(AppError::decode_failed(
                "ISO directory extent exceeds archive file bounds.",
            ));
        }

        file.seek(SeekFrom::Start(byte_offset))
            .map_err(|e| AppError::from_io(e, "Failed seeking ISO directory"))?;
        let mut dir_buf = vec![0u8; len_usize];
        file.read_exact(&mut dir_buf)
            .map_err(|e| AppError::from_io(e, "Failed reading ISO directory"))?;

        let mut child_dirs: Vec<(String, u32, u32, usize)> = Vec::new();
        let mut pos = 0usize;

        while pos < dir_buf.len() {
            let rec_len = dir_buf[pos] as usize;
            if rec_len == 0 {
                // Advance to next 2048-byte sector boundary
                let rem = pos % (ISO_SECTOR_SIZE as usize);
                pos += (ISO_SECTOR_SIZE as usize) - rem;
                continue;
            }
            if rec_len < 34 || pos + rec_len > dir_buf.len() {
                break;
            }
            let rec = &dir_buf[pos..pos + rec_len];
            pos += rec_len;

            let id_len = rec[32] as usize;
            if 33 + id_len > rec.len() {
                continue;
            }
            let raw_id = &rec[33..33 + id_len];
            // Skip `.` (0x00) and `..` (0x01) special directory entries
            if raw_id == [0x00] || raw_id == [0x01] {
                continue;
            }

            let entry_lba = read_u32_le(&rec[2..6]);
            let entry_size = read_u32_le(&rec[10..14]);
            let flags = rec[25];
            let is_dir = (flags & 0x02) != 0;

            let su_offset = 33 + id_len + usize::from(id_len.is_multiple_of(2));
            let (rr_name, is_symlink) = if su_offset < rec.len() {
                parse_rock_ridge_su(&rec[su_offset..])
            } else {
                (None, false)
            };

            let name = if let Some(alt) = rr_name {
                alt
            } else if root.is_joliet {
                decode_joliet_name(raw_id)
            } else {
                strip_iso_version_suffix(&String::from_utf8_lossy(raw_id))
            };

            if name.is_empty() || name == "." || name == ".." {
                continue;
            }

            let rel_path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };

            if entries.len() >= MAX_ISO_ENTRIES {
                return Err(AppError::size_limit(format!(
                    "ISO archive exceeds the {MAX_ISO_ENTRIES}-entry safety limit."
                )));
            }

            entries.push(IsoEntry {
                path: rel_path.clone(),
                is_dir,
                is_symlink,
                extent_lba: entry_lba,
                size: entry_size as u64,
            });

            if is_dir && !is_symlink {
                child_dirs.push((rel_path, entry_lba, entry_size, depth + 1));
            }
        }

        for sub in child_dirs.into_iter().rev() {
            stack.push(sub);
        }
    }

    Ok(entries)
}

pub fn stream_iso_entry<W: Write>(
    file: &mut File,
    entry: &IsoEntry,
    writer: &mut W,
    cancel_flag: &AtomicBool,
) -> Result<u64, AppError> {
    let file_len = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Cannot inspect ISO file"))?
        .len();
    let start = (entry.extent_lba as u64).saturating_mul(ISO_SECTOR_SIZE);
    if start.saturating_add(entry.size) > file_len {
        return Err(AppError::decode_failed(format!(
            "ISO entry \"{}\" extent exceeds archive bounds.",
            entry.path
        )));
    }

    file.seek(SeekFrom::Start(start))
        .map_err(|e| AppError::from_io(e, "Failed seeking ISO entry"))?;

    let mut remaining = entry.size;
    let mut written = 0u64;
    let mut buf = vec![0u8; 256 * 1024];

    while remaining > 0 {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let to_read = remaining.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..to_read])
            .map_err(|e| AppError::from_io(e, "Failed reading ISO entry data"))?;
        writer
            .write_all(&buf[..to_read])
            .map_err(|e| AppError::from_io(e, "Failed writing ISO entry data"))?;
        remaining -= to_read as u64;
        written += to_read as u64;
    }

    Ok(written)
}
