import { describe, expect, test } from "vitest";

import {
  formatBytes,
  formatPercent,
  formatSpeed,
} from "../../lib/ui/format.helper";

describe("formatBytes", () => {
  test.each([
    [0, "0 KB"],
    [512 * 1024, "512 KB"],
    [1024 * 1024 - 1, "1.024 KB"],
    [1024 * 1024, "1,0 MB"],
    [84_200_000, "80,3 MB"],
    [1024 ** 3, "1,00 GB"],
    [1.25 * 1024 ** 3, "1,25 GB"],
  ])("should write %d bytes as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatSpeed", () => {
  test("should write a speed per second, in Turkish", () => {
    expect(formatSpeed(1_258_291)).toBe("1,2 MB/sn");
    expect(formatSpeed(200 * 1024)).toBe("200 KB/sn");
  });
});

describe("formatPercent", () => {
  test.each([
    [0, "%0"],
    [42.7, "%42"],
    [99.99, "%99"],
    [100, "%100"],
  ])("should write %d as %s, never rounding up", (value, text) => {
    expect(formatPercent(value)).toBe(text);
  });
});
