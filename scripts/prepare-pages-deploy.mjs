import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "public");
const outputDir = path.join(root, ".deploy-public");
const excludedExact = new Set([
  "photos",
  "member-details.private.js"
]);

function isExcluded(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return excludedExact.has(normalized)
    || normalized.startsWith("photos/")
    || normalized.endsWith(".private.js");
}

async function copySafeDirectory(source, destination, relativeBase = "") {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeBase, entry.name);
    if (isExcluded(relativePath)) continue;

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySafeDirectory(sourcePath, destinationPath, relativePath);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
  }
}

await stat(sourceDir);
await rm(outputDir, { recursive: true, force: true });
await copySafeDirectory(sourceDir, outputDir);
console.log(`Prepared Cloudflare Pages deploy directory: ${outputDir}`);