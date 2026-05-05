(function attachScanner(globalScope) {
  if (globalScope.__chromeTraderScanner?.stop) {
    try {
      globalScope.__chromeTraderScanner.stop();
    } catch (error) {
      // Ignore stale scanner teardown failures and replace it below.
    }
  }

  const STATE = {
    running: false,
    intervalId: null,
    startTimeoutId: null,
    lastFingerprint: "",
    lastResult: null,
    selectedSource: "gmgn",
    captureCount: 0,
    savedCount: 0
  };

  const TRAINING_CAPTURE_TARGET = 10;
  const STORAGE_KEY = "chartTraderSavedCaptures";
  const MAX_STORED_CAPTURES = 60;

  function isExtensionContextValid() {
    try {
      return Boolean(globalScope.chrome?.runtime?.id);
    } catch (error) {
      return false;
    }
  }

  function teardownInvalidContext() {
    STATE.running = false;
    if (STATE.startTimeoutId) {
      globalScope.clearTimeout(STATE.startTimeoutId);
      STATE.startTimeoutId = null;
    }
    if (STATE.intervalId) {
      globalScope.clearInterval(STATE.intervalId);
      STATE.intervalId = null;
    }
  }

  function safeSendMessage(message) {
    if (!isExtensionContextValid()) {
      teardownInvalidContext();
      return false;
    }

    try {
      chrome.runtime.sendMessage(message);
      return true;
    } catch (error) {
      teardownInvalidContext();
      return false;
    }
  }

  const SOURCE_PROFILES = {
    gmgn: {
      top: 0.14,
      bottom: 0.88,
      left: 0.06,
      right: 0.94,
      colorWeight: 1.05,
      scoreBoost: 1.14
    },
    axiom: {
      top: 0.16,
      bottom: 0.9,
      left: 0.08,
      right: 0.95,
      colorWeight: 0.9,
      scoreBoost: 1.12
    },
    terminal: {
      top: 0.1,
      bottom: 0.94,
      left: 0.04,
      right: 0.96,
      colorWeight: 0.55,
      scoreBoost: 1.05
    },
    phantom: {
      top: 0.18,
      bottom: 0.9,
      left: 0.1,
      right: 0.95,
      colorWeight: 1.0,
      scoreBoost: 1.15
    },
    tradingview: {
      top: 0.12,
      bottom: 0.9,
      left: 0.07,
      right: 0.93,
      colorWeight: 0.75,
      scoreBoost: 1.1
    }
  };

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  }

  function buildFingerprint(series) {
    return series.slice(-16).map((value) => value.toFixed(4)).join("|");
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
      const y = left.y + (right.y - left.y) * ratio;
      dense.push(y);
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

    function pixelOffset(x, y) {
      return (y * width + x) * 4;
    }

    function brightnessAt(x, y) {
      const offset = pixelOffset(x, y);
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      return (red + green + blue) / 765;
    }

    function colorfulnessAt(x, y) {
      const offset = pixelOffset(x, y);
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      return (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
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
    const filtered = points.filter((point) => point.score >= scoreFloor);
    return interpolateSparseSeries(filtered, right - left);
  }

  async function captureVisibleSeries(selectedSource) {
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" });
    if (!response?.ok || !response.dataUrl) {
      throw new Error(response?.error || "Unable to capture the visible tab.");
    }

    const image = new Image();
    image.src = response.dataUrl;
    await image.decode();

    const sampleWidth = 220;
    const sampleHeight = Math.max(140, Math.round((image.height / image.width) * sampleWidth));
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight);

    const series = extractSeriesFromImageData(
      context.getImageData(0, 0, sampleWidth, sampleHeight),
      selectedSource
    );

    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = 132;
    previewCanvas.height = 88;
    const previewContext = previewCanvas.getContext("2d");
    previewContext.drawImage(image, 0, 0, previewCanvas.width, previewCanvas.height);

    return {
      previewDataUrl: previewCanvas.toDataURL("image/jpeg", 0.72),
      series
    };
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (items) => resolve(items[key]));
    });
  }

  function storageSet(payload) {
    return new Promise((resolve) => {
      chrome.storage.local.set(payload, () => resolve());
    });
  }

  async function hydrateModelFromStorage() {
    const savedCaptures = (await storageGet(STORAGE_KEY)) || [];
    globalScope.ChartML.setUserExamples(savedCaptures);
    STATE.savedCount = savedCaptures.length;
    return savedCaptures;
  }

  async function saveTrainingCapture(capture) {
    const savedCaptures = (await storageGet(STORAGE_KEY)) || [];
    const nextCapture = {
      capturedAt: Date.now(),
      label: globalScope.ChartML.inferLabelFromSeries(capture.series),
      previewDataUrl: capture.previewDataUrl,
      selectedSource: STATE.selectedSource,
      series: capture.series,
      target: globalScope.ChartML.deriveRegressionTarget(capture.series),
      url: location.href
    };

    const nextList = savedCaptures.concat(nextCapture).slice(-MAX_STORED_CAPTURES);
    await storageSet({ [STORAGE_KEY]: nextList });
    globalScope.ChartML.addUserExample(nextCapture);
    STATE.savedCount = nextList.length;
    return nextList.length;
  }

  function publishResult(result, source, sampleCount) {
    STATE.lastResult = {
      ...result,
      source,
      selectedSource: STATE.selectedSource,
      captureCount: STATE.captureCount,
      savedCount: STATE.savedCount,
      sampleCount,
      url: location.href,
      timestamp: Date.now()
    };

    safeSendMessage({
      type: "SCAN_RESULT",
      payload: STATE.lastResult
    });
  }

  function reportScanError(error) {
    safeSendMessage({
      type: "SCAN_STATUS",
      payload: {
        state: "error",
        message: error?.message || "Scan failed."
      }
    });
  }

  function triggerScan(source) {
    if (!STATE.running) {
      return;
    }

    Promise.resolve(runScan(source)).catch((error) => {
      reportScanError(error);
    });
  }

  async function runScan(source = "screen-capture") {
    const capture = await captureVisibleSeries(STATE.selectedSource);
    const { previewDataUrl, series } = capture;
    if (series.length < 24) {
      safeSendMessage({
        type: "SCAN_STATUS",
        payload: {
          state: "error",
          message: `No ${STATE.selectedSource} chart-like path was found in the visible screen.`
        }
      });
      return;
    }

    const fingerprint = buildFingerprint(series);
    if (fingerprint === STATE.lastFingerprint) {
      return;
    }

    STATE.lastFingerprint = fingerprint;

    if (STATE.captureCount < TRAINING_CAPTURE_TARGET) {
      STATE.captureCount += 1;
      const savedCount = await saveTrainingCapture({
        previewDataUrl,
        series
      });

      if (STATE.captureCount >= TRAINING_CAPTURE_TARGET) {
        const result = globalScope.ChartML.analyzeSeries(series);
        publishResult(result, source, series.length);
        return;
      }

      chrome.runtime.sendMessage({
        type: "SCAN_STATUS",
        payload: {
          state: "training",
          message: `Saved photo ${STATE.captureCount}/${TRAINING_CAPTURE_TARGET} to the shared model`,
          captureCount: STATE.captureCount,
          savedCount
        }
      });
      return;
    }

    const result = globalScope.ChartML.analyzeSeries(series);
    publishResult(result, source, series.length);
  }

  function start() {
    try {
      if (STATE.running) {
        return { ok: true, running: true };
      }

      STATE.running = true;
      STATE.lastFingerprint = "";
      STATE.lastResult = null;
      STATE.captureCount = 0;
      STATE.savedCount = 0;
      hydrateModelFromStorage().catch(() => {});

      STATE.intervalId = globalScope.setInterval(() => {
        triggerScan("live-interval");
      }, 4000);

      safeSendMessage({
        type: "SCAN_STATUS",
        payload: {
          state: "training",
          message: `Collecting photo 0/${TRAINING_CAPTURE_TARGET} for the shared model`,
          captureCount: 0,
          savedCount: STATE.savedCount
        }
      });

      STATE.startTimeoutId = globalScope.setTimeout(() => {
        triggerScan("initial");
      }, 180);
      return { ok: true, running: true };
    } catch (error) {
      reportScanError(error);
      return {
        ok: false,
        running: false,
        error: error?.message || "Start failed."
      };
    }
  }

  function stop() {
    STATE.running = false;
    if (STATE.startTimeoutId) {
      globalScope.clearTimeout(STATE.startTimeoutId);
      STATE.startTimeoutId = null;
    }
    if (STATE.intervalId) {
      globalScope.clearInterval(STATE.intervalId);
      STATE.intervalId = null;
    }

    safeSendMessage({
      type: "SCAN_STATUS",
      payload: {
        state: "idle",
        message: "Scan stopped for this tab."
      }
    });

    return { ok: true, running: false };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "START_SCAN") {
      STATE.selectedSource = message.selectedSource || "gmgn";
      sendResponse(start());
      return true;
    }
    if (message?.type === "STOP_SCAN") {
      sendResponse(stop());
      return true;
    }
    if (message?.type === "GET_SCAN_STATE") {
      sendResponse({
        ok: true,
        running: STATE.running,
        result: STATE.lastResult
      });
      return true;
    }
    return false;
  });

  globalScope.__chromeTraderScanner = {
    hydrateModelFromStorage,
    start,
    stop
  };
})(globalThis);
