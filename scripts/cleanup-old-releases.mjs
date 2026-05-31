import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import packageJson from "../package.json" with { type: "json" };

const releaseDir = path.join(process.cwd(), "release");
const currentVersion = packageJson.version;
const releaseArtifactPattern = /^Webtoon ?Previewer-.*-(?:x64|arm64|universal)\.dmg(?:\.blockmap)?$/;
const currentArtifactPattern = new RegExp(`^Webtoon ?Previewer-${escapeRegex(currentVersion)}-(?:x64|arm64|universal)\\.dmg(?:\\.blockmap)?$`);

let removed = 0;
let entries = [];
try {
  entries = await readdir(releaseDir);
} catch (error) {
  if (error?.code === "ENOENT") {
    process.exit(0);
  }
  throw error;
}

for (const entry of entries) {
  if (!releaseArtifactPattern.test(entry) || currentArtifactPattern.test(entry)) {
    continue;
  }

  await rm(path.join(releaseDir, entry), { force: true });
  removed += 1;
  console.log(`removed old release artifact: ${entry}`);
}

if (removed === 0) {
  console.log(`no old release artifacts to remove; keeping version ${currentVersion}`);
} else {
  console.log(`removed ${removed} old release artifact(s); keeping version ${currentVersion}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
