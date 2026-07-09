import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public");
const target = path.join(root, "dist", "pages");
const distRoot = path.join(root, "dist");
const excluded = new Set([
  "photos",
  "seed-data.js",
  "member-details.private.js"
]);

if (!target.startsWith(distRoot + path.sep)) {
  throw new Error("Refusing to clean outside the dist directory");
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await copySafePublicFiles(source, target);

async function copySafePublicFiles(from, to, relative = "") {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relative, entry.name);
    const topLevelName = relativePath.split(path.sep)[0];
    if (excluded.has(topLevelName) || excluded.has(entry.name)) continue;

    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copySafePublicFiles(sourcePath, targetPath, relativePath);
    } else if (entry.isFile()) {
      await cp(sourcePath, targetPath);
    }
  }
}
