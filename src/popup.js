const headerStatusDot = document.getElementById("headerStatusDot");
const patternName = document.getElementById("patternName");
const marketBias = document.getElementById("marketBias");
const confidence = document.getElementById("confidence");
const sampleCount = document.getElementById("sampleCount");
const predictedMove = document.getElementById("predictedMove");
const forecastText = document.getElementById("forecastText");
const patternScores = document.getElementById("patternScores");
const scoresSection = document.getElementById("scoresSection");
const patternCount = document.getElementById("patternCount");
const sourceSelect = document.getElementById("sourceSelect");
const sourceEmoji = document.getElementById("sourceEmoji");
const startScan = document.getElementById("startScan");
const startTrading = document.getElementById("startTrading");
const stopScan = document.getElementById("stopScan");
const openGallery = document.getElementById("openGallery");
const closeGallery = document.getElementById("closeGallery");
const galleryPanel = document.getElementById("galleryPanel");
const galleryList = document.getElementById("galleryList");
const openSettings = document.getElementById("openSettings");
const closeSettings = document.getElementById("closeSettings");
const settingsPanel = document.getElementById("settingsPanel");
const modelMeta = document.getElementById("modelMeta");
const uploadChart = document.getElementById("uploadChart");
const uploadInput = document.getElementById("uploadInput");
const themeSwatches = [...document.querySelectorAll(".theme-swatch")];

let activeSource = "gmgn";
let manualSourceOverride = false;
let savedGalleryCount = 0;
const STORAGE_KEY = "chartTraderSavedCaptures";
const THEME_KEY = "valcTheme";
const MAX_STORED_CAPTURES = 60;
const MODEL_INFO = {
  classifier: {
    name: "Random Forest Classifier",
    trees: 25,
    maxDepth: 6,
    featureSampleSize: 4
  },
  regressor: {
    name: "Random Forest Regressor",
    trees: 21,
    maxDepth: 5,
    featureSampleSize: 4
  }
};
const sourceEmojis = {
  gmgn: "🦖",
  axiom: "🔺",
  terminal: "💊",
  phantom: "👻",
  tradingview: "⚪"
};
const SOURCE_PROFILES = {
  gmgn: { top: 0.14, bottom: 0.88, left: 0.06, right: 0.94, colorWeight: 1.05, scoreBoost: 1.14 },
  axiom: { top: 0.16, bottom: 0.9, left: 0.08, right: 0.95, colorWeight: 0.9, scoreBoost: 1.12 },
  terminal: { top: 0.1, bottom: 0.94, left: 0.04, right: 0.96, colorWeight: 0.55, scoreBoost: 1.05 },
  phantom: { top: 0.18, bottom: 0.9, left: 0.1, right: 0.95, colorWeight: 1.0, scoreBoost: 1.15 },
  tradingview: { top: 0.12, bottom: 0.9, left: 0.07, right: 0.93, colorWeight: 0.75, scoreBoost: 1.1 }
};
let learningLibPromise = null;

