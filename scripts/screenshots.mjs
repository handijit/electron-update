// Draws every state of the update button and of the required-update gate in real Chromium,
// in both themes, and writes one PNG per scene. Not a test: the pictures are for a person
// to look at before a release.
//
//   npm run build && npm run screenshots [-- <directory>]
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "scripts", "screenshots");
const site = join(root, "e2e", "out", "screenshots-site");
const out = resolve(process.argv[2] ?? join(root, "e2e", "out", "screenshots"));
const electron = createRequire(import.meta.url)("electron");

if (!existsSync(join(root, "build", "ui.mjs"))) {
  console.error("screenshots: build/ is missing. Run `npm run build` first.");
  process.exit(1);
}

// The page imports the package by its published names; they point at the build.
await build({
  root: fixture,
  base: "./",
  configFile: false,
  logLevel: "error",
  resolve: {
    alias: [
      {
        find: /^@handijit\/electron-update\/styles\.css$/,
        replacement: join(root, "build", "styles.css"),
      },
      {
        find: /^@handijit\/electron-update\/(renderer|react|ui)$/,
        replacement: join(root, "build", "$1.mjs"),
      },
      {
        find: /^@handijit\/electron-update$/,
        replacement: join(root, "build", "index.mjs"),
      },
    ],
  },
  build: { outDir: site, emptyOutDir: true },
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};

// Module scripts do not load from file://, so the page is served from this machine.
const server = createServer((request, response) => {
  const path = normalize(
    decodeURIComponent(new URL(request.url, "http://x").pathname)
  );
  const file = join(site, path);
  if (!file.startsWith(site) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  response.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

mkdirSync(out, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), "electron-update-shots-"));
const environment = {
  ...process.env,
  SHOT_URL: `http://127.0.0.1:${server.address().port}`,
  SHOT_OUT: out,
  SHOT_USER_DATA: userData,
};
delete environment.ELECTRON_RUN_AS_NODE;

const code = await new Promise((done) => {
  spawn(electron, [join(fixture, "main.cjs")], {
    env: environment,
    stdio: "inherit",
  }).on("exit", done);
});
server.close();
rmSync(userData, { recursive: true, force: true });

if (code !== 0) {
  console.error(`screenshots: Electron exited with ${code}`);
  process.exit(1);
}
const written = JSON.parse(readFileSync(join(out, "written.json"), "utf8"));
rmSync(join(out, "written.json"));
console.log(`screenshots: ${written.length} pictures in ${out}`);
