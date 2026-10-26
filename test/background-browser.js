// Launch Brave Browser Nightly (or any Chromium app) WITHOUT bringing it to the
// foreground, and drive it with Playwright over CDP.
//
// Why not chromium.launch / launchPersistentContext: Playwright spawns the binary
// directly, and macOS activates the app on startup and on every context.newPage().
// That steals focus from whatever the user is doing.
//
// What this does instead:
//   1. `open -g -n -a <App> --args --no-startup-window ...`
//      (-g alone is not enough: the first window activates the app, so start with none)
//   2. read the port from <userDataDir>/DevToolsActivePort, chromium.connectOverCDP
//   3. open pages with Target.createTarget({ newWindow: true, background: true })
//   4. size windows with Browser.setWindowBounds (no viewport emulation)
//   5. quit with Browser.close (connectOverCDP's browser.close() only disconnects)
//
// Usage (pass in your own `chromium` so Playwright resolves from your project):
//   const { chromium } = require("playwright");
//   const { launchBackground } = require(
//     require("os").homedir() + "/.claude/skills/browser-testing/background-browser.js");
//   const b = await launchBackground(chromium, { extension: "/abs/ext/dir" });
//   const page = await b.openPage("https://example.com/", { width: 900, height: 700 });
//   ... await b.close();

const { spawnSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BRAVE_NIGHTLY_APP = "/Applications/Brave Browser Nightly.app";

// Flags Playwright's own launcher would have added. Background windows count as
// occluded on macOS; without these, rendering / timers / rAF get throttled.
const BACKGROUND_FLAGS = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

async function waitForDevToolsPort(userDataDir, timeoutMs) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0] : "";
    if (port) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`DevTools port did not open (${file})`);
}

/**
 * @param chromium   Playwright's `chromium` (from your project's node_modules)
 * @param opts.app         .app bundle to launch (default: Brave Browser Nightly)
 * @param opts.extension   unpacked extension dir (string or array) to load
 * @param opts.userDataDir profile dir (default: fresh temp dir)
 * @param opts.args        extra Chromium flags
 */
async function launchBackground(chromium, opts = {}) {
  const app = opts.app || BRAVE_NIGHTLY_APP;
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "bg-browser-"));
  const extensions = [].concat(opts.extension || []);
  const extArgs = extensions.length
    ? [`--disable-extensions-except=${extensions.join(",")}`, `--load-extension=${extensions.join(",")}`]
    : [];

  const res = spawnSync("open", [
    "-g", // do not bring the app to the foreground
    "-n", // always a new instance, even if the user has this browser open
    "-a",
    app,
    "--args",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    ...BACKGROUND_FLAGS,
    ...extArgs,
    ...(opts.args || []),
  ]);
  if (res.status !== 0) throw new Error(`open failed: ${res.stderr}`);

  const port = await waitForDevToolsPort(userDataDir, 20000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const cdp = await browser.newBrowserCDPSession();

  // Open `url` in a new background window. Each page gets its own window so it is
  // the active (visible, rendering) tab of that window. Never use context.newPage():
  // it activates the app.
  async function openPage(url = "about:blank", size) {
    const pagePromise = context.waitForEvent("page", { timeout: 20000 });
    const { targetId } = await cdp.send("Target.createTarget", {
      url,
      newWindow: true,
      background: true,
    });
    const page = await pagePromise;
    await page.waitForLoadState("load");
    if (size) await resizeViewport(targetId, page, size.width, size.height);
    return page;
  }

  // Make the page's innerWidth/innerHeight exactly width×height by resizing the
  // real window (frame size differs per browser/OS, so measure and correct).
  async function resizeViewport(targetId, page, width, height) {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget", { targetId });
    const [iw, ih] = await page.evaluate(() => [innerWidth, innerHeight]);
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: bounds.width + width - iw, height: bounds.height + height - ih },
    });
    await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height], {
      timeout: 10000,
    });
  }

  async function serviceWorker() {
    return (
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 20000 }))
    );
  }

  async function close() {
    await cdp.send("Browser.close").catch(() => {});
  }

  return { browser, context, cdp, userDataDir, openPage, serviceWorker, close };
}

// Name of the frontmost app — poll it in parallel with a test to prove nothing
// stole focus. Async on purpose: osascript takes ~150ms, and a spawnSync poll on
// a setInterval starves the event loop until the Playwright run hangs.
function frontmostApp() {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
      (_err, stdout) => resolve(String(stdout).trim()),
    );
  });
}

module.exports = { launchBackground, frontmostApp, BRAVE_NIGHTLY_APP };
