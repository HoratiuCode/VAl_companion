const tabState = new Map();

const SOURCE_MATCHERS = {
  gmgn: ["gmgn", "gmgn.ai"],
  axiom: ["axiom"],
  terminal: ["terminal", "padre", "pumpfun", "pump.fun", "photon"],
  phantom: ["phantom"],
  tradingview: ["tradingview"]
};

function getTabText(tab) {
  return `${tab?.url || ""} ${tab?.title || ""}`.toLowerCase();
}

function isCapturableTab(tab) {
  const url = tab?.url || "";
  if (!url) {
    return false;
  }

  return /^(https?:|file:)/i.test(url);
}

function tabMatchesSource(tab, selectedSource) {
  const haystack = getTabText(tab);
  const needles = SOURCE_MATCHERS[selectedSource] || [];
  return needles.some((needle) => haystack.includes(needle));
}

function detectSourceFromTab(tab) {
  const haystack = getTabText(tab);
  for (const [source, needles] of Object.entries(SOURCE_MATCHERS)) {
    if (needles.some((needle) => haystack.includes(needle))) {
      return source;
    }
  }
  return null;
}

function resolveSourceForTab(tab, requestedSource, fallbackSource = "gmgn") {
  return detectSourceFromTab(tab) || requestedSource || fallbackSource;
}

function buildPassiveState(tab, selectedSource, previousState = {}) {
  const matched = tabMatchesSource(tab, selectedSource);
  const detectedSource = detectSourceFromTab(tab);
  return {
    running: false,
    status: matched ? "ready" : "not_ready",
    message: matched
      ? `Ready to scan ${selectedSource}`
      : `Open a ${selectedSource} chart tab to scan`,
    result: previousState.result || null,
    captureCount: previousState.captureCount || 0,
    savedCount: previousState.savedCount || 0,
    mode: previousState.mode || "scan",
    detectedSource,
    selectedSource,
    tabUrl: tab?.url
  };
}

function setTabState(tabId, patch) {
  const next = {
    ...(tabState.get(tabId) || {
      running: false,
      status: "ready",
      message: "Ready to scan",
      result: null,
      captureCount: 0,
      savedCount: 0,
      mode: "scan",
      detectedSource: null,
      selectedSource: "gmgn"
    }),
    ...patch
  };
  tabState.set(tabId, next);
  return next;
}

async function startScannerForTab(tab, requestedSource = null, mode = "scan") {
  if (!tab?.id) {
    throw new Error("No tab available.");
  }

  const selectedSource = resolveSourceForTab(tab, requestedSource || "gmgn", "gmgn");
  setTabState(tab.id, {
    running: true,
    status: "starting",
    message: mode === "trading" ? "Starting trading mode..." : "Starting scan...",
    tabUrl: tab.url,
    detectedSource: detectSourceFromTab(tab),
    mode,
    selectedSource
  });

  if (!(await isScannerReady(tab.id))) {
    await ensureScannerInjected(tab.id);
    await waitForScannerReady(tab.id);
  }
  const response = await sendTabMessage(tab.id, {
    type: "START_SCAN",
    selectedSource,
    mode
  });

  const state = setTabState(tab.id, {
    running: true,
    status: "running",
    message:
      mode === "trading"
        ? `Live trading on ${selectedSource} is active.`
        : `Live ${selectedSource} scan is active.`,
    tabUrl: tab.url,
    detectedSource: detectSourceFromTab(tab),
    mode,
    selectedSource
  });

  return { response, state };
}

async function reattachScannerForTab(tabId) {
  const currentState = tabState.get(tabId);
  if (!currentState?.running) {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    tabState.delete(tabId);
    return;
  }

  if (!isCapturableTab(tab)) {
    setTabState(tabId, {
      running: false,
      status: "not_ready",
      message: "Open a normal web chart tab to continue scanning.",
      detectedSource: detectSourceFromTab(tab),
      tabUrl: tab?.url
    });
    return;
  }

  if (await isScannerReady(tabId)) {
    setTabState(tabId, {
      tabUrl: tab?.url,
      detectedSource: detectSourceFromTab(tab)
    });
    return;
  }

  try {
    await startScannerForTab(tab, currentState.selectedSource, currentState.mode || "scan");
  } catch (error) {
    setTabState(tabId, {
      running: false,
      status: "error",
      message: error?.message || "Could not continue scanning on this page.",
      detectedSource: detectSourceFromTab(tab),
      tabUrl: tab?.url
    });
  }
}

