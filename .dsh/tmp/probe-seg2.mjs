import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const page = createCanvas(bitmap.width, bitmap.height);
page.getContext('2d').drawImage(bitmap, 0, 0);
const L = -10 * Math.PI / 180;
const cos = Math.cos(L), sin = Math.sin(L);
const x0 = 300, y0 = 565, x1 = 400, y1 = 745;
const w = x1 - x0, h = y1 - y0;
const data = page.getContext('2d').getImageData(x0, y0, w, h).data;
const lum = new Float64Array(w * h);
for (let i = 0; i < w * h; i += 1) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
const pts = [];
for (let y = 2; y < h - 2; y += 1) {
  for (let x = 2; x < w - 2; x += 1) {
    if (lum[y * w + x] < 200) continue;
    // a glyph edge is bright with a dark pixel within 3
    let dark = false;
    for (const [dx, dy] of [[-3,0],[3,0],[0,-3],[0,3],[-2,-2],[2,2],[2,-2],[-2,2]]) {
      const nx = x + dx, ny = y + dy;
      if (lum[ny * w + nx] < 110) { dark = true; break; }
    }
    if (dark) pts.push({ x: x0 + x, y: y0 + y });
  }
}
console.log('glyph points', pts.length);
const uOf = (p) => p.x * cos + p.y * sin;
const vOf = (p) => -p.x * sin + p.y * cos;
const us = pts.map(uOf);
const uMin = Math.floor(Math.min(...us)), uMax = Math.ceil(Math.max(...us));
const bins = new Uint32Array(uMax - uMin + 1);
for (const value of us) bins[Math.round(value - uMin)] += 1;
let line = '';
for (let i = 0; i < bins.length; i += 1) line += `${uMin + i}:${bins[i]} `;
console.log('u profile', line);
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
  if (prev && a - prev[1] <= 2) prev[1] = b; else merged.push([a, b]);
}
console.log('bands', merged.map(([a, b]) => `${a}..${b}(${b - a})`).join(' | '));
for (const [a, b] of merged) {
  if (b - a < 12) continue;
  const inside = pts.filter(p => uOf(p) >= a && uOf(p) <= b);
  if (inside.length < 40) continue;
  const vs = inside.map(vOf);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  const uc = (a + b) / 2, vc = (v0 + v1) / 2;
  const px = uc * cos - vc * sin, py = uc * sin + vc * cos;
  const thickness = b - a, length = v1 - v0;
  const box = { x: px - thickness / 2, y: py - length / 2, width: thickness, height: length, score: 1, angle: L, lineLength: length, lineThickness: thickness };
  const out = await recognizeLine(bitmap, box, true).catch(e => ({ error: e.message }));
  console.log('band', `${a}..${b}`, 'th', thickness, 'len', length.toFixed(0), 'centre', px.toFixed(0), py.toFixed(0), JSON.stringify(out));
  const up = createCanvas(Math.round(thickness), Math.round(length));
  drawUpright(up.getContext('2d'), bitmap, box, up.width, up.height);
  const c = createCanvas(up.width * 5, up.height * 5);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(up, 0, 0, c.width, c.height);
  writeFileSync(`.dsh/tmp/seg2-${a}.png`, c.toBuffer('image/png'));
}
