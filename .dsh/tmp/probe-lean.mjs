import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const bitmap = await loadImage('fixtures/page-forty.jpg');
const c = createCanvas(bitmap.width, bitmap.height);
c.getContext('2d').drawImage(bitmap, 0, 0);
const x0 = 305, y0 = 570, w = 100, h = 180;
const data = c.getContext('2d').getImageData(x0, y0, w, h).data;
const pts = [];
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const at = (y * w + x) * 4;
    const l = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    // white glyphs on a dark screen, but the bubble/paper is bright: keep only
    // pixels that are bright and have a dark neighbour (the glyph outline).
    if (l < 215) continue;
    let darkNear = false;
    for (const [dx, dy] of [[-2,0],[2,0],[0,-2],[0,2]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nAt = (ny * w + nx) * 4;
      const nl = 0.299 * data[nAt] + 0.587 * data[nAt + 1] + 0.114 * data[nAt + 2];
      if (nl < 120) { darkNear = true; break; }
    }
    if (darkNear) pts.push({ x: x0 + x, y: y0 + y });
  }
}
console.log('glyph edge points', pts.length);
const score = (deg) => {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const bins = new Map();
  for (const p of pts) {
    const u = Math.round(p.x * cos + p.y * sin);
    bins.set(u, (bins.get(u) ?? 0) + 1);
  }
  let sum = 0;
  for (const value of bins.values()) sum += value * value;
  return sum;
};
const results = [];
for (let deg = -25; deg <= 25; deg += 1) results.push({ deg, score: score(deg) });
results.sort((a, b) => b.score - a.score);
console.log('best angles', results.slice(0, 8).map(r => `${r.deg}:${r.score}`).join(' '));
console.log('worst', results.slice(-3).map(r => `${r.deg}:${r.score}`).join(' '));
