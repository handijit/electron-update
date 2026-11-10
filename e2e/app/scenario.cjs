"use strict";

// The main-process half of the real-Electron smoke test. It starts the fixture program with
// the built package and the real `autoUpdater` of electron-updater, publishes a feed and a
// version policy on a server of its own, drives the page and writes one JSON file with every
// check it made. scripts/electron-smoke.mjs spawns it once per scenario and reads that file.
//
// Nothing here can install anything: the "installers" of the feed are random bytes.

const { execFileSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { createServer } = require("node:http");
const { userInfo } = require("node:os");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const { app, net } = require("electron");

const DIRECTORY = process.env.SMOKE_DIR;
const OUT = process.env.SMOKE_OUT;
const SCENARIO = process.env.SMOKE_SCENARIO;

const PRODUCT = "demo";
const CURRENT = "1.4.0";
const NEXT = "9.9.9";
const CACHE_NAME = "handijit-electron-update-smoke-updater";
const IS_MAC = process.platform === "darwin";
const OS = IS_MAC ? "macos" : "windows";
const CHANNEL_FILE = IS_MAC ? "latest-mac.yml" : "latest.yml";
const POLICY_PATH = `/api/public/products/${PRODUCT}/update-policy`;
const FEED_PATH = `/${PRODUCT}/`;
const MEGABYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEVER_MS = 6 * 60 * 60 * 1000;

const checks = [];
const notes = [];
const check = (name, ok, detail) => {
  checks.push({
    name,
    ok: ok === true,
    detail: ok === true ? undefined : detail,
  });
};
// A fact about this machine's run that is worth reading, not a pass or a fail.
const note = (text) => {
  notes.push(text);
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (label, read, isDone, milliseconds = 20_000) => {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; last: ${JSON.stringify(value)}`
      );
    }
    await sleep(40);
  }
};
const sha512 = (content) =>
  createHash("sha512").update(content).digest("base64");
const brief = (state) => ({
  status: state.status,
  ...(state.status === "unsupported" ? { reason: state.reason } : {}),
  ...(state.status === "error" ? { code: state.error.code } : {}),
  verdict: state.policy.verdict,
  isInstallPending: state.isInstallPending,
});

// --- the download server and the backend, in one ----------------------------------------

const startServers = () =>
  new Promise((resolve) => {
    const files = new Map();
    const requests = [];
    let policy = null;
    let chunkDelayMs = 0;

    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = decodeURIComponent(url.pathname);

      if (path === POLICY_PATH) {
        requests.push({
          kind: "policy",
          query: Object.fromEntries(url.searchParams),
        });
        const body =
          policy === null
            ? {
                status: 404,
                code: "RELEASE_NOT_FOUND",
                title: "Not Found",
                detail: "No release.",
              }
            : {
                product: PRODUCT,
                os: url.searchParams.get("os"),
                arch: url.searchParams.get("arch"),
                channel: url.searchParams.get("channel") ?? "stable",
                publishedAt: "2026-11-09T10:00:00Z",
                ...policy,
              };
        response
          .writeHead(policy === null ? 404 : 200, {
            "content-type":
              policy === null ? "application/problem+json" : "application/json",
          })
          .end(JSON.stringify(body));
        return;
      }

      const name = path.startsWith(FEED_PATH)
        ? path.slice(FEED_PATH.length)
        : null;
      const content = name === null ? undefined : files.get(name);
      requests.push({ kind: "feed", name, found: content !== undefined });
      if (content === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": content.length });
      if (chunkDelayMs === 0 || content.length < MEGABYTE) {
        response.end(content);
        return;
      }
      // A slow line: the engine reports progress once a second, so the download must last.
      let offset = 0;
      const send = () => {
        if (response.destroyed) return;
        const end = Math.min(offset + MEGABYTE / 2, content.length);
        response.write(content.subarray(offset, end));
        offset = end;
        if (offset >= content.length) response.end();
        else setTimeout(send, chunkDelayMs);
      };
      send();
    });

    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        baseUrl: origin,
        feedUrl: `${origin}${FEED_PATH}`,
        requests,
        setPolicy: (next) => {
          policy = next;
        },
        setChunkDelay: (milliseconds) => {
          chunkDelayMs = milliseconds;
        },
        put: (name, content) => files.set(name, content),
        clear: () => files.clear(),
        feedReads: () =>
          requests.filter(({ name }) => name === CHANNEL_FILE).length,
        payloadReads: (name) =>
          requests.filter((request) => request.name === name).length,
        policyReads: () =>
          requests.filter(({ kind }) => kind === "policy").length,
      });
    });
  });

// A port nothing listens on: what "offline" looks like from this computer.
const closedOrigin = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });

/**
 * The file a release holds for one architecture. On Windows it is never run, so random bytes
 * do. On macOS Squirrel.Mac unpacks it and compares its signature with the running
 * program's, so it is what electron-builder publishes: a zip of an application bundle with
 * the running program's bundle identifier. The bundle is unsigned and runs a shell script.
 */
let payloadCount = 0;
const createPayload = (megabytes) => {
  if (!IS_MAC) return randomBytes(megabytes * MEGABYTE);
  payloadCount += 1;
  const directory = join(DIRECTORY, "payloads", String(payloadCount));
  const contents = join(directory, "Demo.app", "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "<key>CFBundleIdentifier</key><string>com.github.Electron</string>",
      "<key>CFBundleExecutable</key><string>Demo</string>",
      "<key>CFBundleName</key><string>Demo</string>",
      "<key>CFBundlePackageType</key><string>APPL</string>",
      `<key>CFBundleShortVersionString</key><string>${NEXT}</string>`,
      `<key>CFBundleVersion</key><string>${NEXT}</string>`,
      "</dict></plist>",
      "",
    ].join("\n")
  );
  writeFileSync(join(contents, "MacOS", "Demo"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  // Random bytes do not compress: the zip is about as large as asked for.
  writeFileSync(
    join(contents, "Resources", "padding.bin"),
    randomBytes(megabytes * MEGABYTE)
  );
  const zip = join(directory, "Demo.zip");
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--keepParent",
    join(directory, "Demo.app"),
    zip,
  ]);
  return readFileSync(zip);
};

/**
 * Publishes a release the way electron-builder lays it out: one installer per architecture
 * and the channel file that names them with their size and checksum. Returns the installer
 * this computer's architecture is expected to take.
 */
const publish = (
  servers,
  { version, stagingPercentage, releaseNotes, megabytes = 1, isCorrupt = false }
) => {
  servers.clear();
  const names = IS_MAC
    ? [`Demo-${version}-arm64-mac.zip`, `Demo-${version}-mac.zip`]
    : [`Demo-Setup-${version}-x64.exe`, `Demo-Setup-${version}-arm64.exe`];
  const files = names.map((name) => {
    const content = createPayload(megabytes);
    servers.put(name, content);
    return {
      name,
      content,
      // A corrupt release: the file on the server is not the file the feed describes.
      sha512: sha512(isCorrupt ? content.subarray(1) : content),
    };
  });
  const [first] = files;
  servers.put(
    CHANNEL_FILE,
    Buffer.from(
      [
        `version: ${version}`,
        "files:",
        ...files.flatMap((file) => [
          `  - url: ${file.name}`,
          `    sha512: ${file.sha512}`,
          `    size: ${file.content.length}`,
        ]),
        `path: ${first.name}`,
        `sha512: ${first.sha512}`,
        "releaseDate: '2026-11-09T10:00:00.000Z'",
        ...(releaseNotes === undefined
          ? []
          : [`releaseNotes: ${JSON.stringify(releaseNotes)}`]),
        ...(stagingPercentage === undefined
          ? []
          : [`stagingPercentage: ${stagingPercentage}`]),
        "",
      ].join("\n")
    )
  );
  return files.find(({ name }) =>
    IS_MAC
      ? name.includes("arm64") === (process.arch === "arm64")
      : name.includes(process.arch)
  );
};

// Where the engine keeps a downloaded installer: the runner pointed HOME and LOCALAPPDATA
// at the scenario's own folder, so nothing is left on the machine.
const downloadedChecksums = () => {
  const directory = join(
    IS_MAC
      ? join(process.env.HOME, "Library", "Caches")
      : process.env.LOCALAPPDATA,
    CACHE_NAME,
    "pending"
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => !name.endsWith(".json"))
    .map((name) => sha512(readFileSync(join(directory, name))));
};

// --- the fixture program ------------------------------------------------------------------

/**
 * Starts the fixture program with `startApp` of @handijit/electron and one updater on the
 * real engine. `wiring` is how the updater reaches the page: "contract" spreads the
 * updater's fragment into the program's own contract, "standalone" calls registerUpdateIpc.
 */
const boot = async (
  dependencies,
  { wiring, baseUrl, feedUrl, isNetFetch = false, options = {} }
) => {
  const { api, desktop, desktopShared, engineModule, main, z } = dependencies;
  const { autoUpdater } = engineModule;

  // An unpackaged run has no app-update.yml (electron-builder writes it into a packaged
  // program); the engine reads the same settings from this file once it is told to.
  const configFile = join(DIRECTORY, "dev-app-update.yml");
  writeFileSync(
    configFile,
    `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: ${CACHE_NAME}\n`
  );
  autoUpdater.updateConfigPath = configFile;
  autoUpdater.forceDevUpdateConfig = true;

  // On Windows "restart and update" would run the downloaded file. It is random bytes, so
  // the call is recorded instead. On macOS the real one runs: Squirrel.Mac refuses by itself.
  const installs = [];
  if (!IS_MAC) {
    autoUpdater.quitAndInstall = (...parameters) => {
      installs.push(parameters);
    };
  }

  const opened = [];
  const trace = [];
  const pageErrors = [];
  // What the real engine reported, word for word, with this run's folders taken out.
  const engineErrors = [];
  autoUpdater.on("error", (error) => {
    engineErrors.push(
      `${error.code === undefined ? "" : `${error.code}: `}${String(
        error.message ?? error
      )
        .split("\n")[0]
        .replaceAll(DIRECTORY, "<run>")
        .replace(/\/Users\/[^/]+/g, "~")
        .slice(0, 300)}`
    );
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (event) => {
      if (event.level === "error") pageErrors.push(event.message);
    });
  });

  let updater;
  const create = (context) => {
    updater = main.createUpdater({
      engine: autoUpdater,
      product: PRODUCT,
      api: api.createApiClient({
        baseUrl,
        retries: 0,
        timeoutMs: 5000,
        // Electron's network stack (the system proxy and certificates), like the engine's.
        ...(isNetFetch
          ? { fetch: (input, init) => net.fetch(input, init) }
          : {}),
      }),
      logger: context.logger,
      feedUrl,
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      // The Electron of node_modules is not signed. The scenarios that exercise the real
      // engine say so themselves; "degrade" leaves the detection to the updater.
      buildSupport: "supported",
      // Windows runs the downloaded installer when the program quits; see above.
      ...(IS_MAC ? {} : { installOnQuit: false }),
      ...options,
    });
    updater.onChange((state) => trace.push(state));
    return updater;
  };

  const info = { output: z.object({ version: z.string() }) };
  const infoHandler = () => ({ version: app.getVersion() });
  const contract = desktopShared.defineContract(
    wiring === "contract"
      ? {
          invoke: { "app:info": info, ...main.updateContract.invoke },
          events: { ...main.updateContract.events },
        }
      : { invoke: { "app:info": info }, events: {} }
  );

  const context = await desktop.startApp({
    contract,
    handlers: (appContext) => {
      const created = create(appContext);
      if (wiring === "contract") {
        created.onChange((state) => {
          appContext.emitter.broadcast("update:state-changed", state);
        });
        return {
          "app:info": infoHandler,
          ...main.createUpdateHandlers(created),
        };
      }
      main.registerUpdateIpc({ updater: created, policy: appContext.policy });
      return { "app:info": infoHandler };
    },
    rendererRoot: join(OUT, "renderer"),
    window: { preload: join(OUT, "preload.cjs"), width: 960, height: 640 },
    log: { level: "debug", mirrorToConsole: false },
    // Before the window: the stored policy is in the state when the page first asks.
    beforeWindow: async () => {
      await updater.start();
    },
  });

  const page = context.getWindow().webContents;
  if (page.isLoading()) {
    await new Promise((resolve) => page.once("did-finish-load", resolve));
  }
  const evaluate = (code) => page.executeJavaScript(code, true);
  const pageState = () => evaluate("window.__smoke.state()");
  // The page shows what main knows: same revision, same content.
  const inStep = async (label) => {
    const seen = await waitFor(
      `the page to reach main's state (${label})`,
      pageState,
      (state) =>
        state !== null && state.revision === updater.getState().revision
    );
    return isDeepStrictEqual(seen, updater.getState());
  };
  const readLog = async () => {
    await context.logger.flush();
    return readdirSync(context.logger.directory)
      .map((file) => readFileSync(join(context.logger.directory, file), "utf8"))
      .join("\n");
  };

  return {
    autoUpdater,
    context,
    engineErrors,
    evaluate,
    inStep,
    installs,
    opened,
    pageErrors,
    readLog,
    trace,
    updater,
    until: (label, isDone, milliseconds) =>
      waitFor(label, () => updater.getState(), isDone, milliseconds),
  };
};

