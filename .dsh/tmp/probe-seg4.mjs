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
const glyph = [];
for (let y = 3; y < h - 3; y += 1) {
  for (let x = 3; x < w - 3; x += 1) {
    const value = lum[y * w + x];
    if (value > 110) continue;
    const bright = (dx, dy) => lum[(y + dy) * w + (x + dx)] > 165;
    if (bright(-3, 0) && bright(3, 0) && bright(0, -3) && bright(0, 3)) glyph.push({ x: x0 + x, y: y0 + y });
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
const bands = [];
let start = null;
for (let i = 0; i < bins.length; i += 1) {
  if (bins[i] > 0) { if (start === null) start = i; }
  else if (start !== null) { bands.push([uMin + start, uMin + i]); start = null; }
}
if (start !== null) bands.push([uMin + start, uMax]);
console.log('bands', bands.map(([a, b]) => `${a}..${b}(${b - a})`).join(' | '));
// draw a preview: rotated crop with glyph points marked
const c = createCanvas(400, 700);
const ctx = c.getContext('2d');
ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 400, 700);
for (const p of glyph) {
  ctx.fillStyle = '#0f0';
  ctx.fillRect(Math.round(uOf(p) - uMin) * 3, Math.round((-p.x * sin + p.y * cos) - 560) * 3, 2, 2);
}
writeFileSync('.dsh/tmp/seg4-preview.png', c.toBuffer('image/png'));
