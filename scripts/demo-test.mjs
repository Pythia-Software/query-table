// Runs demo browser checks against a private demo server and exits.
//
//   npm run test:demo -- menu dnd        run demo/menu-test.mjs, demo/dnd-test.mjs
//   npm run test:demo -- --list          list the available checks
//   npm run test:demo -- --all           run every check this runner can host
//
// A passing check prints one line; a failing one prints the end of its output.
// Full output is kept under .context/demo-test/.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCoreBuilt, root, startDemoServer } from "../demo/lib/demo-server.mjs";

// These need their own stack; the note says how to run them.
const EXTERNAL = {
  postgres: "needs a Postgres server: npm run demo:postgres, then npm run test:postgres-demo",
  showcase: "needs the static showcase build: npm run check:showcase",
};
// Checks whose page is not the demo root. QT_DEMO_URL replaces the whole URL
// in these scripts, so the runner has to pass the path as well.
const PATHS = { "cell-display": "/cells", "json-inspection-state": "/cells" };
const TAIL_LINES = 40;

const available = readdirSync(join(root, "demo"))
  .filter((file) => file.endsWith("-test.mjs"))
  .map((file) => file.slice(0, -"-test.mjs".length))
  .sort();
const hosted = available.filter((name) => !(name in EXTERNAL));

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const requested = args
  .filter((arg) => !arg.startsWith("--"))
  .map((arg) => arg.replace(/^demo\//, "").replace(/(-test)?(\.mjs)?$/, ""));

if (flags.has("--list") || (!requested.length && !flags.has("--all"))) {
  console.log(`Usage: npm run test:demo -- <check>... | --all | --list\n\nChecks:\n  ${hosted.join("\n  ")}`);
  for (const [name, note] of Object.entries(EXTERNAL)) console.log(`  ${name} (${note})`);
  process.exit(flags.has("--list") ? 0 : 2);
}
const names = flags.has("--all") ? hosted : requested;
for (const name of names) {
  if (name in EXTERNAL) {
    console.error(`${name} ${EXTERNAL[name]}.`);
    process.exit(2);
  }
  if (!available.includes(name)) {
    console.error(`No demo/${name}-test.mjs. Run with --list to see the checks.`);
    process.exit(2);
  }
}

const logDirectory = join(root, ".context", "demo-test");
mkdirSync(logDirectory, { recursive: true });

const run = (name, url) =>
  new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join("demo", `${name}-test.mjs`)], {
      cwd: root,
      env: { ...process.env, QT_DEMO_URL: url + (PATHS[name] ?? "") },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const log = join(logDirectory, `${name}.log`);
      writeFileSync(log, output);
      done({ name, code, output, log, seconds: ((Date.now() - started) / 1000).toFixed(1) });
    });
  });

ensureCoreBuilt({ force: flags.has("--build") });
const server = await startDemoServer();
let failures = 0;
try {
  for (const name of names) {
    const result = await run(name, server.url);
    if (result.code === 0) {
      console.log(`pass  ${name} (${result.seconds}s)`);
      continue;
    }
    failures++;
    const lines = result.output.trimEnd().split("\n");
    console.log(`FAIL  ${name} (${result.seconds}s), full output in ${result.log}`);
    if (lines.length > TAIL_LINES) console.log(`  ... ${lines.length - TAIL_LINES} earlier lines omitted`);
    console.log(lines.slice(-TAIL_LINES).map((line) => `  ${line}`).join("\n"));
  }
} finally {
  await server.stop();
}
console.log(failures ? `\n${failures} of ${names.length} demo checks failed` : `\n${names.length} demo checks passed`);
process.exit(failures ? 1 : 0);
