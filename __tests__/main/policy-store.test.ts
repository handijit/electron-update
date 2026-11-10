import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import createPolicyStore from "../../lib/main/policy-store";

const mocks = vi.hoisted(() => ({
  app: { getPath: vi.fn<(name: string) => string>() },
}));

vi.mock("electron", () => ({ app: mocks.app }));

const POLICY = {
  latestVersion: "1.5.0",
  minSupportedVersion: "1.4.5",
  fetchedAt: 1_800_000_000_000,
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hd-electron-update-policy-"));
  mocks.app.getPath.mockReturnValue(directory);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("createPolicyStore", () => {
  test("should touch nothing until it is used, then have no policy in a new folder", async () => {
    const store = createPolicyStore({ directory });
    expect(readdirSync(directory)).toEqual([]);

    expect(await store.read()).toBeNull();
  });

  test("should keep a policy across a restart, in update-policy.json", async () => {
    await createPolicyStore({ directory }).write(POLICY);

    expect(readdirSync(directory)).toEqual(["update-policy.json"]);
    expect(
      JSON.parse(readFileSync(join(directory, "update-policy.json"), "utf8"))
    ).toEqual({ policy: POLICY });
    expect(await createPolicyStore({ directory }).read()).toEqual(POLICY);
  });

  test("should remove the policy when asked to store none", async () => {
    const store = createPolicyStore({ directory });
    await store.write({ ...POLICY, minSupportedVersion: null });
    expect(await store.read()).toEqual({
      ...POLICY,
      minSupportedVersion: null,
    });

    await store.write(null);

    expect(await store.read()).toBeNull();
    expect(await createPolicyStore({ directory }).read()).toBeNull();
  });

  test("should live in the user data folder by default", async () => {
    await createPolicyStore().write(POLICY);

    expect(mocks.app.getPath).toHaveBeenCalledWith("userData");
    expect(readdirSync(directory)).toEqual(["update-policy.json"]);
  });

  test("should set a broken file aside and start without a policy", async () => {
    writeFileSync(join(directory, "update-policy.json"), "{ not json");

    expect(await createPolicyStore({ directory }).read()).toBeNull();
    expect(
      readdirSync(directory).some((name) =>
        name.startsWith("update-policy.json.corrupt-")
      )
    ).toBe(true);
  });

  test("should treat a file of another shape as broken too", async () => {
    writeFileSync(
      join(directory, "update-policy.json"),
      JSON.stringify({ policy: { latestVersion: 15 } })
    );

    expect(await createPolicyStore({ directory }).read()).toBeNull();
  });

  test("should try to open the file again after a failure", async () => {
    // A file where the folder should be: nothing can be read from "inside" it.
    const blocked = join(directory, "profile");
    writeFileSync(blocked, "");
    const store = createPolicyStore({ directory: blocked });

    await expect(store.read()).rejects.toThrow();
    await expect(store.write(POLICY)).rejects.toThrow();

    rmSync(blocked);
    mkdirSync(blocked);
    await store.write(POLICY);
    expect(await store.read()).toEqual(POLICY);
  });
});
