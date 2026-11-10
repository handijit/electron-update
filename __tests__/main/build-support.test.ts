import { describe, expect, test, vi } from "vitest";

import detectBuildSupport from "../../lib/main/build-support";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

const DEVELOPER_ID = [
  "Executable=/Applications/Demo.app/Contents/MacOS/Demo",
  "Identifier=com.handijit.demo",
  "Authority=Developer ID Application: Han Dijit (ABCDE12345)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
].join("\n");

/** Makes `codesign` answer on stderr, as the real one does. */
const codesignSays = (stderr: string, error: Error | null = null): void => {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: object, done: Callback) => {
      done(error, "", stderr);
    }
  );
};

const FACTS = {
  platform: "darwin",
  arch: "arm64",
  isPackaged: true,
  isDevelopmentForced: false,
  executablePath: "/Applications/Demo.app/Contents/MacOS/Demo",
};

describe("detectBuildSupport", () => {
  test.each([
    ["linux", "x64"],
    ["freebsd", "arm64"],
    ["win32", "ia32"],
    ["darwin", "ppc"],
  ])("should have no release for %s on %s", async (platform, arch) => {
    expect(await detectBuildSupport({ ...FACTS, platform, arch })).toBe(
      "platform"
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  test("should call an unpackaged run a development build", async () => {
    expect(await detectBuildSupport({ ...FACTS, isPackaged: false })).toBe(
      "development"
    );
    expect(
      await detectBuildSupport({
        ...FACTS,
        platform: "win32",
        isPackaged: false,
      })
    ).toBe("development");
  });

  test("should accept every packaged Windows build: the installer is verified by its checksum, not by a signature", async () => {
    expect(
      await detectBuildSupport({ ...FACTS, platform: "win32", arch: "x64" })
    ).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  test("should accept an unpackaged run that asked for updates, on Windows without looking further", async () => {
    expect(
      await detectBuildSupport({
        ...FACTS,
        platform: "win32",
        isPackaged: false,
        isDevelopmentForced: true,
      })
    ).toBeNull();
  });

  test("should accept a macOS build signed with a Developer ID, asking codesign about the bundle", async () => {
    codesignSays(DEVELOPER_ID);

    expect(await detectBuildSupport(FACTS)).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/codesign",
      ["--display", "--verbose=2", "/Applications/Demo.app"],
      { timeout: 5000 },
      expect.any(Function)
    );
  });

  test.each([
    ["an ad-hoc signature", "Identifier=demo\nSignature=adhoc"],
    [
      "a development certificate",
      "Authority=Apple Development: someone@example.com (ABCDE12345)",
    ],
    [
      "a mention that is not an authority line",
      "x Authority=Developer ID Application: y",
    ],
  ])("should call a macOS build with %s unsigned", async (_name, stderr) => {
    codesignSays(stderr);

    expect(await detectBuildSupport(FACTS)).toBe("unsigned");
  });

  test("should call a macOS build unsigned when codesign fails or is not there", async () => {
    codesignSays(
      "code object is not signed at all",
      new Error("Command failed")
    );
    expect(await detectBuildSupport(FACTS)).toBe("unsigned");

    // Even if the output looked right: a failed codesign proves nothing.
    codesignSays(DEVELOPER_ID, new Error("ENOENT"));
    expect(await detectBuildSupport(FACTS)).toBe("unsigned");
  });
});