function loadScriptOnce(path) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${path}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Could not load ${path}`)), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.src = path;
    script.dataset.src = path;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener("error", () => reject(new Error(`Could not load ${path}`)), {
      once: true
    });
    document.head.appendChild(script);
  });
}

async function ensureLearningLibLoaded() {
  if (globalThis.ChartML && globalThis.ChartPatternLib) {
    return;
  }

  if (!learningLibPromise) {
    learningLibPromise = (async () => {
      await loadScriptOnce("src/patterns.js");
      await loadScriptOnce("src/model.js");
    })();
  }

  await learningLibPromise;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

function interpolateSparseSeries(points, width) {
  if (points.length < 12) {
    return [];
  }

  const dense = [];
  let pointIndex = 0;
  for (let x = 0; x < width; x += 1) {
    while (pointIndex < points.length - 1 && points[pointIndex + 1].x < x) {
      pointIndex += 1;
    }

    const left = points[pointIndex];
    const right = points[Math.min(points.length - 1, pointIndex + 1)];
    if (!left || !right) {
      continue;
    }

    if (left.x === right.x) {
      dense.push(left.y);
      continue;
    }

    const ratio = (x - left.x) / (right.x - left.x);
    dense.push(left.y + (right.y - left.y) * ratio);
  }

  if (dense.length < 24) {
    return [];
  }

  const smoothed = dense.map((_, index) => {
    const slice = dense.slice(Math.max(0, index - 2), Math.min(dense.length, index + 3));
    return average(slice);
  });

  const min = Math.min(...smoothed);
  const max = Math.max(...smoothed);
  if (Math.abs(max - min) < 4) {
    return [];
  }

  return smoothed.map((value) => max - value);
}

function extractSeriesFromImageData(imageData, selectedSource) {
  const { data, width, height } = imageData;
  const profile = SOURCE_PROFILES[selectedSource] || SOURCE_PROFILES.gmgn;
  const top = Math.floor(height * profile.top);
  const bottom = Math.floor(height * profile.bottom);
  const left = Math.floor(width * profile.left);
  const right = Math.floor(width * profile.right);
  const points = [];
  const scores = [];

  function brightnessAt(x, y) {
    const offset = (y * width + x) * 4;
    return (data[offset] + data[offset + 1] + data[offset + 2]) / 765;
  }

  function colorfulnessAt(x, y) {
    const offset = (y * width + x) * 4;
    return (Math.max(data[offset], data[offset + 1], data[offset + 2]) - Math.min(data[offset], data[offset + 1], data[offset + 2])) / 255;
  }

  for (let x = left + 1; x < right - 1; x += 1) {
    let bestY = -1;
    let bestScore = 0;
    for (let y = top + 1; y < bottom - 1; y += 1) {
      const center = brightnessAt(x, y);
      const vertical = (brightnessAt(x, y - 1) + brightnessAt(x, y + 1)) / 2;
      const horizontal = (brightnessAt(x - 1, y) + brightnessAt(x + 1, y)) / 2;
      const localContrast = Math.abs(center - vertical) + Math.abs(center - horizontal);
      const score = localContrast + colorfulnessAt(x, y) * profile.colorWeight;
      if (score > bestScore) {
        bestScore = score;
        bestY = y;
      }
    }
    if (bestY !== -1) {
      scores.push(bestScore);
      points.push({ x: x - left, y: bestY - top, score: bestScore });
    }
  }

  if (points.length < 24) {
    return [];
  }

  const scoreFloor = Math.max(average(scores) * profile.scoreBoost, 0.14);
  return interpolateSparseSeries(points.filter((point) => point.score >= scoreFloor), right - left);
}

async function decodeImageFromFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });

  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return { dataUrl, image };
}

async function buildCaptureFromUpload(file) {
  const { dataUrl, image } = await decodeImageFromFile(file);
  const sampleWidth = 220;
  const sampleHeight = Math.max(140, Math.round((image.height / image.width) * sampleWidth));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const series = extractSeriesFromImageData(context.getImageData(0, 0, sampleWidth, sampleHeight), activeSource);

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 132;
  previewCanvas.height = 88;
  previewCanvas.getContext("2d").drawImage(image, 0, 0, previewCanvas.width, previewCanvas.height);

  return {
    originalDataUrl: dataUrl,
    previewDataUrl: previewCanvas.toDataURL("image/jpeg", 0.72),
    series
  };
}

async function saveUploadedCapture(file) {
  await ensureLearningLibLoaded();
  const capture = await buildCaptureFromUpload(file);
  if (!capture.series.length || capture.series.length < 24) {
    throw new Error("Could not find a usable chart line in the uploaded image.");
  }

  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const items = result[STORAGE_KEY] || [];
  const nextCapture = {
    capturedAt: Date.now(),
    label: globalThis.ChartML.inferLabelFromSeries(capture.series),
    previewDataUrl: capture.previewDataUrl,
    selectedSource: activeSource,
    series: capture.series,
    target: globalThis.ChartML.deriveRegressionTarget(capture.series),
    url: `uploaded://${file.name}`
  };
  const nextItems = items.concat(nextCapture).slice(-MAX_STORED_CAPTURES);
  await chrome.storage.local.set({ [STORAGE_KEY]: nextItems });
  globalThis.ChartML.setUserExamples(nextItems);
  savedGalleryCount = nextItems.length;
  return nextCapture;
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "";
  }
  return new Date(timestamp).toLocaleString();
}