const UPDATE_CHANNEL_NAMES = [
  "update:check",
  "update:download",
  "update:get-state",
  "update:install",
  "update:open-download-page",
];

// --- scenario 1: an optional update, from the first start to "restart" --------------------

const optional = async (dependencies) => {
  const servers = await startServers();
  servers.setPolicy({ latestVersion: NEXT });
  // Nothing is published yet: the folder on the download server is empty.

  const program = await boot(dependencies, {
    wiring: "contract",
    baseUrl: servers.baseUrl,
    feedUrl: servers.feedUrl,
    isNetFetch: true,
    options: { startDelayMs: 1500 },
  });
  const { updater, evaluate, until, inStep, trace } = program;

  // 1. The start.
  const first = trace[0] ?? updater.getState();
  check(
    "start: the updater is usable in a build that was told it can update",
    updater.getState().status !== "unsupported" &&
      updater.getState().currentVersion === CURRENT,
    brief(updater.getState())
  );
  await until("the policy", (state) => state.policy.latestVersion === NEXT);
  check(
    "policy: the backend's answer arrives through @handijit/core over Electron's net.fetch",
    updater.getState().policy.verdict === "recommended" &&
      updater.getState().policy.minSupportedVersion === null,
    updater.getState().policy
  );
  check(
    "policy: the request names this platform, architecture and channel",
    isDeepStrictEqual(
      servers.requests.find(({ kind }) => kind === "policy"),
      {
        kind: "policy",
        query: { os: OS, arch: process.arch, channel: "stable" },
      }
    ),
    servers.requests
  );
  const policyFile = join(app.getPath("userData"), "update-policy.json");
  await waitFor(
    "the policy file",
    () => existsSync(policyFile),
    (exists) => exists
  );
  const storedPolicy = JSON.parse(readFileSync(policyFile, "utf8")).policy;
  check(
    "policy: the answer is kept in update-policy.json for an offline start",
    storedPolicy.latestVersion === NEXT &&
      storedPolicy.minSupportedVersion === null &&
      Math.abs(Date.now() - storedPolicy.fetchedAt) < 60_000,
    storedPolicy
  );

  // 2. The page.
  check(
    "page: the renderer has no Node globals",
    isDeepStrictEqual(
      await evaluate(
        "[typeof require, typeof process, typeof module, typeof Buffer]"
      ),
      ["undefined", "undefined", "undefined", "undefined"]
    ),
    await evaluate(
      "[typeof require, typeof process, typeof module, typeof Buffer]"
    )
  );
  const bridge = await evaluate("window.__smoke.bridge()");
  check(
    "preload: withUpdateChannels adds exactly the updater's channels to the bridge",
    UPDATE_CHANNEL_NAMES.every((name) => bridge.invoke.includes(name)) &&
      bridge.invoke.includes("app:info") &&
      bridge.invoke.filter((name) => name.startsWith("update:")).length ===
        UPDATE_CHANNEL_NAMES.length &&
      isDeepStrictEqual(
        bridge.on.filter((name) => name.startsWith("update:")),
        ["update:state-changed"]
      ),
    bridge
  );
  check(
    "ipc: the page's client holds main's state (contract fragment wiring)",
    await inStep("start")
  );
  check(
    "page: the title bar button is quiet and the gate is absent while nothing is required",
    (await evaluate("window.__smoke.titleBar()")) === "Demo" &&
      (await evaluate("window.__smoke.gate()")) === null,
    await evaluate("window.__smoke.titleBar()")
  );

  // 3. The scheduled check, on its own, against a folder without a channel file.
  await until("the scheduled check", (state) => state.checkedAt !== null);
  check(
    "schedule: the first check runs by itself after the start delay",
    servers.feedReads() === 1 && first.checkedAt === null,
    servers.requests
  );
  check(
    "feed: a folder without a channel file reads as no update, not as an error",
    updater.getState().status === "not-available",
    brief(updater.getState())
  );
  await inStep("not-available");
  check(
    "page: the settings row says the program is up to date and offers a check",
    (await evaluate("window.__smoke.settings()")).includes("Program güncel") &&
      (await evaluate("window.__smoke.buttons()")).includes(
        "Güncellemeleri denetle"
      ),
    await evaluate("window.__smoke.settings()")
  );
  check(
    "react: useUpdate follows the state under StrictMode",
    (await evaluate("window.__smoke.hook()")) === "not-available/recommended",
    await evaluate("window.__smoke.hook()")
  );

  // A check asked for from the page: resolves when the feed has answered.
  const checkFromPage = async (label) => {
    const before = servers.feedReads();
    const checkedAt = updater.getState().checkedAt;
    await sleep(5);
    check(
      `page: "Güncellemeleri denetle" can be pressed (${label})`,
      await evaluate('window.__smoke.click("Güncellemeleri denetle")')
    );
    await until(
      `the check (${label})`,
      (state) =>
        state.status !== "checking" &&
        state.checkedAt !== checkedAt &&
        servers.feedReads() > before
    );
    await inStep(label);
  };

  // 4. Downgrade protection, by the real engine.
  publish(servers, { version: "1.3.0" });
  await checkFromPage("an older version");
  check(
    "feed: an older version than the running one is not offered",
    updater.getState().status === "not-available",
    brief(updater.getState())
  );
  check(
    "engine: downgrades stay off",
    program.autoUpdater.allowDowngrade === false &&
      program.autoUpdater.autoDownload === false,
    {
      allowDowngrade: program.autoUpdater.allowDowngrade,
      autoDownload: program.autoUpdater.autoDownload,
    }
  );

  // 5. Staged rollout, by the real engine.
  publish(servers, { version: NEXT, stagingPercentage: 0 });
  await checkFromPage("a staged release");
  check(
    "feed: a release staged for 0 % of the installations is not offered",
    updater.getState().status === "not-available",
    brief(updater.getState())
  );

  // 6. The release, for everyone; its installer does not match its checksum yet.
  let mine = publish(servers, {
    version: NEXT,
    releaseNotes: "E-fatura eklendi.",
    isCorrupt: true,
  });
  await checkFromPage("a release");
  const available = updater.getState();
  check(
    "feed: the release is offered with its version, notes and this architecture's size",
    available.status === "available" &&
      available.update.version === NEXT &&
      available.update.releaseNotes === "E-fatura eklendi." &&
      available.update.sizeBytes === mine.content.length,
    available
  );
  check(
    "download: nothing is downloaded until someone asks (autoDownload is off by default)",
    servers.payloadReads(mine.name) === 0,
    servers.requests
  );
  check(
    'page: the title bar shows "Güncelle" with the version',
    (await evaluate("window.__smoke.titleBar()")).includes(`Güncelle ${NEXT}`),
    await evaluate("window.__smoke.titleBar()")
  );

  // 7. A corrupt download: the real checksum verification.
  await evaluate(`window.__smoke.click("Güncelle ${NEXT}")`);
  await until("the corrupt download", (state) => state.status === "error");
  const failed = updater.getState();
  check(
    "download: a file that does not match the feed's sha512 ends in CHECKSUM, with the update kept",
    failed.error.code === "CHECKSUM" &&
      failed.update?.version === NEXT &&
      servers.payloadReads(mine.name) === 1 &&
      downloadedChecksums().length === 0,
    { failed, kept: downloadedChecksums().length }
  );
  await inStep("error");
  check(
    'page: the failure offers "Yeniden dene" and the settings row says why',
    (await evaluate("window.__smoke.buttons()")).includes("Yeniden dene") &&
      (await evaluate("window.__smoke.settings()")).includes(
        failed.error.message
      ),
    await evaluate("window.__smoke.settings()")
  );

  // 8. The retry, on a slow line, clicked three times at once.
  mine = publish(servers, {
    version: NEXT,
    releaseNotes: "E-fatura eklendi.",
    megabytes: 6,
  });
  servers.setChunkDelay(250);
  const mark = trace.length;
  const readsBefore = servers.payloadReads(mine.name);
  const burst = await evaluate('window.__smoke.burst("download", 3)');
  await until(
    "the download to start",
    (state) => state.status === "downloading"
  );
  const feedReadsWhileDownloading = servers.feedReads();
  const during = await evaluate('window.__smoke.burst("check", 2)');
  await sleep(600);
  const bars = await evaluate("window.__smoke.progress()");
  check(
    "page: the download shows a progress bar with a spoken value",
    bars.length === 2 &&
      bars.every(
        (bar) => bar.label === "Güncelleme indiriliyor" && bar.now !== null
      ),
    bars
  );
  await until(
    "the download",
    (state) => state.status !== "downloading",
    60_000
  );
  const downloadStates = trace.slice(mark);
  const progress = downloadStates
    .filter((state) => state.status === "downloading")
    .map((state) => state.progress);
  check(
    "download: retry reads the feed again and downloads once, however often it is asked",
    Array.isArray(burst) && servers.payloadReads(mine.name) - readsBefore === 1,
    { burst, reads: servers.payloadReads(mine.name) - readsBefore }
  );
  check(
    "download: a check during the download changes nothing and reads nothing",
    isDeepStrictEqual(during, ["downloading", "downloading"]) &&
      servers.feedReads() === feedReadsWhileDownloading,
    { during, reads: servers.feedReads() - feedReadsWhileDownloading }
  );
  check(
    "download: the engine's progress arrives with percent, bytes and speed",
    progress.some(
      ({ percent, transferredBytes, totalBytes, bytesPerSecond }) =>
        percent > 0 &&
        percent < 100 &&
        transferredBytes > 0 &&
        totalBytes === mine.content.length &&
        bytesPerSecond > 0
    ),
    progress
  );
  const order = downloadStates
    .map((state) => state.status)
    .filter((status, index, all) => status !== all[index - 1]);
  check(
    "download: the states run checking, available, downloading, downloaded",
    isDeepStrictEqual(order.slice(0, 4), [
      "checking",
      "available",
      "downloading",
      "downloaded",
    ]),
    order
  );
  check(
    "download: the file in the engine's cache is the published one, verified by sha512",
    isDeepStrictEqual(downloadedChecksums(), [sha512(mine.content)]),
    downloadedChecksums().length
  );
  note(
    `the engine took ${mine.name} for ${process.platform}-${process.arch} and asked for these files: ${[
      ...new Set(
        servers.requests
          .filter(({ kind, name }) => kind === "feed" && name !== CHANNEL_FILE)
          .map(({ name, found }) => `${name}${found ? "" : " (404)"}`)
      ),
    ].join(", ")}`
  );

  // 9. Downloaded. What happens next depends on the platform and on the signature.
  if (IS_MAC) {
    // Install-on-quit is on (the default), so the engine hands the file to Squirrel.Mac at
    // once. The Electron binary of node_modules is not signed with a Developer ID.
    const settled = await waitFor(
      "Squirrel.Mac to answer",
      () => updater.getState(),
      (state) => state.status !== "downloaded",
      20_000
    ).catch(() => updater.getState());
    note(
      `after "downloaded" with install-on-quit, Squirrel.Mac left the state at ${JSON.stringify(brief(settled))}`
    );
    note(`the engine reported: ${JSON.stringify(program.engineErrors)}`);
    check(
      "macOS: Squirrel.Mac refuses the unsigned build and the state says so instead of failing",
      settled.status === "unsupported" && settled.reason === "unsigned",
      brief(settled)
    );
    await inStep("unsigned");
    check(
      "page: an unsigned build shows that it cannot update itself",
      (await evaluate("window.__smoke.settings()")).includes(
        "Bu kurulum kendini güncelleyemiyor"
      ),
      await evaluate("window.__smoke.settings()")
    );
  } else {
    await inStep("downloaded");
    check(
      'page: the title bar offers "Yeniden başlat"',
      (await evaluate("window.__smoke.titleBar()")).includes("Yeniden başlat"),
      await evaluate("window.__smoke.titleBar()")
    );
    check(
      "install: nothing restarts until someone asks",
      program.installs.length === 0 &&
        updater.getState().isInstallPending === false,
      program.installs
    );
    await evaluate('window.__smoke.click("Yeniden başlat")');
    await until("the restart", (state) => state.isInstallPending);
    check(
      'install: "Yeniden başlat" asks the engine to quit and run the installer, visibly, and to reopen the program',
      isDeepStrictEqual(program.installs, [[false, true]]),
      program.installs
    );
  }

  // 10. The log.
  const log = await program.readLog();
  const rolloutId = readFileSync(
    join(app.getPath("userData"), ".updaterId"),
    "utf8"
  ).trim();
  check(
    "log: the updater writes its status changes under its own scope",
    log.includes("status changed") && log.includes("updater"),
    log.slice(0, 300)
  );
  check(
    "log: neither the home folder nor the installation's rollout id is written",
    rolloutId.length > 0 &&
      !log.includes(rolloutId) &&
      !log.includes(process.env.HOME ?? "\0") &&
      // The account's real folder: Squirrel.Mac names it whatever HOME says.
      !log.includes(userInfo().homedir) &&
      !log.includes(DIRECTORY),
    log
      .split("\n")
      .filter((line) => line.includes(rolloutId) || line.includes(DIRECTORY))
      .slice(0, 3)
  );
  check(
    "page: no error and no Content-Security-Policy violation was reported",
    program.pageErrors.length === 0,
    program.pageErrors
  );
};

