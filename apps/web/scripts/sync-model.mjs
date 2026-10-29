// Copies the source model from /3d into public/ so Vite serves it. /3d stays the source of truth.
import { copyFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../../3d/sag-bino.glb");
const dst = resolve(here, "../public/models/sag-bino.glb");
mkdirSync(dirname(dst), { recursive: true });
if (!existsSync(dst) || statSync(dst).mtimeMs < statSync(src).mtimeMs || statSync(dst).size !== statSync(src).size) {
  copyFileSync(src, dst);
  console.log("sync-model: copied 3d/sag-bino.glb -> public/models/");
}
