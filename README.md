# Comic Reader

A small, fast, static comic reader hosted on GitHub Pages.

**Read it:** https://danda-n.github.io/comic-reader/

## Adding or replacing pages

1. Put one PDF per page into [`pages/`](pages). Order is taken from the filename
   (`page01.pdf`, `page02.pdf`, … `page10.pdf`). Multi-page PDFs and JPG/PNG/WebP images work too.
2. Commit and push to `main`.

GitHub Actions converts the PDFs to optimised WebP images, generates thumbnails and
redeploys the site in a minute or two. To replace a page, overwrite its PDF and push.

## Settings

[`comic.config.json`](comic.config.json):

| Key              | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `title`          | Shown in the header and browser tab                                  |
| `firstPageAlone` | In double-page mode, show page 1 on its own (like a cover)           |
| `pageHeight`     | Pixel height of the generated page images (higher = sharper zoom)    |
| `quality`        | WebP quality, 1–100                                                  |

## Reader controls

| Action            | Mouse / keyboard                         | Touch                    |
| ----------------- | ---------------------------------------- | ------------------------ |
| Next / previous   | `→` `←`, `Space`, click page edges       | Swipe, tap page edges    |
| Zoom              | Scroll wheel, double-click, `+` `-` `0`  | Pinch, double-tap        |
| Pan when zoomed   | Drag                                     | Drag                     |
| Single / double   | `D`                                      | Toolbar button           |
| All pages         | `T`                                      | Toolbar button           |
| Fullscreen        | `F`                                      | Toolbar button           |
| Show / hide bars  | Move the mouse                           | Tap the middle           |

Reading position is remembered in the browser.

## Local preview

```bash
npm install
npm run dev
```

Then open http://localhost:4173.
