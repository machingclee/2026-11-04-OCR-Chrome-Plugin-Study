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
for (const deg of [-14, -12, -10, -8, -6, 0, 6, 10]) {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const vss = pts.map(p => -p.x * sin + p.y * cos);
  const uMin = Math.min(...us), uMax = Math.max(...us);
  const vMin = Math.min(...vss), vMax = Math.max(...vss);
  const width = 1.5;
  const bins = new Map();
  for (const u of us) { const key = Math.floor((u - uMin) / width); bins.set(key, (bins.get(key) ?? 0) + 1); }
  const n = Math.ceil((uMax - uMin) / width);
  const counts = Array.from({ length: n }, (_, i) => bins.get(i) ?? 0);
  console.log(`deg ${deg} u ${uMin.toFixed(0)}..${uMax.toFixed(0)} (${(uMax - uMin).toFixed(0)}) v ${(vMax - vMin).toFixed(0)}`);
  console.log('  ', counts.join(','));
}
