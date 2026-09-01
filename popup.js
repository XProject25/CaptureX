// CaptureX - popup controller
// Collects the user's options, starts a capture in the active tab, and reflects
// progress / completion that the content script broadcasts back. On open it
// rehydrates from the service worker so a capture started earlier is still shown.

const els = {
  captureBtn: document.getElementById("captureBtn"),
  captureLabel: document.querySelector(".primary__label"),
  fullPage: document.getElementById("fullPage"),
  quality: document.getElementById("quality"),
  qualityValue: document.getElementById("qualityValue"),
  qualityField: document.getElementById("qualityField"),
  formatBtns: Array.from(document.querySelectorAll(".segmented__btn")),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  result: document.getElementById("result"),
  resultThumb: document.getElementById("resultThumb"),
  resultFile: document.getElementById("resultFile"),
  resultDims: document.getElementById("resultDims"),
  error: document.getElementById("error"),
  errorText: document.getElementById("errorText")
};

// If no capture message arrives for this long, assume the capture died (page
// navigated away or crashed) and re-enable the button.
const WATCHDOG_MS = 30000;

let format = "jpeg";
let capturing = false;
let watchdog = null;

// Quality slider label.
els.quality.addEventListener("input", () => {
  els.qualityValue.textContent = els.quality.value + "%";
});

// Format toggle (JPG / PNG). PNG has no quality control.
els.formatBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (capturing) return;
    els.formatBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    format = btn.dataset.format;
    els.qualityField.classList.toggle("is-hidden", format !== "jpeg");
  });
});

els.captureBtn.addEventListener("click", startCapture);

// Rehydrate from the worker in case a capture is already running or just finished.
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (chrome.runtime.lastError || !state) return;
  if (state.status === "running") {
    enterCapturingUI(state.stage || "Capturing...");
    if (state.total) {
      setProgress(state.done / state.total);
      els.statusText.textContent = `Capturing frame ${state.done} of ${state.total}...`;
    }
    armWatchdog();
  } else if (state.status === "done" && state.result) {
    finishOk(state.result);
  } else if (state.status === "error") {
    fail(state.error || "The last capture failed.");
  }
});

function startCapture() {
  if (capturing) return;
  enterCapturingUI("Preparing...");
  armWatchdog();

  chrome.runtime.sendMessage(
    {
      type: "START_CAPTURE",
      mode: els.fullPage.checked ? "full" : "visible",
      format,
      quality: Number(els.quality.value) / 100
    },
    (response) => {
      if (chrome.runtime.lastError) {
        return fail(chrome.runtime.lastError.message || "Could not reach the page.");
      }
      if (response && response.ok === false) {
        return fail(response.error || "Capture could not start.");
      }
      // Success path continues via broadcast messages below.
    }
  );
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "CAPTURE_STAGE":
      armWatchdog();
      enterCapturingUI(message.text || "Working...");
      break;
    case "CAPTURE_PROGRESS":
      armWatchdog();
      enterCapturingUI();
      setProgress(message.total ? message.done / message.total : 0);
      els.statusText.textContent = `Capturing frame ${message.done} of ${message.total}...`;
      break;
    case "CAPTURE_DONE":
      finishOk(message);
      break;
    case "CAPTURE_ERROR":
      fail(message.error || "Something went wrong during capture.");
      break;
  }
});

function enterCapturingUI(stageText) {
  capturing = true;
  els.captureBtn.disabled = true;
  els.captureLabel.textContent = "Capturing...";
  hide(els.result);
  hide(els.error);
  show(els.status);
  if (stageText) {
    els.statusText.textContent = stageText;
    if (stageText === "Preparing..." || stageText.indexOf("Loading") === 0) setProgress(0);
  }
}

function finishOk(message) {
  clearWatchdog();
  setProgress(1);
  hide(els.status);
  hide(els.error);
  if (message.thumb) {
    els.resultThumb.src = message.thumb;
  }
  els.resultFile.textContent = message.filename || "";
  els.resultDims.textContent = formatDims(message);
  show(els.result);
  resetButton();
}

function formatDims(message) {
  const parts = [];
  if (message.width && message.height) parts.push(message.width + " x " + message.height + " px");
  if (message.bytes) parts.push(formatBytes(message.bytes));
  return parts.join("  |  ");
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function fail(msg) {
  clearWatchdog();
  hide(els.status);
  hide(els.result);
  els.errorText.textContent = msg;
  show(els.error);
  resetButton();
}

function resetButton() {
  capturing = false;
  els.captureBtn.disabled = false;
  els.captureLabel.textContent = "Capture full page";
}

function armWatchdog() {
  clearWatchdog();
  watchdog = setTimeout(() => {
    if (capturing) fail("The capture stopped responding. Try reloading the tab.");
  }, WATCHDOG_MS);
}

function clearWatchdog() {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

function setProgress(fraction) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  els.progressBar.style.width = pct.toFixed(0) + "%";
}

function show(el) {
  el.hidden = false;
}

function hide(el) {
  el.hidden = true;
}
