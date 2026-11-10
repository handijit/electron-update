import { describe, expect, test, vi } from "vitest";

import createEngineLogger, { sanitizeLine } from "../../lib/main/engine-logger";

const HOME = "/Users/ayse.yilmaz";

describe("sanitizeLine", () => {
  test("should replace the home folder, which holds the account name", () => {
    expect(
      sanitizeLine(
        `Cached update at ${HOME}/Library/Caches/demo-updater/pending`,
        HOME
      )
    ).toBe("Cached update at ~/Library/Caches/demo-updater/pending");
  });

  test("should replace any account folder, also one that is not Node's home", () => {
    expect(
      sanitizeLine(
        "Code signature at URL file:///Users/mehmet/Library/Caches/tr.com.handijit.demo.ShipIt/update.Zs1/Demo.app/ did not pass validation",
        HOME
      )
    ).toBe(
      "Code signature at URL file://~/Library/Caches/tr.com.handijit.demo.ShipIt/update.Zs1/Demo.app/ did not pass validation"
    );
    expect(
      sanitizeLine(
        String.raw`spawn C:\Users\Ayşe Yılmaz\AppData\Local\demo-updater\pending\Demo-Setup.exe EACCES, /home/ali/demo`,
        ""
      )
    ).toBe(
      String.raw`spawn ~\AppData\Local\demo-updater\pending\Demo-Setup.exe EACCES, ~/demo`
    );
  });

  test("should drop the installation's rollout id and the query of a URL", () => {
    expect(
      sanitizeLine(
        "staging user id: 0b6e2c1a-52c1-4f0e-9a43-0d6b1f0d7e11, url https://indir.handijit.com/demo/latest.yml?noCache=1jk2&token=abc done",
        HOME
      )
    ).toBe(
      "staging user id: <id>, url https://indir.handijit.com/demo/latest.yml done"
    );
  });

  test("should keep the first line only: the rest is a stack", () => {
    expect(
      sanitizeLine(
        new Error(`Cannot download\n    at ${HOME}/app/main.js:1:1`),
        HOME
      )
    ).toBe("Cannot download");
    expect(sanitizeLine("", HOME)).toBe("");
  });

  test("should cut a line that is too long and accept anything as a message", () => {
    expect(sanitizeLine("x".repeat(900), HOME)).toHaveLength(400);
    expect(sanitizeLine(undefined, HOME)).toBe("undefined");
    expect(sanitizeLine(42, "")).toBe("42");
  });
});

describe("createEngineLogger", () => {
  test("should write the engine's chatter at debug and its complaints as warnings", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const engineLogger = createEngineLogger(logger, HOME);

    engineLogger.info("Checking for update");
    engineLogger.warn(`Cannot read ${HOME}/cache`);
    engineLogger.error(new Error("Boom\n  at stack"));

    expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
      "engine: Checking for update"
    );
    expect(logger.warn.mock.calls).toEqual([
      ["engine: Cannot read ~/cache"],
      ["engine: Boom"],
    ]);
    // Failures that matter arrive as events and are logged there, with their stable code.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
