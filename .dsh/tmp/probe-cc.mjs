import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const page = createCanvas(bitmap.width, bitmap.height);
page.getContext('2d').drawImage(bitmap, 0, 0);
const x0 = 300, y0 = 560, x1 = 400, y1 = 750;
const w = x1 - x0, h = y1 - y0;
const data = page.getContext('2d').getImageData(x0, y0, w, h).data;
const lum = new Float64Array(w * h);
for (let i = 0; i < w * h; i += 1) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
const dark = new Uint8Array(w * h);
for (let i = 0; i < w * h; i += 1) dark[i] = lum[i] < 140 ? 1 : 0;
const seen = new Uint8Array(w * h);
const comps = [];
for (let start = 0; start < w * h; start += 1) {
  if (!dark[start] || seen[start]) continue;
  const stack = [start];
  seen[start] = 1;
  const pts = [];
  let border = false;
  while (stack.length > 0) {
    const at = stack.pop();
    const x = at % w, y = (at - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
    pts.push({ x, y });
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (dark[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
    }
  }
  if (border) continue;
  if (pts.length < 6 || pts.length > 600) continue;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  comps.push({
    n: pts.length,
    cx: xs.reduce((a, b) => a + b, 0) / pts.length + x0,
    cy: ys.reduce((a, b) => a + b, 0) / pts.length + y0,
    bw: Math.max(...xs) - Math.min(...xs) + 1,
    bh: Math.max(...ys) - Math.min(...ys) + 1,
  });
}
console.log('components', comps.length);
console.log(comps.map(c => `(${c.cx.toFixed(0)},${c.cy.toFixed(0)} ${c.bw}x${c.bh} n${c.n})`).join(' '));
const L = -10 * Math.PI / 180, cos = Math.cos(L), sin = Math.sin(L);
const uOf = (p) => p.cx * cos + p.cy * sin;
const us = comps.map(uOf).sort((a, b) => a - b);
console.log('u sorted', us.map(v => v.toFixed(1)).join(' '));
const bands = [];
let current = [us[0]];
for (let i = 1; i < us.length; i += 1) {
  if (us[i] - us[i - 1] > 7) { bands.push(current); current = []; }
  current.push(us[i]);
}
bands.push(current);
console.log('clusters', bands.map(b => `${b[0].toFixed(0)}..${b[b.length-1].toFixed(0)} (${b.length})`).join(' | '));
