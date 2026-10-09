import { spawn, spawnSync } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, ".context", "postgres-demo");
await mkdir(state, { recursive: true });
const children = [];
let ownedPostgres = false;
let pgBin;
let stopping = false;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr ?? result.error}`);
  return result.stdout?.trim() ?? "";
};
const alive = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};
const child = (command, args, options = {}) => {
  if (stopping) return;
  const spawned = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    detached: process.platform !== "win32",
    ...options,
  });
  children.push(spawned);
  spawned.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  spawned.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return spawned;
};
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const signalChild = (child, signal) => {
    if (!Number.isInteger(child.pid)) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  };
  for (const child of children) signalChild(child, "SIGTERM");
  setTimeout(() => {
    for (const child of children) signalChild(child, "SIGKILL");
    if (ownedPostgres)
      spawnSync(path.join(pgBin, "pg_ctl"), [
        "-D",
        path.join(state, "pgdata"),
        "-m",
        "fast",
        "-w",
        "stop",
      ]);
    process.exit(code);
  }, 1500);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
process.on("SIGHUP", () => stop());

try {
  if (await alive("http://127.0.0.1:5180/api/postgres/bootstrap"))
    throw new Error(
      "A demo backend is already running on port 5180. Stop its launcher before restarting with a different dataset size.",
    );
  let dsn = process.env.QT_DEMO_DATABASE_URL;
  if (!dsn) {
    const candidates = [
      process.env.PG_BIN,
      "/opt/homebrew/opt/postgresql@16/bin",
      "/opt/homebrew/opt/postgresql@17/bin",
      "/usr/lib/postgresql/16/bin",
      "/usr/lib/postgresql/17/bin",
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        await access(path.join(candidate, "pg_ctl"), constants.X_OK);
        pgBin = candidate;
        break;
      } catch {}
    }
    if (!pgBin) {
      const executable = run("which", ["pg_ctl"]);
      pgBin = path.dirname(executable);
    }
    let port = 5432;
    let admin = "postgresql:///postgres?host=/tmp&port=5432";
    const ready = spawnSync(
      path.join(pgBin, "pg_isready"),
      ["-h", "/tmp", "-p", "5432"],
      { stdio: "ignore" },
    );
    if (ready.status !== 0) {
      port = 55439;
      const data = path.join(state, "pgdata");
      try {
        await access(path.join(data, "PG_VERSION"));
      } catch {
        run(
          path.join(pgBin, "initdb"),
          ["-D", data, "-A", "trust", "-U", os.userInfo().username],
          { stdio: "inherit" },
        );
      }
      const status = spawnSync(
        path.join(pgBin, "pg_ctl"),
        ["-D", data, "status"],
        { stdio: "ignore" },
      );
      if (status.status !== 0)
        run(
          path.join(pgBin, "pg_ctl"),
          [
            "-D",
            data,
            "-l",
            path.join(state, "postgres.log"),
            "-o",
            `-h 127.0.0.1 -p ${port} -k /tmp`,
            "-w",
            "start",
          ],
          { stdio: "inherit" },
        );
      else console.log("Reusing the retained private PostgreSQL cluster.");
      ownedPostgres = true;
      admin = `postgresql:///postgres?host=/tmp&port=${port}`;
    }
    const database = "query_table_metrics_demo";
    if (
      run(path.join(pgBin, "psql"), [
        admin,
        "-Atc",
        `SELECT 1 FROM pg_database WHERE datname='${database}'`,
      ]) !== "1"
    ) {
      run(path.join(pgBin, "createdb"), [
        "-h",
        "/tmp",
        "-p",
        String(port),
        database,
      ]);
    }
    dsn = `postgresql:///${database}?host=/tmp&port=${port}`;
    console.log(
      `PostgreSQL demo database: ${database} on /tmp:${port} (other databases untouched).`,
    );
  }
  if (await alive("http://127.0.0.1:5180/api/postgres/bootstrap")) {
    throw new Error(
      "A demo backend is already running on port 5180. Stop its launcher before restarting with a different dataset size.",
    );
  }
  console.log(
    "Building the Go demo host (production query-table planners + demo-only PostgreSQL driver)…",
  );
  const binary = path.join(state, "server");
  run("go", ["build", "-o", binary, "."], {
    cwd: path.join(root, "demo", "server"),
    stdio: "inherit",
  });
  const rows = process.env.QT_DEMO_ROWS ?? "500000";
  if (!/^\d+$/.test(rows) || +rows < 1000 || +rows > 2000000)
    throw new Error("QT_DEMO_ROWS must be 1000..2000000");
  child(binary, ["-rows", rows], {
    env: { ...process.env, QT_DEMO_DATABASE_URL: dsn },
  });
  const deadline = Date.now() + 180000;
  while (!(await alive("http://127.0.0.1:5180/api/postgres/bootstrap"))) {
    if (stopping) break;
    if (Date.now() > deadline)
      throw new Error(
        "Go demo backend did not become ready; inspect the output above.",
      );
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const viteReady = !stopping && (await alive("http://localhost:5179/"));
  if (!stopping && !viteReady) {
    child(
      process.execPath,
      [
        path.join(root, "node_modules", "vite", "bin", "vite.js"),
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
      { cwd: path.join(root, "demo") },
    );
  } else if (!stopping)
    console.log("Reusing the existing Vite server on port 5179.");
  if (!stopping)
    console.log(
      `\nOpen http://localhost:5179/postgres\n${Number(rows).toLocaleString()} real PostgreSQL rows · Go HTTP adapter · seeded metrics · latency controls\nCtrl+C stops this demo's processes; seeded data is retained.\n`,
    );
} catch (error) {
  console.error(error.message);
  stop(1);
}
