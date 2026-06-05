#!/usr/bin/env bun
/**
 * Post-build script for Dioxus integration:
 *
 * 1. Generates metadata.json in dist/ describing the build output
 * 2. Creates a symlink: ../assets/react → ./dist
 *    (falls back to directory copy on Windows)
 *
 * This lets Dioxus use `asset!("/assets/react")` to reference
 * the entire folder, and `include_str!("../assets/react/metadata.json")`
 * to discover the hashed chunk filenames at compile time.
 */
import { existsSync, lstatSync, symlinkSync, unlinkSync, mkdirSync } from "fs";
import { readdir, readFile, writeFile, cp } from "fs/promises";
import path from "path";

const DIST_DIR = path.resolve("dist");
const ASSETS_LINK = path.resolve("../assets/react");

if (!existsSync(DIST_DIR)) {
  console.error("❌ dist/ not found. Run `bun run build` first.");
  process.exit(1);
}

// ── Step 1: Generate metadata.json ──────────────────────────────────────────

const html = await readFile(path.join(DIST_DIR, "index.html"), "utf-8");

// Extract all CSS hrefs
const styles = [...html.matchAll(/href="\.\/([^"]+\.css)"/g)].map((m) => m[1]!);
// Extract all JS srcs
const scripts = [...html.matchAll(/src="\.\/([^"]+\.js)"/g)].map((m) => m[1]!);

// Collect other assets (images, fonts, etc.)
const distFiles = await readdir(DIST_DIR);
const imageExts = [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"];
const fontExts = [".woff", ".woff2", ".ttf", ".otf", ".eot"];
const assets = distFiles.filter((f) => {
  const ext = path.extname(f).toLowerCase();
  return imageExts.includes(ext) || fontExts.includes(ext);
});

const metadata = { scripts, styles, assets };

await writeFile(
  path.join(DIST_DIR, "metadata.json"),
  JSON.stringify(metadata, null, 2) + "\n"
);

console.log("📄 Generated metadata.json:");
console.log(`   scripts: [${scripts.join(", ")}]`);
console.log(`   styles:  [${styles.join(", ")}]`);
console.log(`   assets:  [${assets.join(", ")}]`);

// ── Step 2: Symlink assets/react → react-app/dist ───────────────────────────

const isWindows = process.platform === "win32";

// Ensure parent directory exists
mkdirSync(path.dirname(ASSETS_LINK), { recursive: true });

// Remove whatever exists at the link path (directory, symlink, or file)
if (existsSync(ASSETS_LINK)) {
  try {
    const stat = lstatSync(ASSETS_LINK);
    if (stat.isSymbolicLink()) {
      unlinkSync(ASSETS_LINK);
    } else {
      const { rm } = await import("fs/promises");
      await rm(ASSETS_LINK, { recursive: true, force: true });
    }
  } catch {
    // Ignore if already gone
  }
}

if (isWindows) {
  // Windows: copy instead of symlink (symlinks need elevated privileges)
  await cp(DIST_DIR, ASSETS_LINK, { recursive: true });
  console.log(`\n📋 Copied dist/ → ../assets/react/ (Windows fallback)`);
} else {
  // Linux/macOS: create relative symlink
  const relTarget = path.relative(path.dirname(ASSETS_LINK), DIST_DIR);
  symlinkSync(relTarget, ASSETS_LINK);
  console.log(`\n🔗 Symlinked ../assets/react → ${relTarget}`);
}

console.log("✅ Dioxus integration ready\n");