// --- scenario 2: a required update, from the gate to the restart --------------------------

const required = async (dependencies) => {
  const servers = await startServers();
  servers.setPolicy({ latestVersion: NEXT, minSupportedVersion: "2.0.0" });
  // Staged for nobody: without the policy this release would not be offered at all.
  const mine = publish(servers, {
    version: NEXT,
    stagingPercentage: 0,
    megabytes: 2,
  });

  const program = await boot(dependencies, {
    wiring: "standalone",
    baseUrl: servers.baseUrl,
    feedUrl: servers.feedUrl,
    // The schedule never fires here: whatever happens, the policy caused it. And the file
    // is not handed to Squirrel.Mac before someone asks for the restart.
    options: { startDelayMs: NEVER_MS, installOnQuit: false },
  });
  const { updater, evaluate, until, inStep, trace } = program;

  await until("the required update", (state) => state.status === "available");
  const offered = updater.getState();
  check(
    "policy: a version below the minimum is required",
    offered.policy.verdict === "required" &&
      offered.policy.minSupportedVersion === "2.0.0",
    offered.policy
  );
  check(
    "feed: a required update is read at once and offered whatever the staged rollout says",
    offered.update.version === NEXT && servers.feedReads() === 1,
    { offered, reads: servers.feedReads() }
  );
  check(
    "ipc: the page's client holds main's state (registerUpdateIpc wiring)",
    await inStep("required")
  );

  const gate = await evaluate("window.__smoke.gate()");
  check(
    'gate: "Güncelleme gerekli" covers the program with both versions',
    gate !== null &&
      gate.title === "Güncelleme gerekli" &&
      gate.text.includes(CURRENT) &&
      gate.text.includes(NEXT),
    gate
  );
  check(
    "gate: the program behind it is inert and the focus is on the one action",
    gate !== null &&
      gate.isProgramInert &&
      gate.isFocusInside &&
      gate.focused.trim() === "Şimdi güncelle",
    gate
  );
  check(
    "gate: the only buttons a person can reach are the gate's",
    isDeepStrictEqual(await evaluate("window.__smoke.buttons()"), [
      "Şimdi güncelle",
    ]),
    await evaluate("window.__smoke.buttons()")
  );
  const storedPolicy = JSON.parse(
    readFileSync(join(app.getPath("userData"), "update-policy.json"), "utf8")
  ).policy;
  check(
    "policy: the required verdict is stored for the next start",
    storedPolicy.minSupportedVersion === "2.0.0",
    storedPolicy
  );

  // "Şimdi güncelle": download, then restart, without a second question.
  const mark = trace.length;
  await evaluate('window.__smoke.click("Şimdi güncelle")');
  await until(
    "the download",
    (state) => state.status !== "available" && state.status !== "downloading",
    60_000
  );
  const after = trace.slice(mark);
  check(
    "gate: one click downloads the update with the restart armed",
    after.some(
      (state) => state.status === "downloading" && state.isInstallPending
    ) &&
      servers.payloadReads(mine.name) === 1 &&
      isDeepStrictEqual(downloadedChecksums(), [sha512(mine.content)]),
    after.map(brief)
  );

  if (IS_MAC) {
    // The real quitAndInstall: the engine hands the file to Squirrel.Mac only now.
    const settled = await waitFor(
      "Squirrel.Mac to answer",
      () => updater.getState(),
      (state) => state.status !== "downloaded",
      20_000
    ).catch(() => updater.getState());
    note(
      `after quitAndInstall without install-on-quit, Squirrel.Mac left the state at ${JSON.stringify(brief(settled))}`
    );
    note(`the engine reported: ${JSON.stringify(program.engineErrors)}`);
    check(
      "macOS: the restart is asked of Squirrel.Mac, which refuses the unsigned build; the program keeps running",
      settled.status === "unsupported" &&
        settled.reason === "unsigned" &&
        settled.isInstallPending === false,
      brief(settled)
    );
    await inStep("unsigned");
    const blocked = await evaluate("window.__smoke.gate()");
    check(
      "gate: a build that cannot update itself is still gated, with the manual download as the way on",
      blocked !== null &&
        blocked.text.includes("Bu kurulum kendini güncelleyemiyor") &&
        blocked.focused.trim() === "Yeni sürümü indir",
      blocked
    );
  } else {
    await until("the restart", (state) => state.isInstallPending);
    check(
      "install: the restart starts by itself once the required update is downloaded",
      isDeepStrictEqual(program.installs, [[false, true]]) &&
        updater.getState().status === "downloaded",
      { installs: program.installs, state: brief(updater.getState()) }
    );
    await inStep("restarting");
    const restarting = await evaluate("window.__smoke.gate()");
    check(
      "gate: while the program quits there is nothing left to press",
      restarting !== null &&
        restarting.text.includes("Yeniden başlatılıyor") &&
        (await evaluate("window.__smoke.buttons()")).length === 0,
      restarting
    );
  }

  // The manual way out is the backend's download link for this platform.
  await evaluate("window.desktop.invoke['update:open-download-page']()");
  check(
    "gate: the manual download opens the backend's link for this platform and architecture",
    isDeepStrictEqual(program.opened, [
      `https://api.handijit.com/api/public/downloads/${PRODUCT}/${OS}?arch=${process.arch}`,
    ]),
    program.opened
  );
  check(
    "page: no error and no Content-Security-Policy violation was reported",
    program.pageErrors.length === 0,
    program.pageErrors
  );
};

