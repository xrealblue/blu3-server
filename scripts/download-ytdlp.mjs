import { existsSync, chmodSync, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, ".bin");
const PLATFORM = process.platform;
const ARCH = process.arch;

function binaryName() {
  if (PLATFORM === "win32") return "yt-dlp.exe";
  return "yt-dlp";
}

function downloadUrl() {
  const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
  const name = binaryName();
  if (PLATFORM === "win32") return `${base}/${name}`;
  if (PLATFORM === "darwin") return `${base}/${name}_macos`;
  return `${base}/${name}_linux`;
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

async function main() {
  const binDir = BIN_DIR;
  const binPath = join(binDir, binaryName());

  if (existsSync(binPath)) {
    console.log(`yt-dlp already exists at ${binPath}`);
    return;
  }

  await mkdir(binDir, { recursive: true });

  const url = downloadUrl();
  console.log(`Downloading yt-dlp from ${url}...`);
  await download(url, binPath);
  if (PLATFORM !== "win32") chmodSync(binPath, 0o755);
  console.log(`yt-dlp downloaded to ${binPath}`);
}

main().catch((err) => {
  console.error("Failed to download yt-dlp:", err.message);
  process.exit(1);
});