async function deleteSavedCapture(index) {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const items = result[STORAGE_KEY] || [];
  if (index < 0 || index >= items.length) {
    return;
  }

  const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
  await chrome.storage.local.set({ [STORAGE_KEY]: nextItems });
  savedGalleryCount = nextItems.length;

  if (globalThis.ChartML?.setUserExamples) {
    globalThis.ChartML.setUserExamples(nextItems);
  }

  renderGallery(nextItems);
  renderState({
    status: "ready",
    savedCount: savedGalleryCount,
    captureCount: Math.min(savedGalleryCount, 10),
    result: null,
    message: "Saved photo deleted."
  });
}

function renderGallery(items = []) {
  galleryList.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "gallery-text";
    empty.textContent = "No saved scans yet.";
    galleryList.appendChild(empty);
    return;
  }

  items
    .slice()
    .reverse()
    .forEach((item, reversedIndex) => {
      const itemIndex = items.length - 1 - reversedIndex;
      const card = document.createElement("article");
      card.className = "gallery-item";
      if (itemIndex < 10) {
        card.classList.add("gallery-item-core");
      }

      const image = document.createElement("img");
      image.src = item.previewDataUrl;
      image.alt = item.label || "Saved chart scan";
      if (itemIndex < 10) {
        image.classList.add("gallery-core-image");
      }

      const meta = document.createElement("div");
      meta.className = "gallery-meta";

      const title = document.createElement("div");
      title.className = "gallery-title";
      title.textContent = `${item.selectedSource || "scan"} ${sourceEmojis[item.selectedSource] || ""}`.trim();

      const label = document.createElement("div");
      label.className = "gallery-text";
      label.textContent = itemIndex < 10
        ? `Pattern: ${item.label || "Unknown"} • Core training photo`
        : `Pattern: ${item.label || "Unknown"}`;

      const time = document.createElement("div");
      time.className = "gallery-text";
      time.textContent = formatDate(item.capturedAt);

      const url = document.createElement("div");
      url.className = "gallery-text";
      if (item.url && /^https?:\/\//i.test(item.url)) {
        const link = document.createElement("a");
        link.className = "gallery-link";
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = item.url;
        url.appendChild(link);
      } else {
        url.textContent = item.url || "";
      }

      const actions = document.createElement("div");
      actions.className = "gallery-actions";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        const confirmed = window.confirm("Delete this saved photo?");
        if (!confirmed) {
          return;
        }
        deleteSavedCapture(itemIndex).catch((error) => {
          renderState({
            status: "error",
            message: error?.message || "Could not delete saved photo."
          });
        });
      });

      meta.appendChild(title);
      meta.appendChild(label);
      meta.appendChild(time);
      meta.appendChild(url);
      actions.appendChild(remove);
      meta.appendChild(actions);
      card.appendChild(image);
      card.appendChild(meta);
      galleryList.appendChild(card);
    });
}

async function loadGallery() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const items = result[STORAGE_KEY] || [];
  savedGalleryCount = items.length;
  renderGallery(items);
  return items;
}

async function loadSavedGalleryCount() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  savedGalleryCount = (result[STORAGE_KEY] || []).length;
  return savedGalleryCount;
}

async function loadTheme() {
  const result = await chrome.storage.local.get([THEME_KEY]);
  const theme = result[THEME_KEY];
  if (!theme) {
    return;
  }
  if (theme.accent) {
    document.documentElement.style.setProperty("--accent", theme.accent);
  }
  if (theme.bg) {
    document.documentElement.style.setProperty("--bg", theme.bg);
  }
}

function renderSourceSelection() {
  sourceSelect.value = activeSource;
  sourceEmoji.textContent = sourceEmojis[activeSource] || "🦖";
}

function renderModelInfo() {
  modelMeta.textContent =
    `${MODEL_INFO.classifier.name}: ${MODEL_INFO.classifier.trees} trees, depth ${MODEL_INFO.classifier.maxDepth}, ${MODEL_INFO.classifier.featureSampleSize} features per split. ` +
    `${MODEL_INFO.regressor.name}: ${MODEL_INFO.regressor.trees} trees, depth ${MODEL_INFO.regressor.maxDepth}, ${MODEL_INFO.regressor.featureSampleSize} features per split.`;
}

