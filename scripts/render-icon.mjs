#!/usr/bin/env node
// Renders assets/icon.svg to .claude-plugin/icon.png, the Claude plugin
// listing icon: a square 1024 px PNG (the validator accepts 512 to 2048 px
// per side, under 2 MB; SVG is not accepted). Needs Playwright with Chromium,
// which is not a dependency of this package: install it globally or run
// `npx -p playwright node scripts/render-icon.mjs`.
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "assets", "icon.svg");
const out = join(root, ".claude-plugin", "icon.png");

const { chromium } = createRequire(import.meta.url)("playwright");
const svg = readFileSync(src).toString("base64");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0"><img id="icon" src="data:image/svg+xml;base64,${svg}" width="${SIZE}" height="${SIZE}" style="display:block"></body>`,
  );
  await page.locator("#icon").evaluate((img) => img.decode());
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
} finally {
  await browser.close();
}

const png = readFileSync(out);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== SIZE || height !== SIZE) throw new Error(`expected ${SIZE}x${SIZE}, got ${width}x${height}`);
console.log(`wrote ${out}: ${width}x${height}, ${statSync(out).size} bytes`);
