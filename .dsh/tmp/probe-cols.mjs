import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const box = detected.detBoxes.find(b => b.x > 300 && b.x < 330 && b.y > 570 && b.y < 600);
const region = { x: box.x, y: box.y, width: box.width, height: box.height, text: 'x', direction: 'v', columns: 1, rows: 1, kind: 'chat' };
applyInclination([region], [box], detected.mask);
const L = region.angle, cos = Math.cos(L), sin = Math.sin(L);
const mask = detected.mask;
const x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height;
const pts = [];
for (let py = Math.floor(y0); py <= Math.ceil(y1); py += 1) {
  for (let px = Math.floor(x0); px <= Math.ceil(x1); px += 1) {
    const mx = Math.round(px * mask.scale + mask.padX);
    const my = Math.round(py * mask.scale + mask.padY);
    if (mx < 0 || my < 0) continue;
    const value = mask.data[my * 640 + mx];
    if (value > 0.35) pts.push({ x: px, y: py });
  }
}
console.log('ink points', pts.length);
const u = (p) => p.x * cos + p.y * sin;
const v = (p) => -p.x * sin + p.y * cos;
const us = pts.map(u);
const uMin = Math.min(...us), uMax = Math.max(...us);
console.log('u range', uMin, uMax, 'span', uMax - uMin);
const bins = new Uint32Array(Math.ceil(uMax - uMin) + 2);
for (const value of us) bins[Math.round(value - uMin)] += 1;
const profile = Array.from(bins).map((count, index) => `${(uMin + index).toFixed(0)}:${count}`).join(' ');
console.log('profile', profile);
// gaps: runs of zero >= 2px
let start = null;
const bands = [];
for (let i = 0; i < bins.length; i += 1) {
  if (bins[i] > 0) { if (start === null) start = i; }
  else if (start !== null) { bands.push([start, i]); start = null; }
}
if (start !== null) bands.push([start, bins.length]);
console.log('raw bands', bands.map(([a, b]) => `${(uMin + a).toFixed(1)}..${(uMin + b).toFixed(1)} (${b - a})`).join(' | '));
const merged = [];
for (const [a, b] of bands) {
  const prev = merged[merged.length - 1];
  if (prev && a - prev[1] < 3) prev[1] = b; else merged.push([a, b]);
}
console.log('merged bands', merged.map(([a, b]) => `${(uMin + a).toFixed(1)}..${(uMin + b).toFixed(1)} (${b - a})`).join(' | '));

for (const [a, b] of merged) {
  if (b - a < 8) continue;
  const inBand = pts.filter(p => u(p) >= uMin + a && u(p) <= uMin + b);
  if (inBand.length < 50) continue;
  const vs = inBand.map(v);
  const u0 = uMin + a, u1 = uMin + b;
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const cx = uc * cos - vc * sin, cy = uc * sin + vc * cos;
  const thickness = u1 - u0, length = v1 - v0;
  const line = { x: cx - thickness / 2, y: cy - length / 2, width: thickness, height: length, score: 1, angle: L, lineLength: length, lineThickness: thickness };
  const out = await recognizeLine(bitmap, line, true).catch(e => ({ error: e.message }));
  console.log('column', `${u0.toFixed(0)}..${u1.toFixed(0)}`, `th=${thickness.toFixed(1)} len=${length.toFixed(1)}`, JSON.stringify(out));
  // save upright crop
  const c = createCanvas(Math.round(thickness) * 5, Math.round(length) * 5);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const up = createCanvas(Math.round(thickness), Math.round(length));
  drawUpright(up.getContext('2d'), bitmap, line, up.width, up.height);
  ctx.drawImage(up, 0, 0, c.width, c.height);
  writeFileSync(`.dsh/tmp/col-${u0.toFixed(0)}.png`, c.toBuffer('image/png'));
}
