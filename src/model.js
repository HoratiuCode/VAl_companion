(function attachRandomForest(globalScope) {
  const { PATTERN_NAMES, extractFeatures, generateSyntheticSeries, PATTERN_META } = globalScope.ChartPatternLib;
  const USER_EXAMPLE_LIMIT = 60;

  function giniImpurity(rows) {
    const labelCounts = new Map();
    rows.forEach((row) => {
      labelCounts.set(row.label, (labelCounts.get(row.label) || 0) + 1);
    });

    let impurity = 1;
    const total = rows.length || 1;
    labelCounts.forEach((count) => {
      const probability = count / total;
      impurity -= probability * probability;
    });
    return impurity;
  }

  function majorityLabel(rows) {
    const counts = new Map();
    rows.forEach((row) => {
      counts.set(row.label, (counts.get(row.label) || 0) + 1);
    });

    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  }

  function shuffle(values, random) {
    const copy = values.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
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

  function buildTree(rows, depth, maxDepth, minLeafSize, featureSampleSize, random) {
    const prediction = majorityLabel(rows);
    if (depth >= maxDepth || rows.length <= minLeafSize || giniImpurity(rows) < 0.01) {
      return { prediction };
    }

    const featureCount = rows[0].features.length;
    const featureIndexes = shuffle(
      Array.from({ length: featureCount }, (_, index) => index),
      random
    ).slice(0, featureSampleSize);

    let bestSplit = null;

    featureIndexes.forEach((featureIndex) => {
      const thresholds = rows.map((row) => row.features[featureIndex]);
      thresholds.forEach((threshold) => {
        const left = rows.filter((row) => row.features[featureIndex] <= threshold);
        const right = rows.filter((row) => row.features[featureIndex] > threshold);
        if (left.length === 0 || right.length === 0) {
          return;
        }

        const score =
          (left.length / rows.length) * giniImpurity(left) +
          (right.length / rows.length) * giniImpurity(right);

        if (!bestSplit || score < bestSplit.score) {
          bestSplit = { featureIndex, threshold, left, right, score };
        }
      });
    });

    if (!bestSplit) {
      return { prediction };
    }

    return {
      featureIndex: bestSplit.featureIndex,
      threshold: bestSplit.threshold,
      prediction,
      left: buildTree(bestSplit.left, depth + 1, maxDepth, minLeafSize, featureSampleSize, random),
      right: buildTree(bestSplit.right, depth + 1, maxDepth, minLeafSize, featureSampleSize, random)
    };
  }

  function classifyTree(node, features) {
    if (!node.left || !node.right) {
      return node.prediction;
    }
    if (features[node.featureIndex] <= node.threshold) {
      return classifyTree(node.left, features);
    }
    return classifyTree(node.right, features);
  }

  function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  }

  function variance(values) {
    const avg = mean(values);
    return mean(values.map((value) => (value - avg) ** 2));
  }

  class RandomForestClassifier {
    constructor(options = {}) {
      this.treeCount = options.treeCount || 25;
      this.maxDepth = options.maxDepth || 6;
      this.minLeafSize = options.minLeafSize || 5;
      this.featureSampleSize = options.featureSampleSize || 4;
      this.trees = [];
    }

    fit(rows) {
      this.trees = [];
      for (let treeIndex = 0; treeIndex < this.treeCount; treeIndex += 1) {
        const random = mulberry32(treeIndex * 991 + 17);
        const sample = [];
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          sample.push(rows[Math.floor(random() * rows.length)]);
        }

        this.trees.push(
          buildTree(sample, 0, this.maxDepth, this.minLeafSize, this.featureSampleSize, random)
        );
      }
      return this;
    }

    predictProba(features) {
      const votes = new Map(PATTERN_NAMES.map((name) => [name, 0]));
      this.trees.forEach((tree) => {
        const label = classifyTree(tree, features);
        votes.set(label, (votes.get(label) || 0) + 1);
      });

      const total = this.trees.length || 1;
      return PATTERN_NAMES.map((label) => ({
        label,
        probability: (votes.get(label) || 0) / total
      })).sort((left, right) => right.probability - left.probability);
    }
  }

  function buildRegressionTree(rows, depth, maxDepth, minLeafSize, featureSampleSize, random) {
    const prediction = mean(rows.map((row) => row.target));
    if (depth >= maxDepth || rows.length <= minLeafSize || variance(rows.map((row) => row.target)) < 0.0005) {
      return { prediction };
    }

    const featureCount = rows[0].features.length;
    const featureIndexes = shuffle(
      Array.from({ length: featureCount }, (_, index) => index),
      random
    ).slice(0, featureSampleSize);

    let bestSplit = null;

    featureIndexes.forEach((featureIndex) => {
      const thresholds = rows.map((row) => row.features[featureIndex]);
      thresholds.forEach((threshold) => {
        const left = rows.filter((row) => row.features[featureIndex] <= threshold);
        const right = rows.filter((row) => row.features[featureIndex] > threshold);
        if (left.length === 0 || right.length === 0) {
          return;
        }

        const score =
          (left.length / rows.length) * variance(left.map((row) => row.target)) +
          (right.length / rows.length) * variance(right.map((row) => row.target));

        if (!bestSplit || score < bestSplit.score) {
          bestSplit = { featureIndex, threshold, left, right, score };
        }
      });
    });

    if (!bestSplit) {
      return { prediction };
    }

    return {
      featureIndex: bestSplit.featureIndex,
      threshold: bestSplit.threshold,
      prediction,
      left: buildRegressionTree(bestSplit.left, depth + 1, maxDepth, minLeafSize, featureSampleSize, random),
      right: buildRegressionTree(bestSplit.right, depth + 1, maxDepth, minLeafSize, featureSampleSize, random)
    };
  }

  function regressTree(node, features) {
    if (!node.left || !node.right) {
      return node.prediction;
    }
    if (features[node.featureIndex] <= node.threshold) {
      return regressTree(node.left, features);
    }
    return regressTree(node.right, features);
  }

  class RandomForestRegressor {
    constructor(options = {}) {
      this.treeCount = options.treeCount || 21;
      this.maxDepth = options.maxDepth || 5;
      this.minLeafSize = options.minLeafSize || 4;
      this.featureSampleSize = options.featureSampleSize || 4;
      this.trees = [];
    }

    fit(rows) {
      this.trees = [];
      if (!rows.length) {
        return this;
      }

      for (let treeIndex = 0; treeIndex < this.treeCount; treeIndex += 1) {
        const random = mulberry32(treeIndex * 613 + 23);
        const sample = [];
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          sample.push(rows[Math.floor(random() * rows.length)]);
        }

        this.trees.push(
          buildRegressionTree(sample, 0, this.maxDepth, this.minLeafSize, this.featureSampleSize, random)
        );
      }
      return this;
    }

    predict(features) {
      if (!this.trees.length) {
        return 0;
      }
      return mean(this.trees.map((tree) => regressTree(tree, features)));
    }
  }

  function inferLabelFromSeries(series) {
    const features = extractFeatures(series);
    const slope = features[0];
    const topDensity = features[8];
    const bottomDensity = features[9];
    const volatility = features[2];

    if (slope > 0.34 && volatility < 0.11) {
      return "Bull Flag";
    }
    if (slope < -0.34 && volatility < 0.11) {
      return "Bear Flag";
    }
    if (slope > 0.16 && topDensity > bottomDensity) {
      return "Ascending Triangle";
    }
    if (slope < -0.16 && bottomDensity > topDensity) {
      return "Descending Triangle";
    }
    if (Math.abs(slope) < 0.08 && volatility < 0.08) {
      return "Range Consolidation";
    }
    return slope >= 0 ? "Double Bottom" : "Double Top";
  }

  function deriveRegressionTarget(series) {
    const start = series[0] || 0;
    const end = series[series.length - 1] || 0;
    const range = Math.max(...series) - Math.min(...series) || 1;
    return Math.max(-1, Math.min(1, (end - start) / range));
  }

  function buildSyntheticTrainingSet() {
    const rows = [];
    PATTERN_NAMES.forEach((label) => {
      const seriesSamples = generateSyntheticSeries(label);
      seriesSamples.forEach((series) => {
        rows.push({
          label,
          features: extractFeatures(series)
        });
      });
    });
    return rows;
  }

  function buildRegressionTrainingSet() {
    const rows = [];
    PATTERN_NAMES.forEach((label) => {
      const seriesSamples = generateSyntheticSeries(label);
      seriesSamples.forEach((series) => {
        rows.push({
          target: deriveRegressionTarget(series),
          features: extractFeatures(series)
        });
      });
    });
    return rows;
  }

  const BASE_CLASSIFICATION_ROWS = buildSyntheticTrainingSet();
  const BASE_REGRESSION_ROWS = buildRegressionTrainingSet();
  const MODEL = new RandomForestClassifier().fit(BASE_CLASSIFICATION_ROWS);
  const REGRESSOR = new RandomForestRegressor().fit(BASE_REGRESSION_ROWS);
  let userExamples = [];

  function retrainModels() {
    const recentExamples = userExamples.slice(-USER_EXAMPLE_LIMIT);
    const classificationRows = BASE_CLASSIFICATION_ROWS.concat(
      recentExamples.map((example) => ({
        label: example.label,
        features: extractFeatures(example.series)
      }))
    );
    const regressionRows = BASE_REGRESSION_ROWS.concat(
      recentExamples.map((example) => ({
        target: example.target,
        features: extractFeatures(example.series)
      }))
    );

    MODEL.fit(classificationRows);
    REGRESSOR.fit(regressionRows);
  }

  function setUserExamples(examples = []) {
    userExamples = examples
      .filter((example) => Array.isArray(example.series) && example.series.length >= 24)
      .map((example) => ({
        series: example.series,
        label: example.label || inferLabelFromSeries(example.series),
        target:
          typeof example.target === "number" ? example.target : deriveRegressionTarget(example.series)
      }))
      .slice(-USER_EXAMPLE_LIMIT);

    retrainModels();
    return userExamples.length;
  }

  function addUserExample(example) {
    if (!example || !Array.isArray(example.series) || example.series.length < 24) {
      return userExamples.length;
    }

    userExamples = userExamples
      .concat({
        series: example.series,
        label: example.label || inferLabelFromSeries(example.series),
        target:
          typeof example.target === "number" ? example.target : deriveRegressionTarget(example.series)
      })
      .slice(-USER_EXAMPLE_LIMIT);

    retrainModels();
    return userExamples.length;
  }

  function summarizePrediction(scores, sampleCount) {
    const best = scores[0];
    const meta = PATTERN_META[best.label];
    let nextMove = meta.summary;

    if (meta.bias === "Bullish") {
      nextMove += " Momentum favors higher prices if current support holds.";
    } else if (meta.bias === "Bearish") {
      nextMove += " Momentum favors lower prices if sellers keep control.";
    } else if (meta.bias === "Sideways") {
      nextMove += " A breakout confirmation is needed before taking directional conviction seriously.";
    } else {
      nextMove += " Wait for breakout confirmation before treating the setup as directional.";
    }

    if (sampleCount < 24) {
      nextMove += " Confidence is capped because the extracted sample is short.";
    }

    return {
      pattern: best.label,
      bias: meta.bias,
      confidence: Math.round(best.probability * 100),
      scores,
      forecast: nextMove
    };
  }

  function summarizeRegression(predictedMove) {
    if (predictedMove > 0.22) {
      return {
        direction: "Up",
        strength: "Strong"
      };
    }
    if (predictedMove > 0.08) {
      return {
        direction: "Up",
        strength: "Moderate"
      };
    }
    if (predictedMove < -0.22) {
      return {
        direction: "Down",
        strength: "Strong"
      };
    }
    if (predictedMove < -0.08) {
      return {
        direction: "Down",
        strength: "Moderate"
      };
    }
    return {
      direction: "Flat",
      strength: "Weak"
    };
  }

  function analyzeSeries(series) {
    const features = extractFeatures(series);
    const scores = MODEL.predictProba(features);
    const predictedMove = REGRESSOR.predict(features);
    const regression = summarizeRegression(predictedMove);
    return {
      ...summarizePrediction(scores, series.length),
      regression,
      predictedMove
    };
  }

  globalScope.ChartML = {
    addUserExample,
    analyzeSeries,
    deriveRegressionTarget,
    inferLabelFromSeries,
    setUserExamples
  };
})(globalThis);
