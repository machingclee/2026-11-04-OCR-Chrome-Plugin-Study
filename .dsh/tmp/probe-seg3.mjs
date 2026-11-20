import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const page = createCanvas(bitmap.width, bitmap.height);
page.getContext('2d').drawImage(bitmap, 0, 0);
const x0 = 300, y0 = 565, x1 = 400, y1 = 745;
const w = x1 - x0, h = y1 - y0;
const data = page.getContext('2d').getImageData(x0, y0, w, h).data;
const lum = new Float64Array(w * h);
for (let i = 0; i < w * h; i += 1) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
const glow = new Uint8Array(w * h);
for (let i = 0; i < w * h; i += 1) glow[i] = lum[i] > 175 ? 1 : 0;
const glyph = [];
for (let y = 2; y < h - 2; y += 1) {
  for (let x = 2; x < w - 2; x += 1) {
    if (lum[y * w + x] > 120) continue;
    let bright = 0;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) bright += glow[(y + dy) * w + (x + dx)];
    if (bright >= 10) glyph.push({ x: x0 + x, y: y0 + y });
  }
}
console.log('glyph points', glyph.length);
const L = -10 * Math.PI / 180;
const cos = Math.cos(L), sin = Math.sin(L);
const uOf = (p) => p.x * cos + p.y * sin;
const us = glyph.map(uOf);
const uMin = Math.floor(Math.min(...us)), uMax = Math.ceil(Math.max(...us));
const bins = new Uint32Array(uMax - uMin + 1);
for (const value of us) bins[Math.round(value - uMin)] += 1;
let line = '';
for (let i = 0; i < bins.length; i += 1) line += `${uMin + i}:${bins[i]} `;
console.log('u profile', line);
