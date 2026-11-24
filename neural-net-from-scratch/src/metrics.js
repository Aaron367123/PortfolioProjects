// metrics.js — classification bookkeeping.

/** k×k confusion matrix, rows = true class, columns = predicted class. */
export function confusionMatrix(labels, preds, k = 10) {
  const cm = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < labels.length; i++) cm[labels[i]][preds[i]]++;
  return cm;
}

/** Recall per class: diagonal / row sum. */
export function perClassAccuracy(cm) {
  return cm.map((row, c) => {
    const total = row.reduce((a, b) => a + b, 0);
    return total ? row[c] / total : 0;
  });
}

/** Overall accuracy from a confusion matrix. */
export function accuracyFromConfusion(cm) {
  let correct = 0, total = 0;
  cm.forEach((row, c) => { correct += row[c]; total += row.reduce((a, b) => a + b, 0); });
  return total ? correct / total : 0;
}

/** The most frequent off-diagonal (true → predicted) confusions. */
export function topConfusions(cm, count = 5) {
  const out = [];
  cm.forEach((row, t) => row.forEach((v, p) => { if (t !== p && v > 0) out.push({ true: t, pred: p, count: v }); }));
  return out.sort((a, b) => b.count - a.count).slice(0, count);
}
