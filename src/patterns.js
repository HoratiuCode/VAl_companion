(function attachPatternLibrary(globalScope) {
  const PATTERN_NAMES = [
    "Head and Shoulders",
    "Inverse Head and Shoulders",
    "Double Top",
    "Double Bottom",
    "Ascending Triangle",
    "Descending Triangle",
    "Symmetrical Triangle",
    "Bull Flag",
    "Bear Flag",
    "Range Consolidation"
  ];

  const PATTERN_META = {
    "Head and Shoulders": {
      bias: "Bearish",
      summary: "A topping structure with weakening highs. A downside continuation is more likely if support gives way."
    },
    "Inverse Head and Shoulders": {
      bias: "Bullish",
      summary: "A basing structure with improving lows. An upside continuation is more likely if neckline resistance breaks."
    },
    "Double Top": {
      bias: "Bearish",
      summary: "Repeated failure near resistance suggests exhaustion. The next move often leans lower after support loss."
    },
    "Double Bottom": {
      bias: "Bullish",
      summary: "Repeated support defense suggests accumulation. The next move often leans higher after resistance breaks."
    },
    "Ascending Triangle": {
      bias: "Bullish",
      summary: "Flat resistance with rising lows often compresses into an upside breakout."
    },
    "Descending Triangle": {
      bias: "Bearish",
      summary: "Flat support with falling highs often compresses into a downside breakout."
    },
    "Symmetrical Triangle": {
      bias: "Watch Breakout",
      summary: "Price compression is tightening. The next move is often directional, but confirmation matters."
    },
    "Bull Flag": {
      bias: "Bullish",
      summary: "A strong impulse followed by mild pullback often resolves higher with trend continuation."
    },
    "Bear Flag": {
      bias: "Bearish",
      summary: "A strong selloff followed by mild rebound often resolves lower with trend continuation."
    },
    "Range Consolidation": {
      bias: "Sideways",
      summary: "The market is balanced inside a range. Expect chop until a convincing breakout appears."
    }
  };

  const TEMPLATE_LIBRARY = {
    "Head and Shoulders": [0.18, 0.48, 0.3, 0.82, 0.32, 0.52, 0.16],
    "Inverse Head and Shoulders": [0.82, 0.5, 0.7, 0.18, 0.68, 0.45, 0.84],
    "Double Top": [0.15, 0.62, 0.31, 0.65, 0.12],
    "Double Bottom": [0.86, 0.34, 0.67, 0.3, 0.88],
    "Ascending Triangle": [0.24, 0.3, 0.42, 0.47, 0.59, 0.61, 0.72, 0.74, 0.76],
    "Descending Triangle": [0.78, 0.72, 0.61, 0.57, 0.47, 0.42, 0.3, 0.29, 0.28],
    "Symmetrical Triangle": [0.2, 0.76, 0.31, 0.68, 0.4, 0.58, 0.47, 0.53],
    "Bull Flag": [0.18, 0.32, 0.47, 0.69, 0.84, 0.78, 0.72, 0.68, 0.75, 0.88],
    "Bear Flag": [0.82, 0.67, 0.52, 0.32, 0.18, 0.26, 0.3, 0.35, 0.27, 0.12],
    "Range Consolidation": [0.46, 0.54, 0.49, 0.53, 0.48, 0.52, 0.47, 0.51]
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function rand() {
      t += 0x6d2b79f5;
      let next = Math.imul(t ^ (t >>> 15), 1 | t);
      next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
      return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
    };
  }

  function resample(values, targetLength) {
    if (!Array.isArray(values) || values.length === 0) {
      return [];
    }

    if (values.length === targetLength) {
      return values.slice();
    }

    if (targetLength === 1) {
      return [values[0]];
    }

    const output = [];
    const scale = (values.length - 1) / (targetLength - 1);
    for (let index = 0; index < targetLength; index += 1) {
      const rawPosition = index * scale;
      const leftIndex = Math.floor(rawPosition);
      const rightIndex = Math.min(values.length - 1, Math.ceil(rawPosition));
      const weight = rawPosition - leftIndex;
      const interpolated = values[leftIndex] * (1 - weight) + values[rightIndex] * weight;
      output.push(interpolated);
    }
    return output;
  }

  function normalizeSeries(series) {
    const minimum = Math.min(...series);
    const maximum = Math.max(...series);
    const range = maximum - minimum || 1;
    return series.map((value) => (value - minimum) / range);
  }

  function countTurns(series) {
    let peaks = 0;
    let valleys = 0;
    for (let index = 1; index < series.length - 1; index += 1) {
      const prev = series[index - 1];
      const current = series[index];
      const next = series[index + 1];
      if (current > prev && current > next) {
        peaks += 1;
      }
      if (current < prev && current < next) {
        valleys += 1;
      }
    }
    return { peaks, valleys };
  }

  function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  }

  function stdev(values) {
    const avg = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
  }

  function extractFeatures(series) {
    const normalized = normalizeSeries(resample(series, 32));
    const diffs = normalized.slice(1).map((value, index) => value - normalized[index]);
    const half = Math.floor(normalized.length / 2);
    const firstHalf = normalized.slice(0, half);
    const secondHalf = normalized.slice(half);
    const turns = countTurns(normalized);
    const topQuartile = normalized.filter((value) => value > 0.75);
    const bottomQuartile = normalized.filter((value) => value < 0.25);

    return [
      normalized[normalized.length - 1] - normalized[0],
      mean(diffs),
      stdev(diffs),
      mean(firstHalf),
      mean(secondHalf),
      Math.max(...normalized) - Math.min(...normalized),
      turns.peaks,
      turns.valleys,
      topQuartile.length / normalized.length,
      bottomQuartile.length / normalized.length,
      Math.abs(normalized[0] - normalized[normalized.length - 1]),
      stdev(firstHalf) - stdev(secondHalf),
      mean(normalized.slice(-5)),
      mean(normalized.slice(0, 5))
    ];
  }

  function generateSyntheticSeries(label, sampleCount = 80, size = 48) {
    const template = TEMPLATE_LIBRARY[label];
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const random = mulberry32(index * 101 + label.length * 17);
      const base = resample(template, size);
      const noisy = base.map((value, candleIndex) => {
        const edgeBoost = candleIndex > size * 0.75 ? 1.15 : 1;
        const noise = (random() - 0.5) * 0.12 * edgeBoost;
        const drift = (random() - 0.5) * 0.03;
        return clamp(value + noise + drift, 0, 1);
      });
      samples.push(noisy);
    }
    return samples;
  }

  globalScope.ChartPatternLib = {
    PATTERN_NAMES,
    PATTERN_META,
    extractFeatures,
    generateSyntheticSeries
  };
})(globalThis);
