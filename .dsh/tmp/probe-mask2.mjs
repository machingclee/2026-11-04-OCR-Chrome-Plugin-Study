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
    pts.push({ x: (mx - mask.padX) / mask.scale, y: (my - mask.padY) / mask.scale, w: value });
  }
}
console.log('points', pts.length);
const score = (deg) => {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const bins = new Map();
  for (const p of pts) {
    const u = Math.round(p.x * cos + p.y * sin);
    bins.set(u, (bins.get(u) ?? 0) + 1);
  }
  let sum = 0;
  for (const v of bins.values()) sum += v * v;
  return sum;
};
const results = [];
for (let deg = -25; deg <= 25; deg += 1) results.push({ deg, score: score(deg) });
results.sort((a, b) => b.score - a.score);
console.log('best', results.slice(0, 8).map(r => `${r.deg}:${r.score}`).join(' '));
const L = results[0].deg * Math.PI / 180, cos = Math.cos(L), sin = Math.sin(L);
const us = pts.map(p => p.x * cos + p.y * sin);
const uMin = Math.floor(Math.min(...us)), uMax = Math.ceil(Math.max(...us));
const bins = new Uint32Array(uMax - uMin + 1);
for (const value of us) bins[Math.round(value - uMin)] += 1;
let line = '';
for (let i = 0; i < bins.length; i += 1) line += `${uMin + i}:${bins[i]} `;
console.log('profile', line);
const bands = [];
let start = null;
for (let i = 0; i < bins.length; i += 1) {
  if (bins[i] > 0) { if (start === null) start = i; }
  else if (start !== null) { bands.push([uMin + start, uMin + i]); start = null; }
}
if (start !== null) bands.push([uMin + start, uMax]);
let merged = [];
for (const [a, b] of bands) {
  const prev = merged[merged.length - 1];
  if (prev && a - prev[1] <= 3) prev[1] = b; else merged.push([a, b]);
}
console.log('bands', merged.map(([a, b]) => `${a}..${b}(${b - a})`).join(' | '));
