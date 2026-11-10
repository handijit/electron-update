// Launches a real Electron with the fixture program in e2e/app, the built package and the
// real `autoUpdater` of electron-updater, once per scenario. Each launch publishes a feed
// (a channel file with real checksums over random "installers") and a version policy on a
// loopback server of its own and drives the page through main.
//
//   npm run build && npm run test:electron
//
// What this can prove and what it cannot is written in the README ("What the smoke test
// covers"): everything up to a verified download runs for real; replacing the program with
// the downloaded file needs a packaged (and, on macOS, signed) program.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import { build } from "vite";

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");
const APP = join(ROOT, "e2e/app");
const OUT = join(ROOT, "e2e/out");
const TIMEOUT_MS = 180_000;

if (!existsSync(join(ROOT, "build/main.mjs"))) {
  console.error('electron-smoke: build/ is missing; run "npm run build" first');
  process.exit(1);
}

// `require("electron")` in Node is the path of the binary. It throws when the binary was not
// downloaded, which is the case after `npm ci --ignore-scripts`.
let electronBinary;
try {
  electronBinary = require("electron");
} catch {
  console.error(
    'electron-smoke: the Electron binary is missing; run "node node_modules/electron/install.js" first'
  );
  process.exit(1);
}

// The fixture is bundled the way a program bundles it: the preload into one CommonJS file
// (a sandboxed preload cannot load a second file), the page by Vite. Both import the
// package by its published names, which point at build/.
rmSync(join(OUT, "preload.cjs"), { force: true });
rmSync(join(OUT, "renderer"), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const preloadBundle = await rollup({
  input: join(APP, "preload.mjs"),
  external: ["electron"],
  plugins: [nodeResolve()],
});
await preloadBundle.write({ file: join(OUT, "preload.cjs"), format: "cjs" });
await preloadBundle.close();

await build({
  root: APP,
  base: "./",
  configFile: false,
  logLevel: "error",
  resolve: {
    alias: [
      {
        find: /^@handijit\/electron-update\/styles\.css$/,
        replacement: join(ROOT, "build/styles.css"),
      },
      {
        find: /^@handijit\/electron-update\/(renderer|react|ui)$/,
        replacement: join(ROOT, "build/$1.mjs"),
      },
    ],
  },
  build: { outDir: join(OUT, "renderer"), emptyOutDir: true },
});

// What a program's bundles may import, measured on the fixture's own output.
const bundleProblems = [];
const preloadImports = [
  ...readFileSync(join(OUT, "preload.cjs"), "utf8").matchAll(
    /require\(['"]([^'"]+)['"]\)/g
  ),
].map(([, name]) => name);
if (preloadImports.some((name) => name !== "electron")) {
  bundleProblems.push(
    `the bundled preload requires ${preloadImports.join(", ")}`
  );
}

// Squirrel.Mac keeps its own folder per bundle id; the development Electron's is shared
// with every other Electron project on this machine, so only what this run adds is removed.
const SHIP_IT = join(homedir(), "Library/Caches/com.github.Electron.ShipIt");
const shipItBefore =
  process.platform === "darwin" && existsSync(SHIP_IT)
    ? new Set(readdirSync(SHIP_IT))
    : null;

const launch = async ({ name, entry, directory }) => {
  mkdirSync(join(directory, "home"), { recursive: true });
  mkdirSync(join(directory, "local-app-data"), { recursive: true });

  const environment = {
    ...process.env,
    SMOKE_DIR: directory,
    SMOKE_OUT: OUT,
    SMOKE_SCENARIO: name,
    ELECTRON_ENABLE_LOGGING: "1",
    // electron-updater keeps downloads under the user's cache folder: ~/Library/Caches on
    // macOS, %LOCALAPPDATA% on Windows. Both are pointed into the scenario's own folder.
    ...(process.platform === "darwin"
      ? { HOME: join(directory, "home") }
      : { LOCALAPPDATA: join(directory, "local-app-data") }),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;

  const child = spawn(electronBinary, [join(APP, entry)], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const exit = await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, timedOut: true });
    }, TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, timedOut: false });
    });
  });

  const resultFile = join(directory, "result.json");
  const result = existsSync(resultFile)
    ? JSON.parse(readFileSync(resultFile, "utf8"))
    : { checks: [], notes: [] };
  const checks = [...result.checks];
  checks.push({
    name: "the program wrote its result and quit normally",
    ok: existsSync(resultFile) && exit.code === 0,
    detail: exit.timedOut
      ? `killed after ${TIMEOUT_MS} ms`
      : `exit code ${exit.code}`,
  });
  rmSync(resultFile, { force: true });

  const failed = checks.filter(({ ok }) => !ok);
  for (const { name: label, ok, detail } of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} [${name}] ${label}`);
    if (!ok) console.log(`       ${JSON.stringify(detail)}`);
  }
  for (const text of result.notes) console.log(`note [${name}] ${text}`);
  if (failed.length > 0) console.log(`--- output of [${name}] ---\n${output}`);
  return { ...result, total: checks.length, failed: failed.length };
};

const temporary = () =>
  mkdtempSync(join(tmpdir(), "handijit-electron-update-smoke-"));
const directories = [temporary(), temporary(), temporary()];
const [optionalDirectory, requiredDirectory, degradeDirectory] = directories;

const runs = [];
try {
  // The two builds and the two ways of wiring the IPC alternate over the scenarios.
  runs.push(
    await launch({
      name: "optional",
      entry: "main.mjs",
      directory: optionalDirectory,
    })
  );
  runs.push(
    await launch({
      name: "required",
      entry: "main.cjs",
      directory: requiredDirectory,
    })
  );
  // The next start of the same installation: the user data of "required", without a network.
  runs.push(
    await launch({
      name: "offline",
      entry: "main.mjs",
      directory: requiredDirectory,
    })
  );
  runs.push(
    await launch({
      name: "degrade",
      entry: "main.cjs",
      directory: degradeDirectory,
    })
  );
} finally {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (shipItBefore !== null && existsSync(SHIP_IT)) {
    for (const entry of readdirSync(SHIP_IT)) {
      if (!shipItBefore.has(entry)) {
        rmSync(join(SHIP_IT, entry), { recursive: true, force: true });
      }
    }
  }
}

for (const problem of bundleProblems) console.log(`FAIL [bundle] ${problem}`);
const total = runs.reduce((sum, run) => sum + run.total, 0);
const failed =
  runs.reduce((sum, run) => sum + run.failed, 0) + bundleProblems.length;
const [{ electron, chrome, node, platform, engine }] = runs;

if (failed > 0) {
  console.error(`electron-smoke: ${failed} of ${total} checks FAILED`);
  process.exit(1);
}
console.log(
  `electron-smoke: ${total} checks passed in ${runs.length} launches on Electron ${electron} (Chromium ${chrome}, Node ${node}, ${platform}) with electron-updater's ${engine}`
);
