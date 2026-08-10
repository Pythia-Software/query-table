import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageSpecs = [
  { name: "@pythia-software/query-table-core", path: "packages/core/package.json", public: true },
  { name: "@pythia-software/query-table-react", path: "packages/react/package.json", public: true },
  { name: "@pythia-software/query-table-ui", path: "packages/ui/package.json", public: true },
  { name: "@pythia-software/query-table-codegen", path: "tools/schema-codegen/package.json", public: true },
  { name: "@pythia-software/query-table-demo", path: "demo/package.json", public: false },
];

function readManifest(path) {
  return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
}

const rootManifest = readManifest("package.json");
const requestedVersion = process.argv[2]?.replace(/^v/, "") ?? rootManifest.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
  throw new Error(`invalid release version ${JSON.stringify(requestedVersion)}`);
}
if (rootManifest.version !== requestedVersion) {
  throw new Error(`root version ${rootManifest.version} does not match release version ${requestedVersion}`);
}

const manifests = new Map();
for (const spec of packageSpecs) {
  const manifest = readManifest(spec.path);
  if (manifest.name !== spec.name) {
    throw new Error(`${spec.path} has package name ${JSON.stringify(manifest.name)}; expected ${JSON.stringify(spec.name)}`);
  }
  if (manifest.version !== requestedVersion) {
    throw new Error(`${spec.name} version ${manifest.version} does not match ${requestedVersion}`);
  }
  if (spec.public && (manifest.private === true || manifest.publishConfig?.access !== "public")) {
    throw new Error(`${spec.name} is not configured as a public package`);
  }
  if (!spec.public && manifest.private !== true) {
    throw new Error(`${spec.name} must remain private`);
  }
  manifests.set(spec.name, manifest);
}

for (const [name, manifest] of manifests) {
  for (const dependencySection of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dependency, version] of Object.entries(manifest[dependencySection] ?? {})) {
      if (manifests.has(dependency) && version !== requestedVersion) {
        throw new Error(`${name} requires ${dependency} at ${version}; expected exact version ${requestedVersion}`);
      }
    }
  }
}

process.stdout.write(`Verified release version ${requestedVersion} across ${packageSpecs.length} workspaces.\n`);
