import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const distCandidates = [
  resolve(projectRoot, "dist", "index.js"),
  resolve(projectRoot, "dist", "src", "index.js"),
];

function getDistEntry() {
  return distCandidates.find((filePath) => existsSync(filePath)) ?? null;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

let distEntry = getDistEntry();

if (!distEntry) {
  console.warn("dist/index.js not found, running build before start...");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const buildStatus = run(npmCommand, ["run", "build"]);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }
  distEntry = getDistEntry();
}

if (!distEntry) {
  console.error("Build completed but no compiled server entry was found.");
  process.exit(1);
}

const startStatus = run(process.execPath, [distEntry]);
process.exit(startStatus);
