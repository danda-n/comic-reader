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

/**
 * Full-bleed pages (cover art) sometimes have their artwork placed a hair smaller
 * than the page, leaving a thin strip of page background along an edge. If a single
 * image covers nearly the whole page, return the part of the page it actually covers
 * so we can zoom in just enough for the art to reach every edge. Otherwise null.
 */
function fullBleedArtRect(page) {
  const [x0, y0, x1, y1] = page.getBounds();
  const pw = x1 - x0;
  const ph = y1 - y0;
  const rects = [];
  const device = new mupdf.Device({
    fillImage(_image, ctm) {
      rects.push(mupdf.Rect.transform([0, 0, 1, 1], ctm));
    },
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();

  const MAX_GAP = 0.03; // only fix slivers: at most 3% of the page per edge
  for (const [a, b, c, d] of rects) {
    const vis = [Math.max(a, x0), Math.max(b, y0), Math.min(c, x1), Math.min(d, y1)];
    const gaps = [vis[0] - x0, vis[1] - y0, x1 - vis[2], y1 - vis[3]];
    const sliver = gaps.every((g, k) => g <= MAX_GAP * (k % 2 ? ph : pw));
    if (sliver && gaps.some((g) => g > 0.05)) return vis;
  }
  return null;
}

/** Rasterise every page of a PDF to a PNG buffer at roughly the target height. */
async function* renderPdf(buffer) {
  const doc = mupdf.Document.openDocument(buffer, "application/pdf");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const [x0, y0, , y1] = page.getBounds();
    // Render a bit above the target so the final downscale is crisp.
    const scale = (config.pageHeight * 1.25) / (y1 - y0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    let png = Buffer.from(pixmap.asPNG());

    const art = fullBleedArtRect(page);
    if (art) {
      const [w, h] = [pixmap.getWidth(), pixmap.getHeight()];
      const left = Math.ceil((art[0] - x0) * scale);
      const top = Math.ceil((art[1] - y0) * scale);
      const right = Math.floor((art[2] - x0) * scale);
      const bottom = Math.floor((art[3] - y0) * scale);
      // Crop to the art, then zoom back to the page's exact size (aspect preserved).
      png = await sharp(png)
        .extract({ left, top, width: Math.min(w, right) - left, height: Math.min(h, bottom) - top })
        .resize({ width: w, height: h, fit: "cover" })
        .png()
        .toBuffer();
      console.log(`  page ${i + 1}: art stopped short of the page edge; zoomed to fill`);
    }

    yield png;
    pixmap.destroy();
    page.destroy();
  }
  doc.destroy();
}

const pages = [];
for (const file of files) {
  const buffer = await fs.readFile(path.join(PAGES, file));
  const rasters = file.toLowerCase().endsWith(".pdf") ? renderPdf(buffer) : [buffer];
  for await (const raster of rasters) {
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
