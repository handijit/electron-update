import { describe, expect, test } from "vitest";

import { UPDATE_ERROR_CODES } from "../../lib/shared/update-state.constants";
import {
  causeCodeOf,
  classifyError,
  isMissingFeed,
  toUpdateError,
  UPDATE_ERROR_MESSAGES,
} from "../../lib/main/update-error";

const coded = (code: string, message = "failed"): Error =>
  Object.assign(new Error(message), { code });

describe("classifyError", () => {
  test.each([
    ["ERR_CHECKSUM_MISMATCH", "CHECKSUM"],
    ["ERR_UPDATER_INVALID_SIGNATURE", "SIGNATURE"],
    ["ERR_UPDATER_INVALID_UPDATE_INFO", "INVALID_FEED"],
    ["ERR_UPDATER_INVALID_VERSION", "INVALID_FEED"],
    ["ERR_UPDATER_NO_FILES_PROVIDED", "INVALID_FEED"],
    ["ERR_UPDATER_ZIP_FILE_NOT_FOUND", "INVALID_FEED"],
    ["ERR_UPDATER_NO_CHECKSUM", "INVALID_FEED"],
    ["ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "SERVER"],
    ["ERR_UPDATER_ASSET_NOT_FOUND", "SERVER"],
    ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "SERVER"],
    ["HTTP_ERROR_502", "SERVER"],
    ["HTTP_ERROR_404", "SERVER"],
    ["ENOSPC", "DISK"],
    ["EACCES", "DISK"],
    ["EPERM", "DISK"],
    ["ENOTFOUND", "OFFLINE"],
    ["ECONNREFUSED", "OFFLINE"],
    ["ETIMEDOUT", "OFFLINE"],
    ["ERR_INTERNET_DISCONNECTED", "OFFLINE"],
  ] as const)("should map the code %s to %s", (code, expected) => {
    expect(classifyError(coded(code))).toBe(expected);
  });

  test.each([
    ["net::ERR_INTERNET_DISCONNECTED", "OFFLINE"],
    ["net::ERR_NAME_NOT_RESOLVED", "OFFLINE"],
    [
      "Cannot update while running on a read-only volume. The application is on a read-only volume.",
      "NOT_IN_APPLICATIONS",
    ],
    ["Could not get code signature for running application", "SIGNATURE"],
    [
      "Code signature at URL file:///x did not pass validation: code object is not signed at all",
      "SIGNATURE",
    ],
    ["code failed to satisfy specified code requirement(s)", "SIGNATURE"],
    ["No update filepath provided, can't quit and install", "INSTALL"],
    ["something nobody has seen before", "UNKNOWN"],
  ] as const)("should read the message %j as %s", (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  test("should classify what is not an error at all as unknown", () => {
    expect(classifyError(undefined)).toBe("UNKNOWN");
    expect(classifyError(null)).toBe("UNKNOWN");
    expect(classifyError("net::ERR_FAILED")).toBe("OFFLINE");
    expect(classifyError({ code: 404, message: 12 })).toBe("UNKNOWN");
  });

  test("should let a code win over what the message suggests", () => {
    expect(
      classifyError(coded("ERR_CHECKSUM_MISMATCH", "net::ERR_FAILED"))
    ).toBe("CHECKSUM");
  });
});

describe("isMissingFeed", () => {
  test("should recognise only the missing channel file", () => {
    expect(isMissingFeed(coded("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"))).toBe(
      true
    );
    expect(isMissingFeed(coded("HTTP_ERROR_404"))).toBe(false);
    expect(isMissingFeed("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")).toBe(false);
  });
});

describe("toUpdateError", () => {
  test("should have a Turkish sentence for every code", () => {
    expect(Object.keys(UPDATE_ERROR_MESSAGES).sort()).toEqual(
      [...UPDATE_ERROR_CODES].sort()
    );
    for (const code of UPDATE_ERROR_CODES) {
      const error = toUpdateError(code);

      expect(error.code).toBe(code);
      expect(error.message).toMatch(/[.!]$/);
      // A sentence for a customer: no error code, no English jargon.
      expect(error.message).not.toMatch(/ERR_|error|update/i);
    }
  });
});

describe("causeCodeOf", () => {
  test("should read the code of a cause, and nothing from what has none", () => {
    expect(causeCodeOf(coded("ENOSPC"))).toBe("ENOSPC");
    expect(causeCodeOf(new Error("plain"))).toBe("");
    expect(causeCodeOf(42)).toBe("");
  });
});
