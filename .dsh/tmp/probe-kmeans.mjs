import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const mask = detected.mask;
const box = { x: 312, y: 582, width: 78, height: 155 };
const pts = [];
for (let my = Math.floor(box.y * mask.scale + mask.padY); my <= Math.ceil((box.y + box.height) * mask.scale + mask.padY); my += 1) {
  for (let mx = Math.floor(box.x * mask.scale + mask.padX); mx <= Math.ceil((box.x + box.width) * mask.scale + mask.padX); mx += 1) {
    const value = mask.data[my * MODEL_SIZE + mx];
    if (value < 0.25) continue;
    pts.push({ x: (mx - mask.padX) / mask.scale, y: (my - mask.padY) / mask.scale });
  }
}
function kmeans1d(values, k, iterations = 30) {
  const sorted = [...values].sort((a, b) => a - b);
  const centres = Array.from({ length: k }, (_, i) => sorted[Math.floor((i + 0.5) * sorted.length / k)]);
  let assign = new Array(values.length).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    assign = values.map(v => {
      let best = 0, bestD = Infinity;
      centres.forEach((c, i) => { const d = Math.abs(v - c); if (d < bestD) { bestD = d; best = i; } });
      return best;
    });
    for (let i = 0; i < k; i += 1) {
      const own = values.filter((_, index) => assign[index] === i);
      if (own.length > 0) centres[i] = own.reduce((a, b) => a + b, 0) / own.length;
    }
  }
  let total = 0;
  values.forEach((v, index) => { total += (v - centres[assign[index]]) ** 2; });
  const counts = Array.from({ length: k }, (_, i) => assign.filter(a => a === i).length);
  return { total, counts };
}
for (const k of [2, 3, 4]) {
  const results = [];
  for (let deg = -20; deg <= 20; deg += 1) {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const us = pts.map(p => p.x * cos + p.y * sin);
    const { total, counts } = kmeans1d(us, k);
    results.push({ deg, total: total / us.length, counts });
  }
  results.sort((a, b) => a.total - b.total);
  console.log('k', k, 'best', results.slice(0, 6).map(r => `${r.deg}:${r.total.toFixed(1)}[${r.counts}]`).join(' '));
}
