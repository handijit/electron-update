import { describe, expect, test } from "vitest";

import {
  toUpdateInfo,
  toUpdateProgress,
} from "../../lib/main/update-info.helper";

describe("toUpdateInfo", () => {
  test("should keep the version, the date, the notes and the size of the file that will be downloaded", () => {
    const info = toUpdateInfo(
      {
        version: "1.5.0",
        releaseDate: "2026-11-09T10:00:00.000Z",
        releaseNotes: "Yeni: e-fatura.",
        files: [
          { url: "Demo-1.5.0-x64.dmg", size: 90_000_000 },
          { url: "Demo-1.5.0-x64.zip", size: 85_000_000 },
          { url: "Demo-1.5.0-arm64.zip", size: 80_000_000 },
        ],
        path: "Demo-1.5.0-x64.zip",
        sha512: "abc",
      },
      "darwin",
      "arm64"
    );

    expect(info).toEqual({
      version: "1.5.0",
      releaseDate: "2026-11-09T10:00:00.000Z",
      releaseNotes: "Yeni: e-fatura.",
      sizeBytes: 80_000_000,
    });
  });

  test("should take the installer on Windows, and the first one when none names the architecture", () => {
    const files = [
      { url: "Demo-Setup-1.5.0.exe.blockmap", size: 1 },
      { url: "Demo-Setup-1.5.0.exe", size: 70_000_000 },
    ];

    expect(
      toUpdateInfo({ version: "1.5.0", files }, "win32", "x64")?.sizeBytes
    ).toBe(70_000_000);
  });

  test("should say that the size is unknown rather than guess it", () => {
    const sizeOf = (files: unknown): number | null | undefined =>
      toUpdateInfo({ version: "1.5.0", files }, "win32", "x64")?.sizeBytes;

    expect(sizeOf(undefined)).toBeNull();
    expect(sizeOf("files")).toBeNull();
    expect(sizeOf([])).toBeNull();
    expect(sizeOf([null, "x", { url: 12 }])).toBeNull();
    expect(sizeOf([{ url: "a.exe" }])).toBeNull();
    expect(sizeOf([{ url: "a.exe", size: -5 }])).toBeNull();
    expect(sizeOf([{ url: "a.exe", size: Number.NaN }])).toBeNull();
  });

  test("should refuse a feed whose version is not a version", () => {
    expect(toUpdateInfo({ version: "latest" }, "win32", "x64")).toBeNull();
    expect(toUpdateInfo({ version: 15 }, "win32", "x64")).toBeNull();
    expect(toUpdateInfo({}, "win32", "x64")).toBeNull();
    expect(toUpdateInfo(null, "win32", "x64")).toBeNull();
    expect(toUpdateInfo("1.5.0", "win32", "x64")).toBeNull();
  });

  test("should turn release notes into plain text, whatever the feed carries", () => {
    const notesOf = (releaseNotes: unknown): string | null | undefined =>
      toUpdateInfo({ version: "1.5.0", releaseNotes }, "win32", "x64")
        ?.releaseNotes;

    expect(notesOf("<p>Hızlandı.</p><script>alert(1)</script>")).toBe(
      "Hızlandı.alert(1)"
    );
    expect(notesOf("a < b > c")).toBe("a  c");
    expect(notesOf("bir\n\n\n\n\niki  ")).toBe("bir\n\niki");
    expect(
      notesOf([
        { version: "1.5.0", note: "<b>Yeni</b> rapor" },
        { version: "1.4.5", note: null },
        "x",
        { version: "1.4.4", note: "Düzeltmeler" },
      ])
    ).toBe("Yeni rapor\n\nDüzeltmeler");
    expect(notesOf("   ")).toBeNull();
    expect(notesOf(undefined)).toBeNull();
    expect(notesOf(null)).toBeNull();
    expect(notesOf(42)).toBeNull();
    expect(notesOf("x".repeat(5000))).toHaveLength(4000);
  });

  test("should keep only a date that is one", () => {
    const dateOf = (releaseDate: unknown): string | null | undefined =>
      toUpdateInfo({ version: "1.5.0", releaseDate }, "win32", "x64")
        ?.releaseDate;

    expect(dateOf("2026-11-09T12:00:00+03:00")).toBe(
      "2026-11-09T09:00:00.000Z"
    );
    expect(dateOf("yesterday")).toBeNull();
    expect(dateOf(1_700_000_000_000)).toBeNull();
  });
});

describe("toUpdateProgress", () => {
  test("should carry the engine's numbers over", () => {
    expect(
      toUpdateProgress({
        percent: 42.5,
        transferred: 425,
        total: 1000,
        bytesPerSecond: 100,
        delta: 10,
      })
    ).toEqual({
      percent: 42.5,
      transferredBytes: 425,
      totalBytes: 1000,
      bytesPerSecond: 100,
    });
  });

  test("should keep every number in range, whatever arrives", () => {
    expect(
      toUpdateProgress({
        percent: 180,
        transferred: -1,
        total: Number.POSITIVE_INFINITY,
        bytesPerSecond: "fast",
      })
    ).toEqual({
      percent: 100,
      transferredBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    });
    expect(toUpdateProgress(undefined)).toEqual({
      percent: 0,
      transferredBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    });
  });
});
