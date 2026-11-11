// Starts a private Vite dev server for the demo on a free port, so browser
// checks never collide with `npm run demo` or with another worktree.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const demo = join(root, "demo");

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

// Several browser scripts decode share links with the built core package.
export function ensureCoreBuilt({ force = false } = {}) {
  if (!force && existsSync(join(root, "packages/core/dist/index.js"))) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const built = spawnSync(npm, ["run", "--silent", "build", "--workspace", "@pythia-software/query-table-core"], {
    cwd: root,
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`Building the core package failed:\n${built.stdout}${built.stderr}`);
}

// Resolves to { url, stop } once the server answers. QT_DEMO_URL, when set,
// is used as-is and nothing is started.
export async function startDemoServer() {
  if (process.env.QT_DEMO_URL) return { url: new URL(process.env.QT_DEMO_URL).origin, stop: async () => {} };
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: demo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  let exited = false;
  child.on("exit", () => (exited = true));
  // An interrupted or timed-out check must not leave the server behind.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      if (!exited) child.kill("SIGKILL");
      process.exit(1);
    });
  }
  const stop = () =>
    new Promise((done) => {
      if (exited) return done();
      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => exited || child.kill("SIGKILL"), 3000).unref();
    });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The demo server exited before it was ready:\n${log}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return { url, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((wait) => setTimeout(wait, 150));
  }
  await stop();
  throw new Error(`The demo server did not answer within 60 seconds:\n${log}`);
}
