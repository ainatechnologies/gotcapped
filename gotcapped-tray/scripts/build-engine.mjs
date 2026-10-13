// Build the engine sidecar: bundle the shared CLI engine with esbuild, then wrap it in a Node single-executable (SEA)
// named the way Tauri's externalBin expects: src-tauri/binaries/gc-engine-<rust target triple>[.exe].
import { execSync } from "child_process";
import { copyFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
const sh = (c) => execSync(c, { stdio: "inherit" });
const triple = process.env.TARGET_TRIPLE || execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
const win = process.platform === "win32", mac = process.platform === "darwin";
sh("npx esbuild engine/engine.ts --bundle --platform=node --target=node20 --outfile=engine/dist/engine.cjs");
writeFileSync("engine/dist/sea.json", JSON.stringify({ main: "engine/dist/engine.cjs", output: "engine/dist/engine.blob", disableExperimentalSEAWarning: true }));
sh(`"${process.env.SEA_NODE || process.execPath}" --experimental-sea-config engine/dist/sea.json`);
mkdirSync("src-tauri/binaries", { recursive: true });
const out = `src-tauri/binaries/gc-engine-${triple}${win ? ".exe" : ""}`;
copyFileSync(process.env.SEA_NODE || process.execPath, out); if (!win) chmodSync(out, 0o755);
if (mac) sh(`codesign --remove-signature "${out}"`);
sh(`npx postject "${out}" NODE_SEA_BLOB engine/dist/engine.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2${mac ? " --macho-segment-name NODE_SEA" : ""}`);
if (mac) sh(`codesign --sign - "${out}"`); // ad-hoc for dev; the release build re-signs it with Developer ID (tauri bundler)
console.log("engine ->", out);
