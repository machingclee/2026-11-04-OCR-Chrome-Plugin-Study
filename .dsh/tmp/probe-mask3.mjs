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
for (const binSize of [2, 3, 4]) {
  const score = (deg) => {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const bins = new Map();
    for (const p of pts) {
      const u = Math.round((p.x * cos + p.y * sin) / binSize);
      bins.set(u, (bins.get(u) ?? 0) + 1);
    }
    let sum = 0;
    for (const v of bins.values()) sum += v * v;
    return sum;
  };
  const results = [];
  for (let deg = -20; deg <= 20; deg += 1) results.push({ deg, score: score(deg) });
  results.sort((a, b) => b.score - a.score);
  console.log('bin', binSize, 'best', results.slice(0, 6).map(r => `${r.deg}:${r.score}`).join(' '));
}
