<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="CaptureX" />
</p>

<h1 align="center">CaptureX</h1>

<p align="center">
  Capture the <b>entire</b> scrollable web page as one high-resolution image and download it as <b>JPG</b>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-7C3AED" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Chrome-Extension-4338CA" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/License-MIT-5B21B6" alt="MIT License" />
</p>

---

## What it does

CaptureX takes a full-page screenshot of the active tab. It scrolls the page
from top to bottom (and left to right for wide pages), grabs every viewport,
and stitches the frames into a single image on a canvas. You get the whole page
in one file, not just the part that fits on screen.

- **Full page or visible area** - toggle between the complete page and the current viewport.
- **JPG download** - one click saves the stitched image to your Downloads folder as a `.jpg`.
- **PNG option** - switch to lossless PNG when you need it.
- **Quality control** - a slider sets the JPG quality.
- **Sticky and fixed aware** - fixed bars are captured once at the top; sticky elements are rendered in their natural place instead of repeating down every tile.
- **Lazy-load aware** - the page is pre-scrolled to trigger lazy images and let its height settle before capture.
- **High-DPI correct** - output is rendered at the device pixel ratio, so text stays crisp, with tile edges aligned to a single pixel grid (no seams at 125 or 150 percent scaling).
- **Minimal permissions** - `activeTab` and `scripting` only. No `<all_urls>`, no background tracking, nothing leaves your machine.

## Install (unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `CaptureX` folder.
5. Pin CaptureX to the toolbar and open any page.

## Usage

1. Click the CaptureX icon.
2. Keep **Full page** on to capture everything, or turn it off to capture just what is on screen.
3. Choose **JPG** or **PNG** and set the quality.
4. Click **Capture full page**. The image is saved to your Downloads folder automatically, and a preview appears in the popup.

The file is named `CaptureX-<site>-<timestamp>.jpg`.

## How it works

```
popup.js  ->  background.js  ->  content.js
  (options)     (worker)          (in the page)
```

1. **popup.js** collects the options and asks the service worker to start.
2. **background.js** injects the content script into the active tab and provides
   rate-limited `chrome.tabs.captureVisibleTab()` frames (Chrome allows two per
   second, so calls are paced automatically).
3. **content.js** measures the page, hides scrollbars without disabling
   scrolling, scrolls tile by tile, draws each captured frame onto a canvas at
   the correct offset, exports the canvas to JPG or PNG, and triggers the
   download. Progress is broadcast back to the popup.

Very large pages are scaled down to stay within the browser canvas limits, so
the output is never blank.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read and capture the tab you are on, only when you click the icon. |
| `scripting` | Inject the capture logic into that tab on demand. |

CaptureX has no `host_permissions` and no network access. It cannot run in the
background or read pages you have not explicitly captured.

## Limitations

- Browser-internal pages (`chrome://`, the Web Store, extension pages) cannot be
  captured - Chrome blocks all extensions from them.
- Cross-origin iframes are captured as they render on screen.
- Extremely tall pages are downscaled to fit the maximum canvas size.

## Development

The extension is plain JavaScript with no build step. Edit the files and reload
the extension from `chrome://extensions`.

Icons are generated from `assets/logo.svg`.

## License

[MIT](LICENSE) - XProject25
