// CaptureX - content script
// Injected on demand into the active tab. Drives the full-page capture:
//   measure -> hide scrollbars -> pre-scroll to trigger lazy content ->
//   scroll tile by tile -> ask the worker for each visible frame ->
//   stitch onto a canvas -> export -> download.
// Progress and completion are broadcast over chrome.runtime.sendMessage so the
// popup can follow along (and rehydrate if reopened) and so the download still
// completes even if the popup is closed.

(() => {
  // Guard against the script being injected more than once: keep exactly one
  // message listener for the lifetime of the page.
  if (window.__CAPTUREX_READY__) return;
  window.__CAPTUREX_READY__ = true;

  const SETTLE_MS = 250; // wait after each scroll for paint before capturing
  const PRELOAD_SETTLE_MS = 120; // lighter wait during the lazy-load pre-scroll
  const PRELOAD_MAX_STEPS = 200; // bound the pre-scroll on extreme pages
  // Conservative canvas ceiling that every GPU-backed Chrome build supports.
  // Pages larger than this are scaled down so the output is never blank.
  const MAX_SIDE = 16384;
  const MAX_AREA = MAX_SIDE * MAX_SIDE;

  let busy = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "RUN_CAPTURE") return;

    if (busy) {
      sendResponse({ ok: false, error: "A capture is already running." });
      return false;
    }

    busy = true;
    runCapture(message)
      .catch((err) => {
        broadcast({ type: "CAPTURE_ERROR", error: String((err && err.message) || err) });
      })
      .finally(() => {
        busy = false;
      });

    // Acknowledge right away; real results come as broadcasts.
    sendResponse({ ok: true, started: true });
    return false;
  });

  async function runCapture({ mode, format, quality }) {
    const isPng = format === "png";
    const visibleOnly = mode === "visible";

    const docEl = document.documentElement;
    if (!document.body) {
      throw new Error("This page has no content to capture.");
    }

    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;
    const originalScrollBehavior = docEl.style.scrollBehavior;

    let styleEl = null;
    let pinnedFixed = [];
    let pinnedSticky = [];

    try {
      broadcast({ type: "CAPTURE_STAGE", text: "Preparing..." });

      docEl.style.scrollBehavior = "auto";

      // Hide scrollbars WITHOUT disabling scrolling (overflow:hidden would clamp
      // scrollTop to 0). A stylesheet zeroes the scrollbar visuals instead.
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-capturex", "");
      styleEl.textContent =
        "html::-webkit-scrollbar,body::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}" +
        "html{scrollbar-width:none!important}";
      (document.head || docEl).appendChild(styleEl);

      if (!visibleOnly) {
        const pins = collectPinned();
        pinnedFixed = pins.fixed;
        pinnedSticky = pins.sticky;

        // Sticky elements are in-flow content: render them once at their natural
        // position by dropping the stickiness, instead of hiding them (which
        // would drop below-the-fold sticky headers) or leaving them (which would
        // duplicate a stuck header down every tile).
        for (const item of pinnedSticky) {
          item.el.style.setProperty("position", "static", "important");
        }

        // Trigger lazy-loaded images/sections and let the page settle to its
        // final height before we freeze the tile grid.
        await preloadLazyContent();
      }

      await raf();

      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const totalW = visibleOnly ? viewportW : measure("Width");
      const totalH = visibleOnly ? viewportH : measure("Height");
      const originX = visibleOnly ? originalScrollX : 0;
      const originY = visibleOnly ? originalScrollY : 0;

      const tiles = buildTiles(totalW, totalH, viewportW, viewportH, originX, originY, visibleOnly);

      let canvas = null;
      let ctx = null;
      let cssToPx = 1; // physical pixels per CSS pixel (device ratio / zoom)
      let fit = 1; // downscale factor when the page exceeds the canvas limits

      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];

        // Fixed elements are viewport-anchored: show them only on the very first
        // tile (top-left) so they are captured once and never duplicated.
        if (!visibleOnly) setFixedVisible(pinnedFixed, i === 0);

        window.scrollTo({ left: tile.x, top: tile.y, behavior: "instant" });
        await raf();
        await sleep(SETTLE_MS);

        const dataUrl = await requestFrame();
        const frame = await loadImage(dataUrl);

        if (i === 0) {
          cssToPx = frame.width / viewportW || 1;
          const fullW = Math.round(totalW * cssToPx);
          const fullH = Math.round(totalH * cssToPx);
          fit = Math.min(
            1,
            MAX_SIDE / fullW,
            MAX_SIDE / fullH,
            Math.sqrt(MAX_AREA / (fullW * fullH))
          );
          canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(fullW * fit));
          canvas.height = Math.max(1, Math.floor(fullH * fit));
          ctx = canvas.getContext("2d");
          if (!isPng) {
            // JPEG has no alpha; paint white so transparent regions are not black.
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
        }

        // Derive the destination rectangle from a single integer grid so that
        // adjacent tiles share exact edges (no 1px seams at fractional DPR) and
        // the far row/column is not clipped.
        const ox = (tile.x - originX) * cssToPx;
        const oy = (tile.y - originY) * cssToPx;
        const dx = Math.round(ox * fit);
        const dy = Math.round(oy * fit);
        const right = Math.min(canvas.width, Math.round((ox + frame.width) * fit));
        const bottom = Math.min(canvas.height, Math.round((oy + frame.height) * fit));
        ctx.drawImage(frame, dx, dy, Math.max(1, right - dx), Math.max(1, bottom - dy));

        broadcast({ type: "CAPTURE_PROGRESS", done: i + 1, total: tiles.length });
      }

      const mime = isPng ? "image/png" : "image/jpeg";
      const blob = await canvasToBlob(canvas, mime, isPng ? undefined : quality);
      if (!blob) throw new Error("The image was too large to export. Try a shorter page or PNG.");

      const filename = buildFilename(isPng ? "png" : "jpg");
      triggerDownload(blob, filename);

      const thumb = makeThumb(canvas);
      broadcast({
        type: "CAPTURE_DONE",
        filename,
        width: canvas.width,
        height: canvas.height,
        bytes: blob.size,
        thumb
      });
    } finally {
      // Always restore the page to how we found it, in reverse order.
      for (const item of pinnedSticky) {
        if (item.value) item.el.style.setProperty("position", item.value, item.priority);
        else item.el.style.removeProperty("position");
      }
      for (const item of pinnedFixed) {
        item.el.style.visibility = item.visibility;
      }
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      docEl.style.scrollBehavior = originalScrollBehavior;
      window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: "instant" });
    }
  }

  // Scroll the whole page once to wake lazy loaders and let the height stabilize.
  async function preloadLazyContent() {
    const step = Math.max(200, window.innerHeight);
    let height = measure("Height");
    let y = 0;
    let steps = 0;
    while (y < height && steps < PRELOAD_MAX_STEPS) {
      window.scrollTo({ left: 0, top: y, behavior: "instant" });
      await raf();
      await sleep(PRELOAD_SETTLE_MS);
      height = measure("Height");
      broadcast({ type: "CAPTURE_STAGE", text: "Loading page content..." });
      y += step;
      steps += 1;
    }
    window.scrollTo({ left: 0, top: measure("Height"), behavior: "instant" });
    await raf();
    await sleep(SETTLE_MS);
  }

  function measure(dim) {
    const docEl = document.documentElement;
    const body = document.body;
    return Math.max(
      docEl["scroll" + dim],
      docEl["offset" + dim],
      docEl["client" + dim],
      body ? body["scroll" + dim] : 0,
      body ? body["offset" + dim] : 0
    );
  }

  function buildTiles(totalW, totalH, viewportW, viewportH, originX, originY, visibleOnly) {
    if (visibleOnly) {
      return [{ x: originX, y: originY }];
    }
    const cols = Math.max(1, Math.ceil(totalW / viewportW));
    const rows = Math.max(1, Math.ceil(totalH / viewportH));
    const seen = new Set();
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let x = c * viewportW;
        let y = r * viewportH;
        if (x + viewportW > totalW) x = Math.max(0, totalW - viewportW);
        if (y + viewportH > totalH) y = Math.max(0, totalH - viewportH);
        const key = x + "|" + y;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({ x, y });
      }
    }
    return tiles;
  }

  function collectPinned() {
    const fixed = [];
    const sticky = [];
    const nodes = document.body.querySelectorAll("*");
    for (const el of nodes) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed") {
        fixed.push({ el, visibility: el.style.visibility });
      } else if (pos === "sticky") {
        sticky.push({
          el,
          value: el.style.position,
          priority: el.style.getPropertyPriority("position")
        });
      }
    }
    return { fixed, sticky };
  }

  function setFixedVisible(pinnedFixed, visible) {
    for (const item of pinnedFixed) {
      item.el.style.visibility = visible ? item.visibility : "hidden";
    }
  }

  async function requestFrame() {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE" });
    if (!res || !res.ok) throw new Error((res && res.error) || "Screenshot failed.");
    return res.dataUrl;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function buildFilename(ext) {
    const host = (location.hostname || "page").replace(/[^a-z0-9.-]/gi, "_");
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds());
    return `CaptureX-${host}-${stamp}.${ext}`;
  }

  function makeThumb(canvas) {
    try {
      const maxW = 360;
      const maxH = 360;
      const scale = Math.min(1, maxW / canvas.width, maxH / canvas.height);
      const tc = document.createElement("canvas");
      tc.width = Math.max(1, Math.round(canvas.width * scale));
      tc.height = Math.max(1, Math.round(canvas.height * scale));
      const tctx = tc.getContext("2d");
      tctx.fillStyle = "#ffffff";
      tctx.fillRect(0, 0, tc.width, tc.height);
      tctx.drawImage(canvas, 0, 0, tc.width, tc.height);
      return tc.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      return null;
    }
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), mime, quality);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read a captured frame."));
      img.src = src;
    });
  }

  function broadcast(payload) {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (e) {
      // Popup may be closed; ignore.
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function raf() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
})();