function updatePatternCount(count = 0) {
  const safeCount = Math.max(0, Math.min(10, Number(count) || 0));
  patternCount.textContent = `${safeCount}/10`;
}

function renderHeaderStatus(state = {}) {
  const status = state.status || "idle";
  const hasResult = Boolean(state.result);
  const mode = state.mode || "scan";

  let className = "header-status-dot not-ready";
  let label = "Not ready to scan";

  if (status === "running" || status === "starting" || status === "training" || status === "live") {
    className = "header-status-dot scanning";
    label =
      status === "starting"
        ? mode === "trading"
          ? "Starting trading"
          : "Starting scan"
        : status === "training"
          ? "Training"
          : status === "live"
            ? mode === "trading"
              ? "Live trading data"
              : "Live chart data"
            : "Scanning";
  } else if (hasResult || status === "ready") {
    className = "header-status-dot ready";
    label = "Ready to scan";
  }

  headerStatusDot.className = className;
  headerStatusDot.setAttribute("aria-label", label);
  headerStatusDot.title = label;
}

function renderScores(scores = []) {
  patternScores.innerHTML = "";
  scores.slice(0, 5).forEach((entry) => {
    const item = document.createElement("div");
    item.className = "score-item";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = entry.label;

    const bar = document.createElement("div");
    bar.className = "score-bar";

    const fill = document.createElement("div");
    fill.className = "score-fill";
    fill.style.width = `${Math.round(entry.probability * 100)}%`;
    bar.appendChild(fill);

    left.appendChild(name);
    left.appendChild(bar);

    const pct = document.createElement("strong");
    pct.textContent = `${Math.round(entry.probability * 100)}%`;

    item.appendChild(left);
    item.appendChild(pct);
    patternScores.appendChild(item);
  });
}

function renderState(state = {}) {
  renderHeaderStatus(state);
  const visibleCount = state.captureCount || state.savedCount || savedGalleryCount || 0;

  if (state.status === "training") {
    updatePatternCount(state.captureCount || 0);
    patternName.textContent = "Training";
    marketBias.textContent = "Shared";
    confidence.textContent = "0%";
    sampleCount.textContent = `${state.savedCount || 0}`;
    predictedMove.textContent = "Learning";
    forecastText.textContent =
      state.message ||
      (state.mode === "trading"
        ? "Collecting chart photos before live trading answers start."
        : "Collecting chart photos before analysis starts.");
    patternScores.innerHTML = "";
    scoresSection.hidden = true;
    return;
  }

  if (state.status === "live" && state.result) {
    scoresSection.hidden = false;
    updatePatternCount(state.result.captureCount || state.captureCount || 10);
    patternName.textContent = state.result.pattern;
    marketBias.textContent = state.result.bias;
    confidence.textContent = `${state.result.confidence}%`;
    sampleCount.textContent = `${state.result.sampleCount}`;
    predictedMove.textContent = `${state.result.regression?.direction || "Flat"} ${state.result.regression?.strength || ""}`.trim();
    forecastText.textContent =
      state.message ||
      (state.mode === "trading"
        ? `${state.result.forecast} Fast trading answers are updating on the current chart.`
        : `${state.result.forecast} Live data is updating on the current chart.`);
    renderScores(state.result.scores);
    return;
  }

  if (!state.result) {
    updatePatternCount(visibleCount);
    patternName.textContent = "No signal yet";
    marketBias.textContent = "Neutral";
    confidence.textContent = "0%";
    sampleCount.textContent = `${state.savedCount || savedGalleryCount || 0}`;
    predictedMove.textContent = "Pending";
    forecastText.textContent = state.message || "Start a scan on an open chart tab to generate a forecast.";
    patternScores.innerHTML = "";
    scoresSection.hidden = true;
    return;
  }

  scoresSection.hidden = false;
  updatePatternCount(state.result.captureCount || state.captureCount || 10);
  patternName.textContent = state.result.pattern;
  marketBias.textContent = state.result.bias;
  confidence.textContent = `${state.result.confidence}%`;
  sampleCount.textContent = `${state.result.sampleCount}`;
  predictedMove.textContent = `${state.result.regression?.direction || "Flat"} ${state.result.regression?.strength || ""}`.trim();
  forecastText.textContent = `${state.result.forecast} Shared memory: ${state.result.savedCount || state.savedCount || 0} saved scans across all platforms.`;
  renderScores(state.result.scores);
}

