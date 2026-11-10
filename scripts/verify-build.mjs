import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

// Checks the built package against itself. The unit tests measure the sources; this measures
// what was written to build/: that each entry can be loaded in the process it is meant for
// (by what it imports), that both formats export the same names, and that every path promised
// by package.json exists.

const require = createRequire(import.meta.url);
const read = (file) => readFileSync(file, "utf8");

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

if (!existsSync("build/index.mjs")) {
  console.error('verify-build: build/ is missing; run "npm run build" first');
  process.exit(1);
}

// What each entry may import at run time, and what its declarations may refer to.
const isNode = (name) => name.startsWith("node:");
const oneOf =
  (...names) =>
  (name) =>
    names.includes(name);
const ENTRIES = {
  // Loaded by all three processes: pure.
  index: { runtime: () => false, types: oneOf("zod") },
  // Electron's main process.
  main: {
    runtime: (name) =>
      isNode(name) ||
      oneOf(
        "electron",
        "zod",
        "@handijit/electron",
        "@handijit/electron/main",
        "@handijit/core/errors",
        "@handijit/core/version"
      )(name),
    types: oneOf("zod", "@handijit/core", "@handijit/electron/main"),
  },
  // A sandboxed preload can require `electron` and nothing else; this one needs nothing.
  preload: { runtime: () => false, types: () => false },
  // A web page: the bridge client of @handijit/electron and nothing else.
  renderer: {
    runtime: oneOf("@handijit/electron/renderer"),
    types: () => false,
  },
  // The hook: React and this package's own client, by its published name.
  react: {
    runtime: oneOf("react", "@handijit/electron-update/renderer"),
    types: oneOf("@handijit/electron-update/renderer"),
  },
  // The components: React, @handijit/ui and this package's own hook.
  ui: {
    runtime: oneOf(
      "react",
      "react/jsx-runtime",
      "@handijit/ui",
      "@handijit/electron-update/react"
    ),
    types: oneOf("react", "@handijit/ui", "@handijit/electron-update/react"),
  },
};

const importsOf = (source) => [
  ...new Set(
    [
      ...source.matchAll(
        /^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gm
      ),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(([, name]) => name)
  ),
];
const esmExports = (source) =>
  [...source.matchAll(/^export\s*\{([^}]*)\}/gm)]
    .flatMap(([, list]) => list.split(","))
    .map((name) =>
      name
        .trim()
        .split(/\s+as\s+/)
        .pop()
    )
    .filter(Boolean)
    .sort();
const cjsExports = (source) =>
  [
    ...new Set(
      [...source.matchAll(/^exports\.(\w+)\s*=/gm)].map(([, name]) => name)
    ),
  ].sort();

let exportCount = 0;
for (const [entry, allowed] of Object.entries(ENTRIES)) {
  const esm = read(`build/${entry}.mjs`);
  const cjs = read(`build/${entry}.cjs`);

  // 1. Imports: the wrong one makes the entry unloadable in its process.
  for (const [file, source] of [
    [`build/${entry}.mjs`, esm],
    [`build/${entry}.cjs`, cjs],
  ]) {
    for (const name of importsOf(source)) {
      check(
        allowed.runtime(name),
        `${file}: imports "${name}", which its process cannot load`
      );
    }
  }
  for (const file of [`build/${entry}.d.ts`, `build/${entry}.d.mts`]) {
    for (const name of importsOf(read(file))) {
      check(allowed.types(name), `${file}: its types refer to "${name}"`);
    }
  }

  // 2. Both formats carry the same public names.
  const names = esmExports(esm);
  exportCount += names.length;
  check(names.length > 0, `build/${entry}.mjs: no exports found`);
  check(
    isDeepStrictEqual(names, cjsExports(cjs)),
    `build/${entry}.cjs: the export list differs from build/${entry}.mjs`
  );
  check(
    read(`build/${entry}.d.ts`) === read(`build/${entry}.d.mts`),
    `build/${entry}.d.mts: differs from build/${entry}.d.ts`
  );
}

// 3. The entries that need no Electron really load outside it, in both formats. (`react` and
// `ui` import this package by name, which resolves only once it is installed: the tarball
// smoke test loads those.)
for (const entry of ["index", "preload", "renderer"]) {
  const esm = await import(`../build/${entry}.mjs`);
  const cjs = require(`../build/${entry}.cjs`);
  check(
    isDeepStrictEqual(Object.keys(esm).sort(), Object.keys(cjs).sort()),
    `build/${entry}: the loaded export lists differ between the formats`
  );
}

// 4. Every path promised by package.json exists.
const { exports: entryPoints, typesVersions } = JSON.parse(
  read("package.json")
);
const targets = (entry) =>
  typeof entry === "string" ? [entry] : Object.values(entry).flatMap(targets);
for (const target of [
  ...Object.values(entryPoints).flatMap(targets),
  ...Object.values(typesVersions["*"]).flat(),
]) {
  check(
    existsSync(target),
    `package.json points at ${target}, which does not exist`
  );
}

// 5. The stylesheet of the components is shipped, and the bundles do not import it.
check(
  read("build/styles.css").includes(".hdu-gate"),
  "build/styles.css: the component styles are missing"
);

if (problems.length > 0) {
  console.error(`verify-build: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `verify-build: ${Object.keys(ENTRIES).length} entries, ${exportCount} exports, both formats agree and every entry imports only what its process can load`
);