async function withActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab available.");
  }
  return tab;
}

async function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function ensureScannerInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/patterns.js", "src/model.js", "src/scanner_v3.js"]
  });
}

async function isScannerReady(tabId) {
  try {
    const response = await sendTabMessage(tabId, { type: "PING_SCANNER" });
    return Boolean(response?.ok);
  } catch (error) {
    return false;
  }
}

async function waitForScannerReady(tabId, attempts = 6, delayMs = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await sendTabMessage(tabId, { type: "PING_SCANNER" });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      // Ignore and retry while the injected script finishes registering listeners.
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Scanner did not initialize in the active tab.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAPTURE_VISIBLE_TAB") {
    Promise.resolve()
      .then(async () => {
        const captureTab = sender.tab || (await withActiveTab());
        if (!captureTab?.windowId) {
          throw new Error("No visible browser tab available for capture.");
        }
        if (!isCapturableTab(captureTab)) {
          throw new Error(
            "This target cannot be captured. Use a normal web tab in Chrome, not a browser internal page or desktop app."
          );
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(captureTab.windowId, {
          format: "png"
        });

        sendResponse({
          ok: true,
          dataUrl,
          tabId: captureTab.id,
          tabUrl: captureTab.url
        });
      })
      .catch((error) => {
        const messageText =
          error?.message === "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
            ? "Chrome blocked capture for this page. Open the chart in a normal web tab and keep it as the active visible tab."
            : error.message;

        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  if (message?.type === "POPUP_GET_STATE") {
    withActiveTab()
      .then((tab) => {
        const requestedSource = message.selectedSource || null;
        const currentState = tabState.get(tab.id) || {
          running: false,
          status: "not_ready",
          message: "Open a chart tab to scan",
          result: null,
          captureCount: 0,
          savedCount: 0,
          mode: "scan",
          detectedSource: null,
          selectedSource: "gmgn"
        };

        const detectedSource = detectSourceFromTab(tab);
        const sourceToUse = requestedSource || detectedSource || currentState.selectedSource;
        const state = currentState.running && currentState.selectedSource === sourceToUse
          ? currentState
          : buildPassiveState(tab, sourceToUse, currentState);

        tabState.set(tab.id, state);
        sendResponse({ ok: true, state });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "POPUP_START_SCAN") {
    withActiveTab()
      .then(async (tab) => {
        const { response, state } = await startScannerForTab(
          tab,
          message.selectedSource,
          message.mode || "scan"
        );
        sendResponse({ ok: true, response, state });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "POPUP_STOP_SCAN") {
    withActiveTab()
      .then(async (tab) => {
        const currentState = tabState.get(tab.id) || { selectedSource: "gmgn" };
        let response = { ok: true, running: false };
        try {
          response = await sendTabMessage(tab.id, { type: "STOP_SCAN" });
        } catch (error) {
          response = { ok: false, error: error.message };
        }
        const state = buildPassiveState(tab, currentState.selectedSource, currentState);
        tabState.set(tab.id, state);
        sendResponse({ ok: true, response, state });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "SCAN_RESULT" && sender.tab?.id) {
    setTabState(sender.tab.id, {
      running: true,
      status: "live",
      message:
        message.payload?.mode === "trading"
          ? `Fast trading data is updating on ${message.payload?.selectedSource || "chart"}.`
          : `Live ${message.payload?.selectedSource || "chart"} data is updating.`,
      result: message.payload,
      captureCount: message.payload?.captureCount || 10,
      savedCount: message.payload?.savedCount ?? 0,
      mode: message.payload?.mode || "scan",
      detectedSource: detectSourceFromTab(sender.tab),
      tabUrl: sender.tab.url
    });
  }

  if (message?.type === "SCAN_STATUS" && sender.tab?.id) {
    setTabState(sender.tab.id, {
      running:
        message.payload?.state === "running" ||
        message.payload?.state === "training" ||
        message.payload?.state === "live",
      status: message.payload?.state || "ready",
      message: message.payload?.message || "Ready to scan",
      captureCount: message.payload?.captureCount ?? 0,
      savedCount: message.payload?.savedCount ?? 0,
      mode: message.payload?.mode || "scan",
      detectedSource: detectSourceFromTab(sender.tab),
      tabUrl: sender.tab.url
    });
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    reattachScannerForTab(tabId).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  reattachScannerForTab(tabId).catch(() => {});
});