// --- scenario 3: the next start, without a network -----------------------------------------

const offline = async (dependencies) => {
  // The user data folder is the one scenario 2 left behind: its policy file says "required".
  const origin = await closedOrigin();
  const program = await boot(dependencies, {
    wiring: "standalone",
    baseUrl: origin,
    feedUrl: `${origin}${FEED_PATH}`,
    options: { startDelayMs: NEVER_MS },
  });
  const { updater, evaluate, until, inStep, trace } = program;

  check(
    "offline: the stored verdict applies from the first state the page can see",
    trace.length > 0 &&
      updater.getState().policy.verdict === "required" &&
      updater.getState().policy.minSupportedVersion === "2.0.0",
    brief(updater.getState())
  );
  await until("the failed check", (state) => state.status === "error");
  const failed = updater.getState();
  check(
    "offline: the unreachable feed is reported as OFFLINE, because an update is required",
    failed.error.code === "OFFLINE" && failed.update === null,
    failed
  );
  check(
    "offline: the verdict survives the failed policy request",
    failed.policy.verdict === "required",
    failed.policy
  );
  await inStep("offline");
  const gate = await evaluate("window.__smoke.gate()");
  check(
    "gate: the failure is explained, with retry and the manual download",
    gate !== null &&
      gate.text.includes("Güncellenemedi") &&
      gate.text.includes(failed.error.message) &&
      isDeepStrictEqual(await evaluate("window.__smoke.buttons()"), [
        "Yeniden dene",
        "Yeni sürümü indir",
      ]),
    { gate, buttons: await evaluate("window.__smoke.buttons()") }
  );
  await evaluate('window.__smoke.click("Yeni sürümü indir")');
  await waitFor(
    "the download page",
    () => program.opened.length,
    (count) => count > 0
  );
  check(
    "gate: the manual download works without a network answer",
    program.opened.length === 1,
    program.opened
  );
  const log = await program.readLog();
  check(
    "log: the failures are written with their stable code",
    log.includes("the update check failed") && log.includes("OFFLINE"),
    log.slice(0, 300)
  );
  updater.dispose();

  // The same start with other policy files, without the page: how long "required" holds.
  const verdictWith = async (name, policy) => {
    const directory = join(DIRECTORY, name);
    mkdirSync(directory, { recursive: true });
    if (policy !== null) {
      writeFileSync(
        join(directory, "update-policy.json"),
        JSON.stringify({ policy })
      );
    }
    const other = dependencies.main.createUpdater({
      engine: program.autoUpdater,
      product: PRODUCT,
      api: dependencies.api.createApiClient({ baseUrl: origin, retries: 0 }),
      logger: program.context.logger,
      feedUrl: `${origin}${FEED_PATH}`,
      buildSupport: "supported",
      startDelayMs: NEVER_MS,
      policyStore: dependencies.main.createPolicyStore({ directory }),
    });
    const state = await other.start();
    await sleep(300);
    const verdicts = [state.policy.verdict, other.getState().policy.verdict];
    other.dispose();
    return verdicts;
  };
  const floor = { latestVersion: NEXT, minSupportedVersion: "2.0.0" };
  check(
    "offline: without a stored policy nobody is locked out",
    isDeepStrictEqual(await verdictWith("policy-none", null), ["ok", "ok"])
  );
  check(
    "offline: a required verdict older than seven days weakens to recommended",
    isDeepStrictEqual(
      await verdictWith("policy-old", {
        ...floor,
        fetchedAt: Date.now() - 8 * DAY_MS,
      }),
      ["recommended", "recommended"]
    )
  );
  check(
    "offline: a clock set back does not extend a required verdict",
    isDeepStrictEqual(
      await verdictWith("policy-future", {
        ...floor,
        fetchedAt: Date.now() + 8 * DAY_MS,
      }),
      ["recommended", "recommended"]
    )
  );
  check(
    "offline: a file that is not a policy is ignored",
    isDeepStrictEqual(
      await verdictWith("policy-broken", {
        latestVersion: "newest",
        minSupportedVersion: "2.0.0",
        fetchedAt: Date.now(),
      }),
      ["ok", "ok"]
    )
  );
  check(
    "page: no error and no Content-Security-Policy violation was reported",
    program.pageErrors.length === 0,
    program.pageErrors
  );
};

