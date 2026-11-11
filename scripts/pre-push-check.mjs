// Pre-push gate. Picks the cheapest tier that covers what is being pushed:
//
//   docs   only Markdown and docs/ changed      -> npm run wire:check
//   fast   anything else                         -> npm run check:fast
//   full   backend, wire schema or dependencies  -> npm run check
//
// Pull-request CI (.github/workflows/check.yml) always runs the full gate, so
// the SQLite race suite still covers every change before it merges.
// QT_PUSH_CHECK=docs|fast|full overrides the choice. `--dry-run` prints the
// tier for the current branch against origin/main without running anything.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FULL = [/^backends\//, /^schema\//, /^tools\/wire-codegen\//, /^package-lock\.json$/, /(^|\/)go\.(mod|sum)$/];
const DOCS = [/\.md$/, /^docs\//, /^assets\//, /^LICENSE$/];
const ZERO = /^0+$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
};

// Git feeds one "<local ref> <local sha> <remote ref> <remote sha>" line per
// pushed ref. Returns undefined when the pushed range cannot be determined.
const dryRun = process.argv.includes("--dry-run");

function changedFiles() {
  let input = "";
  if (dryRun) {
    const head = tryGit("rev-parse", "HEAD");
    input = `HEAD ${head} refs/heads/unknown ${"0".repeat(40)}\n`;
  } else {
    try {
      input = readFileSync(0, "utf8");
    } catch {
      return undefined;
    }
  }
  const files = new Set();
  let refs = 0;
  for (const line of input.split("\n")) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // blank line or a deletion
    refs++;
    const base =
      remoteSha && !ZERO.test(remoteSha) && tryGit("cat-file", "-e", `${remoteSha}^{commit}`) !== undefined
        ? tryGit("merge-base", remoteSha, localSha)
        : (tryGit("merge-base", "origin/main", localSha) ?? tryGit("merge-base", "main", localSha));
    if (!base) return undefined;
    const diff = tryGit("diff", "--name-only", base, localSha);
    if (diff === undefined) return undefined;
    for (const file of diff.split("\n").filter(Boolean)) files.add(file);
  }
  return refs ? [...files] : [];
}

function chooseTier() {
  const override = process.env.QT_PUSH_CHECK;
  if (override) {
    if (!["docs", "fast", "full"].includes(override)) {
      console.error(`QT_PUSH_CHECK must be docs, fast or full; got "${override}".`);
      process.exit(2);
    }
    return [override, "QT_PUSH_CHECK"];
  }
  const files = changedFiles();
  if (!files) return ["full", "could not determine the pushed changes"];
  if (!files.length) return ["none", "no commits to verify"];
  const full = files.find((file) => FULL.some((pattern) => pattern.test(file)));
  if (full) return ["full", `${full} changed`];
  if (files.every((file) => DOCS.some((pattern) => pattern.test(file)))) return ["docs", "documentation only"];
  return ["fast", "no backend, wire schema or dependency changes"];
}

const [tier, reason] = chooseTier();
const script = { docs: "wire:check", fast: "check:fast", full: "check" }[tier];
if (!script) {
  console.log(`pre-push: nothing to check (${reason}).`);
  process.exit(0);
}
console.log(`pre-push: ${tier} tier, npm run ${script} (${reason}).`);
if (dryRun) process.exit(0);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "--silent", script], { stdio: "inherit" });
if (result.status !== 0) console.error(`pre-push: npm run ${script} failed; push rejected.`);
process.exit(result.status ?? 1);
