// CaptureX - service worker (Manifest V3)
// Responsibilities:
//   1. Inject the content script into the active tab on demand.
//   2. Provide rate-limited chrome.tabs.captureVisibleTab() frames.
//   3. Track capture state so a reopened popup can rehydrate its UI.
// All page measurement, scrolling, stitching and downloading happens in
// content.js, which keeps this worker tiny and resilient to being suspended.

// Chrome hard-limits captureVisibleTab to MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (2).
// We pace calls at least this far apart, with a little headroom.
const CAPTURE_INTERVAL_MS = 550;

let lastCaptureAt = 0;
let captureWindowId = null;

// Lightweight state so the popup can catch up if it was closed and reopened.
// Lives in the worker's memory; if the worker is torn down it resets to idle,
// which is fine because the download itself is handled inside the page.
let captureState = { status: "idle" };

const BLOCKED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;
const BLOCKED_HOST = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "START_CAPTURE":
      startCapture(message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: errText(err) }));
      return true; // async response

    case "CAPTURE_VISIBLE":
      captureVisible()
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((err) => sendResponse({ ok: false, error: errText(err) }));
      return true; // async response

    case "GET_STATE":
      sendResponse(captureState);
      return false;

    // Observe the content script's broadcasts to keep captureState current.
    case "CAPTURE_STAGE":
      captureState = { status: "running", stage: message.text || "Preparing...", done: 0, total: 0 };
      return false;

    case "CAPTURE_PROGRESS":
      captureState = { status: "running", done: message.done, total: message.total };
      return false;

    case "CAPTURE_DONE":
      captureState = { status: "done", result: message };
      return false;

    case "CAPTURE_ERROR":
      captureState = { status: "error", error: message.error };
      return false;

    default:
      return false;
  }
});

async function startCapture(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    return { ok: false, error: "No active tab was found." };
  }

  const url = tab.url || "";
  if (BLOCKED_URL.test(url) || BLOCKED_HOST.test(url)) {
    return {
      ok: false,
      error: "This page cannot be captured. Open a normal website tab and try again."
    };
  }

  captureWindowId = tab.windowId;
  captureState = { status: "running", stage: "Preparing...", done: 0, total: 0 };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (err) {
    captureState = { status: "idle" };
    return {
      ok: false,
      error: "Could not access this page. Some pages (browser or store pages) block extensions."
    };
  }

  // Kick off the capture inside the page. The content script acknowledges
  // immediately and then reports progress / completion via broadcast messages,
  // so the whole flow does not depend on this worker staying alive.
  try {
    const ack = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_CAPTURE",
      mode: message.mode === "visible" ? "visible" : "full",
      format: message.format === "png" ? "png" : "jpeg",
      quality: clampQuality(message.quality)
    });
    return ack || { ok: true };
  } catch (err) {
    captureState = { status: "idle" };
    return { ok: false, error: "The page did not respond. Try reloading the tab." };
  }
}

async function captureVisible() {
  const gap = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
  if (gap > 0) await sleep(gap);

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(captureWindowId, { format: "png" });
  } catch (err) {
    // The most common failure is exceeding the rate limit; back off once and retry.
    await sleep(CAPTURE_INTERVAL_MS);
    dataUrl = await chrome.tabs.captureVisibleTab(captureWindowId, { format: "png" });
  }
  lastCaptureAt = Date.now();

  if (!dataUrl) throw new Error("The browser returned an empty screenshot.");
  return dataUrl;
}

function clampQuality(q) {
  const n = typeof q === "number" ? q : 0.92;
  return Math.min(1, Math.max(0.5, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err) {
  return String((err && err.message) || err || "Unknown error");
}