// --- scenario 4: builds that cannot update themselves ---------------------------------------

const degrade = async (dependencies) => {
  const servers = await startServers();
  servers.setPolicy({ latestVersion: NEXT, minSupportedVersion: "2.0.0" });
  publish(servers, { version: NEXT });

  // No `buildSupport` here: the updater finds out by itself what this build can do.
  const program = await boot(dependencies, {
    wiring: "contract",
    baseUrl: servers.baseUrl,
    feedUrl: servers.feedUrl,
    options: { startDelayMs: NEVER_MS, buildSupport: undefined },
  });
  const { updater, evaluate, until, inStep } = program;
  await until("the policy", (state) => state.policy.verdict === "required");

  if (IS_MAC) {
    const state = updater.getState();
    check(
      "macOS: a build without a Developer ID signature is detected at start (codesign)",
      state.status === "unsupported" && state.reason === "unsigned",
      brief(state)
    );
    const answers = [
      await evaluate('window.__smoke.burst("check", 2)'),
      await evaluate('window.__smoke.burst("download", 1)'),
      await evaluate('window.__smoke.burst("install", 1)'),
    ];
    check(
      "macOS: every action answers with the state and the feed is never read",
      isDeepStrictEqual(answers, [
        ["unsupported", "unsupported"],
        ["unsupported"],
        ["unsupported"],
      ]) && servers.feedReads() === 0,
      { answers, reads: servers.feedReads() }
    );
    await inStep("unsigned");
    const gate = await evaluate("window.__smoke.gate()");
    check(
      "gate: an unsigned build below the minimum is gated with the manual download",
      gate !== null &&
        gate.text.includes("Bu kurulum kendini güncelleyemiyor") &&
        isDeepStrictEqual(await evaluate("window.__smoke.buttons()"), [
          "Yeni sürümü indir",
        ]),
      gate
    );
  } else {
    await until("the required update", (state) => state.status === "available");
    check(
      "Windows: an unsigned build can update itself; the required update is offered",
      updater.getState().update.version === NEXT,
      brief(updater.getState())
    );
    await inStep("available");
    check(
      "gate: the required update is one click away",
      isDeepStrictEqual(await evaluate("window.__smoke.buttons()"), [
        "Şimdi güncelle",
      ]),
      await evaluate("window.__smoke.buttons()")
    );
  }
  updater.dispose();

  // A plain development run: the engine was not told to work unpackaged.
  program.autoUpdater.forceDevUpdateConfig = false;
  const feedReads = servers.feedReads();
  const policyReads = servers.policyReads();
  const development = dependencies.main.createUpdater({
    engine: program.autoUpdater,
    product: PRODUCT,
    api: dependencies.api.createApiClient({
      baseUrl: servers.baseUrl,
      retries: 0,
    }),
    logger: program.context.logger,
    feedUrl: servers.feedUrl,
    policyStore: dependencies.main.createPolicyStore({
      directory: join(DIRECTORY, "policy-development"),
    }),
  });
  const started = await development.start();
  const answers = [
    await development.check(),
    await development.download(),
    await development.install(),
  ];
  check(
    "development: an unpackaged run is unsupported with the reason, and nothing throws",
    started.status === "unsupported" &&
      started.reason === "development" &&
      answers.every((state) => state === started),
    answers.map(brief)
  );
  check(
    "development: neither the feed nor the policy is asked, and nothing is required",
    servers.feedReads() === feedReads &&
      servers.policyReads() === policyReads &&
      started.policy.verdict === "ok",
    { feed: servers.feedReads() - feedReads, policy: started.policy }
  );
  development.dispose();
  check(
    "development: the real engine answers null to a check in an unpackaged run",
    (await program.autoUpdater.checkForUpdates()) === null
  );
  check(
    "page: no error and no Content-Security-Policy violation was reported",
    program.pageErrors.length === 0,
    program.pageErrors
  );
};

const SCENARIOS = { optional, required, offline, degrade };

const run = (dependencies) => {
  app.setName("handijit-electron-update-smoke");
  // The fixture is version 1.4.0; the engine reads it when it is first asked for.
  app.setVersion(CURRENT);
  app.setPath("userData", join(DIRECTORY, "user-data"));
  mkdirSync(join(DIRECTORY, "logs"), { recursive: true });
  app.setAppLogsPath(join(DIRECTORY, "logs"));
  if (IS_MAC) app.commandLine.appendSwitch("use-mock-keychain");

  Promise.resolve()
    .then(() => SCENARIOS[SCENARIO](dependencies))
    .catch((error) => {
      check("the scenario ran to its end", false, error.stack ?? String(error));
    })
    .then(() => {
      writeFileSync(
        join(DIRECTORY, "result.json"),
        JSON.stringify({
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          platform: `${process.platform}-${process.arch}`,
          engine: dependencies.engineModule.autoUpdater.constructor.name,
          checks,
          notes,
        })
      );
      // A normal quit: with a downloaded file in the cache and the log flush of startApp.
      app.quit();
    });
};

module.exports = run;
