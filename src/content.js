// Legacy shim kept only to neutralize stale Chrome references to src/content.js.
// The active scanner is injected from src/scanner_v3.js.
(function legacyContentShim() {
  if (!globalThis.__chromeTraderLegacyShim) {
    globalThis.__chromeTraderLegacyShim = true;
  }
})();
