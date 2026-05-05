# ChromeTrader

ChromeTrader is a Manifest V3 Chrome extension that scans the active trading chart only when the user starts it from the popup.

## What it does

- Injects the scanner into the active tab only after you click `Start scan`.
- Watches the active chart tab for visible price-like values from SVG labels, legends, and similar DOM sources.
- Extracts time-series features and runs a lightweight browser-side random-forest classifier.
- Scores 10 chart patterns:
  - Head and Shoulders
  - Inverse Head and Shoulders
  - Double Top
  - Double Bottom
  - Ascending Triangle
  - Descending Triangle
  - Symmetrical Triangle
  - Bull Flag
  - Bear Flag
  - Range Consolidation
- Suggests the likely next move as bullish, bearish, sideways, or breakout watch.

## Important limitation

This version uses DOM-visible chart numbers and labels. It works best on chart pages that expose text or SVG elements. If a platform renders everything inside a sealed canvas with no readable DOM values, the extension can miss the chart or produce weak signals.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder: `/Users/horatiubudai/ceo/Hacker/Val_companion`

## Use

1. Open a trading/chart tab.
2. Open the ChromeTrader popup.
3. Click `Start scan`.
4. Keep the chart visible while the extension watches for updates.
5. Click `Stop scan` when you want it off.

## Files

- `manifest.json`: Chrome extension configuration
- `popup.html` and `popup.css`: popup UI
- `src/background.js`: per-tab scan control and state
- `src/content.js`: on-demand live chart scanner
- `src/patterns.js`: pattern definitions and feature extraction
- `src/model.js`: lightweight random-forest model
