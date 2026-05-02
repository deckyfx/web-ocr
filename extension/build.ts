import { $ } from "bun";

console.log("📦 Building Selfhost OCR extension\n");

console.log("  Cleaning dist...");
await $`rm -rf ./dist && mkdir -p ./dist`;

const entries = [
  { name: "background", file: "./src/background.ts" },
  { name: "content",    file: "./src/content.ts" },
  { name: "options",    file: "./src/options.ts" },
];

let ok = true;

for (const { name, file } of entries) {
  process.stdout.write(`  Building ${name}.ts...`);

  const result = await Bun.build({
    entrypoints: [file],
    outdir: "./dist",
    target: "browser",
    format: "iife",
    minify: true,
  });

  if (!result.success) {
    console.log(" ❌");
    for (const log of result.logs) console.error(`    ${log.message}`);
    ok = false;
  } else {
    console.log(" ✅");
  }
}

if (!ok) {
  console.error("\n❌ Build failed.");
  process.exit(1);
}

console.log("  Copying static files...");
await $`cp -r ./static/* ./dist/`;
console.log("  ✅\n");

console.log("🎉 Extension ready in ./dist/");
console.log("   Load it in Chrome: chrome://extensions → Load unpacked → select ./dist/\n");

// ── Archive ───────────────────────────────────────────────────────────────────

process.stdout.write("  Archiving dist → selfhost-ocr.tar.gz...");

const archiveFiles: Record<string, Uint8Array> = {};
const glob = new Bun.Glob("**/*");

for await (const rel of glob.scan({ cwd: "./dist", onlyFiles: true })) {
  archiveFiles[rel] = await Bun.file(`./dist/${rel}`).bytes();
}

const archive = new Bun.Archive(archiveFiles);
await Bun.write("selfhost-ocr.tar.gz", archive);

const size = Bun.file("selfhost-ocr.tar.gz").size;
console.log(` ✅  (${(size / 1024).toFixed(1)} KB)`);
console.log("   selfhost-ocr.tar.gz ready for distribution.");
