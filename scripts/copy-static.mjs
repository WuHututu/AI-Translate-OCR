import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "renderer");
const dest = join(root, "dist", "renderer");

await mkdir(dest, { recursive: true });
await copyFile(join(src, "index.html"), join(dest, "index.html"));
await copyFile(join(src, "styles.css"), join(dest, "styles.css"));
