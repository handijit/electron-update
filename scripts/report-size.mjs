import { existsSync, readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";

const ENTRIES = ["index", "main", "preload", "renderer", "react", "ui"];
const OUTPUTS = [
  ...ENTRIES.flatMap((entry) => [`build/${entry}.mjs`, `build/${entry}.cjs`]),
  "build/styles.css",
];

// The preload runs before every page load, and the renderer, react and ui entries ship inside
// the program's page bundle: the budgets guard those. main is loaded once, from disk, and is
// budgeted so that a dependency bundled by accident is noticed.
const GZIP_BUDGETS = {
  "build/index.mjs": 1200,
  "build/preload.cjs": 700,
  "build/renderer.mjs": 1500,
  "build/react.mjs": 500,
  "build/ui.mjs": 3200,
  "build/styles.css": 1600,
  "build/main.mjs": 8500,
};

const missing = OUTPUTS.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(
    `report-size: missing ${missing.join(", ")}; run "npm run build" first`
  );
  process.exit(1);
}

const formatBytes = (bytes) => `${(bytes / 1000).toFixed(2)} kB`;

const rows = OUTPUTS.map((file) => {
  const content = readFileSync(file);
  return {
    file,
    raw: content.length,
    gzip: gzipSync(content, { level: 9 }).length,
    brotli: brotliCompressSync(content).length,
  };
});

console.log("| File | Raw | Gzip | Brotli |");
console.log("| --- | --- | --- | --- |");
for (const { file, raw, gzip, brotli } of rows) {
  console.log(
    `| \`${file}\` | ${formatBytes(raw)} | ${formatBytes(gzip)} | ${formatBytes(brotli)} |`
  );
}

let failed = false;
console.log("");
for (const [file, budget] of Object.entries(GZIP_BUDGETS)) {
  const { gzip } = rows.find((row) => row.file === file);
  const verdict = gzip <= budget ? "within" : "OVER";
  console.log(`${file}: ${gzip} B gzip, ${verdict} the ${budget} B budget`);
  if (gzip > budget) failed = true;
}

if (failed) process.exit(1);
