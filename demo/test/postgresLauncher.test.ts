import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => mocks);
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), access: vi.fn() }));

let signals: Map<string, () => void>;
let childHandlers: Array<Map<string, (...args: unknown[]) => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.spawnSync.mockReset();
  signals = new Map();
  childHandlers = [];
  const originalOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (
      typeof event === "string" &&
      ["SIGINT", "SIGTERM", "SIGHUP"].includes(event)
    ) {
      signals.set(event, listener as () => void);
      return process;
    }
    return originalOn(event, listener);
  });
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("QT_DEMO_DATABASE_URL", "postgresql:///fixture");
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  mocks.spawn.mockImplementation(() => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    childHandlers.push(handlers);
    return {
      pid: 10000 + childHandlers.length,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        handlers.set(event, listener);
      },
    };
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function launch() {
  // The executable is intentionally plain JavaScript; this test exercises its
  // actual startup and cleanup with process/network/DB boundaries mocked.
  // @ts-expect-error The standalone launcher has no declaration file.
  await import("../start-postgres-demo.mjs");
}

it("handles terminal hangup by stopping both child process groups and owned PostgreSQL", async () => {
  vi.stubEnv("QT_DEMO_DATABASE_URL", "");
  vi.stubEnv("PG_BIN", "/fixture/postgres");
  // pg_ctl start/stop succeed; only its status probe indicates a stopped server.
  mocks.spawnSync.mockImplementation((command: string, args: string[]) => ({
    status:
      command.endsWith("pg_isready") ||
      (command.endsWith("pg_ctl") && args.includes("status"))
        ? 1
        : 0,
    stdout: command.endsWith("psql") ? "1" : "",
    stderr: "",
  }));
  let backendChecks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: url.includes("5180") && ++backendChecks >= 3,
    })),
  );
  await launch();
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  expect(signals.has("SIGHUP")).toBe(true);
  signals.get("SIGHUP")!();
  expect(process.kill).toHaveBeenCalledWith(-10001, "SIGTERM");
  expect(process.kill).toHaveBeenCalledWith(-10002, "SIGTERM");
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.spawnSync).toHaveBeenCalledWith(
    "/fixture/postgres/pg_ctl",
    expect.arrayContaining(["fast", "stop"]),
  );
  expect(process.exit).toHaveBeenCalledWith(0);
});

it("never starts Vite or prints readiness when the backend exits during startup", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false })),
  );
  const spawn = mocks.spawn.getMockImplementation()!;
  mocks.spawn.mockImplementation((...args) => {
    const result = spawn(...args);
    queueMicrotask(() => childHandlers[0]!.get("exit")!(1));
    return result;
  });
  await launch();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining("Open http://localhost:5179/postgres"),
  );
  await vi.advanceTimersByTimeAsync(1500);
  expect(process.exit).toHaveBeenCalledWith(1);
});
