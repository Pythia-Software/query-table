// Saves a screenshot of a demo page from a private demo server.
//
//   npm run demo:screenshot -- /date-metrics-workbench
//   npm run demo:screenshot -- /menus --out .context/menus.png --width 390 --height 844
//   npm run demo:screenshot -- "/?q=..." --selector ".qt-table" --wait-for "text=Runs"
//
// Options: --out <file> (default .context/screenshots/<page>.png), --width,
// --height, --selector <css> (capture one element), --wait-for <selector>,
// --click <selector> (repeatable, applied in order before the capture),
// --theme <name> (sets data-theme on <main>), --full-page, --webkit.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { root, startDemoServer } from "../demo/lib/demo-server.mjs";

const args = process.argv.slice(2);
const options = { width: "1280", height: "900", click: [] };
const VALUE = new Set(["out", "width", "height", "selector", "wait-for", "click", "theme"]);
const FLAG = new Set(["full-page", "webkit"]);
let page = "/";
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  const key = arg.startsWith("--") ? arg.slice(2) : undefined;
  if (key === undefined) page = arg;
  else if (FLAG.has(key)) options[key] = true;
  else if (VALUE.has(key) && args[index + 1] !== undefined) {
    const value = args[++index];
    if (key === "click") options.click.push(value);
    else options[key] = value;
  } else {
    console.error(`Unknown or incomplete option ${arg}. See the header of scripts/demo-screenshot.mjs.`);
    process.exit(2);
  }
}

const slug = page.replace(/[?#].*$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
const out = resolve(root, options.out ?? join(".context", "screenshots", `${slug}.png`));
mkdirSync(dirname(out), { recursive: true });

const server = await startDemoServer();
let browser;
let failed = false;
try {
  browser = await (options.webkit ? webkit : chromium).launch({
    headless: true,
    ...(process.env.QT_BROWSER_CHANNEL ? { channel: process.env.QT_BROWSER_CHANNEL } : {}),
    ...(process.env.QT_BROWSER_PATH ? { executablePath: process.env.QT_BROWSER_PATH } : {}),
  });
  const tab = await browser.newPage({ viewport: { width: Number(options.width), height: Number(options.height) } });
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(new URL(page, server.url).href, { waitUntil: "networkidle" });
  if (options.theme) await tab.locator("main").first().evaluate((element, theme) => element.setAttribute("data-theme", theme), options.theme);
  for (const selector of options.click) await tab.locator(selector).first().click();
  if (options["wait-for"]) await tab.locator(options["wait-for"]).first().waitFor({ state: "visible" });
  if (options.selector) await tab.locator(options.selector).first().screenshot({ path: out });
  else await tab.screenshot({ path: out, fullPage: Boolean(options["full-page"]) });
  console.log(out);
  for (const error of errors) console.log(`page error: ${error}`);
} catch (error) {
  failed = true;
  console.error(`Screenshot failed: ${error.message}`);
} finally {
  await browser?.close();
  await server.stop();
}
process.exit(failed ? 1 : 0);
