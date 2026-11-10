// Electron's main process for `npm run screenshots`: loads the built page once per scene and
// theme and writes what Chromium painted. Started by scripts/screenshots.mjs.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const { app, BrowserWindow } = require("electron");

const { SHOT_URL, SHOT_OUT, SHOT_USER_DATA } = process.env;

const GATES = [
  "checking",
  "waiting",
  "available",
  "downloading",
  "downloaded",
  "restarting",
  "error",
  "unsupported",
];
const SCENES = [
  { name: "buttons", width: 1180, height: 900 },
  ...GATES.map((gate) => ({ name: `gate-${gate}`, width: 960, height: 640 })),
  // The smallest window a program is allowed to have: the gate must still fit.
  { name: "gate-error", width: 420, height: 640, suffix: "-narrow" },
];
const THEMES = ["light", "dark"];

// The same pixels on every machine, and sharp enough to judge a hairline.
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.setPath("userData", SHOT_USER_DATA);

// Fonts in, and every animation that ends has ended (the gate's panel fades in).
const settle = (page) =>
  page.executeJavaScript(`
    document.fonts.ready
      .then(() => new Promise((done) => setTimeout(done, 100)))
      .then(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((one) => one.effect.getComputedTiming().endTime !== Infinity)
            .map((one) => one.finished)
        )
      )
      .then(() => new Promise((done) => setTimeout(done, 100)))
  `);

const run = async () => {
  // One window for every scene: the address carries the scene, so each load starts clean.
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    // A window that is not shown must still run its animations to their end.
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  const written = [];
  for (const theme of THEMES) {
    for (const { name, width, height, suffix = "" } of SCENES) {
      window.setContentSize(width, height);
      await window.loadURL(`${SHOT_URL}/index.html?${name}/${theme}`);
      await settle(window.webContents);
      const image = await window.webContents.capturePage();
      const file = join(SHOT_OUT, `${name}${suffix}-${theme}.png`);
      writeFileSync(file, image.toPNG());
      written.push(file);
    }
  }
  writeFileSync(join(SHOT_OUT, "written.json"), JSON.stringify(written));
};

app
  .whenReady()
  .then(run)
  .then(
    () => app.exit(0),
    (cause) => {
      console.error(cause);
      app.exit(1);
    }
  );
