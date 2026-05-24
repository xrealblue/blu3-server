import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const distEntry = resolve(projectRoot, "dist", "index.js");

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

if (!existsSync(distEntry)) {
  console.warn("dist/index.js not found, running build before start...");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const buildStatus = run(npmCommand, ["run", "build"]);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }
}

const startStatus = run(process.execPath, [distEntry]);
process.exit(startStatus);
