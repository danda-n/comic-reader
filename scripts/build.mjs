// Builds the static site into dist/:
//   pages/*.pdf (or .jpg/.png/.webp)  ->  dist/pages/*.webp + thumbnails + manifest.json
//   src/*                             ->  dist/
// Pages are ordered by natural filename sort (page2 before page10).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
const PAGES = path.join(root, "pages");
const DIST = path.join(root, "dist");

const config = {
  title: "Comic Reader",
  firstPageAlone: true,
  pageHeight: 2400,
  thumbHeight: 360,
  quality: 82,
  ...JSON.parse(await fs.readFile(path.join(root, "comic.config.json"), "utf8")),
};

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(path.join(DIST, "pages"), { recursive: true });
await fs.cp(SRC, DIST, { recursive: true });

const files = (await fs.readdir(PAGES).catch(() => []))
  .filter((f) => !f.startsWith(".") && (f.toLowerCase().endsWith(".pdf") || IMAGE_EXT.has(path.extname(f).toLowerCase())))
  .sort(collator.compare);

/** Rasterise every page of a PDF to a PNG buffer at roughly the target height. */
function* renderPdf(buffer) {
  const doc = mupdf.Document.openDocument(buffer, "application/pdf");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const [, y0, , y1] = page.getBounds();
    // Render a bit above the target so the final downscale is crisp.
    const scale = (config.pageHeight * 1.25) / (y1 - y0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    yield Buffer.from(pixmap.asPNG());
    pixmap.destroy();
    page.destroy();
  }
  doc.destroy();
}

const pages = [];
for (const file of files) {
  const buffer = await fs.readFile(path.join(PAGES, file));
  const rasters = file.toLowerCase().endsWith(".pdf") ? renderPdf(buffer) : [buffer];
  for (const raster of rasters) {
    const n = String(pages.length + 1).padStart(3, "0");
    const full = await sharp(raster)
      .resize({ height: config.pageHeight, withoutEnlargement: true })
      .webp({ quality: config.quality })
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(raster).resize({ height: config.thumbHeight }).webp({ quality: 70 }).toBuffer();
    // Content hash in the filename so replaced pages are never served stale from cache.
    const hash = crypto.createHash("sha1").update(full.data).digest("hex").slice(0, 8);
    const src = `pages/${n}-${hash}.webp`;
    const thumbSrc = `pages/${n}-${hash}-thumb.webp`;
    await fs.writeFile(path.join(DIST, src), full.data);
    await fs.writeFile(path.join(DIST, thumbSrc), thumb);
    pages.push({ src, thumb: thumbSrc, w: full.info.width, h: full.info.height });
    console.log(`${file} -> ${src} (${full.info.width}x${full.info.height}, ${(full.data.length / 1024).toFixed(0)} KB)`);
  }
}

const manifest = { title: config.title, firstPageAlone: config.firstPageAlone, pages };
await fs.writeFile(path.join(DIST, "manifest.json"), JSON.stringify(manifest));

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const indexPath = path.join(DIST, "index.html");
await fs.writeFile(indexPath, (await fs.readFile(indexPath, "utf8")).replaceAll("{{TITLE}}", escapeHtml(config.title)));

// Keep the site out of search engines; it is meant to be shared by link only.
await fs.writeFile(path.join(DIST, "robots.txt"), "User-agent: *\nDisallow: /\n");
await fs.writeFile(path.join(DIST, ".nojekyll"), "");

console.log(`Built ${pages.length} page(s) into dist/`);