sourceSelect.addEventListener("change", () => {
  activeSource = sourceSelect.value;
  manualSourceOverride = true;
  renderSourceSelection();
  requestState();
});

async function requestState() {
  if (!galleryPanel.hidden) {
    await loadSavedGalleryCount();
  }
  const response = await chrome.runtime.sendMessage({
    type: "POPUP_GET_STATE",
    selectedSource: manualSourceOverride ? activeSource : null
  });
  if (response?.ok) {
    if (!manualSourceOverride) {
      activeSource =
        response.state?.detectedSource ||
        response.state?.selectedSource ||
        activeSource;
    } else {
      activeSource = response.state?.selectedSource || activeSource;
    }
    renderSourceSelection();
    renderState(response.state);
  } else {
    renderState({
      status: "error",
      message: response?.error || "Unable to read extension state."
    });
  }
}

async function controlScan(type, mode = "scan") {
  const response = await chrome.runtime.sendMessage({
    type,
    selectedSource: activeSource,
    mode
  });
  if (!response?.ok) {
    renderState({
      status: "error",
      message: response?.error || "Could not control scan for this tab."
    });
    return false;
  }

  activeSource = response.state?.selectedSource || activeSource;
  renderSourceSelection();
  renderState(response.state);
  setTimeout(requestState, 220);
  return true;
}

startScan.addEventListener("click", () => {
  renderState({
    status: "starting",
    message: "Starting scan..."
  });
  controlScan("POPUP_START_SCAN", "scan").then((ok) => {
    if (!ok) {
      return;
    }
    window.setTimeout(() => {
      window.close();
    }, 40);
  });
});

startTrading.addEventListener("click", () => {
  renderState({
    status: "starting",
    mode: "trading",
    message: "Starting trading mode..."
  });
  controlScan("POPUP_START_SCAN", "trading").then((ok) => {
    if (!ok) {
      return;
    }
    window.setTimeout(() => {
      window.close();
    }, 40);
  });
});

stopScan.addEventListener("click", () => {
  controlScan("POPUP_STOP_SCAN");
});

openGallery.addEventListener("click", async () => {
  const nextHidden = !galleryPanel.hidden;
  galleryPanel.hidden = nextHidden;
  if (!nextHidden) {
    await loadGallery();
    requestState();
  }
});

closeGallery.addEventListener("click", () => {
  galleryPanel.hidden = true;
});

openSettings.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

closeSettings.addEventListener("click", () => {
  settingsPanel.hidden = true;
});

themeSwatches.forEach((swatch) => {
  swatch.addEventListener("click", async () => {
    const accent = swatch.dataset.accent;
    const bg = swatch.dataset.bg;
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--bg", bg);
    await chrome.storage.local.set({
      [THEME_KEY]: { accent, bg }
    });
  });
});

uploadChart.addEventListener("click", () => {
  uploadInput.click();
});

uploadInput.addEventListener("change", async () => {
  const [file] = uploadInput.files || [];
  if (!file) {
    return;
  }

  try {
    const capture = await saveUploadedCapture(file);
    await loadGallery();
    renderState({
      status: "ready",
      savedCount: savedGalleryCount,
      captureCount: Math.min(savedGalleryCount, 10),
      result: null,
      message: `Uploaded chart saved as ${capture.label}.`
    });
  } catch (error) {
    renderState({
      status: "error",
      message: error.message || "Could not upload chart."
    });
  } finally {
    uploadInput.value = "";
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_RESULT" || message?.type === "SCAN_STATUS") {
    requestState();
  }
});

loadTheme().then(requestState);
renderSourceSelection();
renderModelInfo();
