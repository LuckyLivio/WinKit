import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SUPPORT_MATRIX,
  createFormatRequiresPassword,
  extractBaseFileName,
  formatArchiveBytes,
  formatArchiveFormatLabel,
  getCreateExtension,
  isLikelyArchivePath,
  suggestCreateOutputFilename,
} from "./archiveModel";

describe("archiveModel", () => {
  it("formats archive labels and distinguishes single streams from tar archives", () => {
    expect(formatArchiveFormatLabel("tar_gz", "zh-CN")).toBe("TAR.GZ");
    expect(formatArchiveFormatLabel("single_gz", "zh-CN")).toBe("GZ 单文件");
    expect(formatArchiveFormatLabel("single_xz", "en-US")).toBe("XZ Stream");
    expect(formatArchiveFormatLabel("iso", "en-US")).toBe("ISO");
  });

  it("formats byte sizes cleanly", () => {
    expect(formatArchiveBytes(0)).toBe("0 B");
    expect(formatArchiveBytes(512)).toBe("512 B");
    expect(formatArchiveBytes(2048)).toBe("2.0 KiB");
    expect(formatArchiveBytes(5 * 1024 * 1024)).toBe("5.00 MiB");
  });

  it("suggests safe archive filenames and checks password requirement", () => {
    expect(createFormatRequiresPassword("zip")).toBe(false);
    expect(createFormatRequiresPassword("zip_aes256")).toBe(true);
    expect(createFormatRequiresPassword("zip_zipcrypto")).toBe(true);
    expect(createFormatRequiresPassword("tar_gz")).toBe(false);

    expect(getCreateExtension("zip_aes256")).toBe("zip");
    expect(getCreateExtension("tar_gz")).toBe("tar.gz");

    expect(suggestCreateOutputFilename(["D:\\Docs\\报告.txt"], "zip")).toBe("报告.zip");
    expect(suggestCreateOutputFilename(["D:\\Docs\\资料目录\\"], "tar_gz")).toBe("资料目录.tar.gz");
    expect(suggestCreateOutputFilename(["D:\\a.txt", "D:\\b.txt"], "zip_aes256")).toBe(
      "winkit-archive.zip",
    );
  });

  it("recognizes archive extensions and base filenames", () => {
    expect(extractBaseFileName("D:\\Work\\archive.tar.gz")).toBe("archive.tar.gz");
    expect(isLikelyArchivePath("C:\\Temp\\demo.tar.xz")).toBe(true);
    expect(isLikelyArchivePath("C:\\Temp\\disk.ISO")).toBe(true);
    expect(isLikelyArchivePath("C:\\Temp\\readme.txt")).toBe(false);
    expect(ARCHIVE_SUPPORT_MATRIX.length).toBeGreaterThanOrEqual(9);
  });
});
