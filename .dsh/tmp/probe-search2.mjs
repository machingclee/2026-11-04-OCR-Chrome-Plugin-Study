import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const mask = detected.mask;
const box = { x: 312, y: 582, width: 78, height: 155 };
const w = Math.ceil(box.width * mask.scale) + 2, h = Math.ceil(box.height * mask.scale) + 2;
const gx = Math.floor(box.x * mask.scale + mask.padX) - 1, gy = Math.floor(box.y * mask.scale + mask.padY) - 1;
const dark = new Uint8Array(w * h);
const values = new Float32Array(w * h);
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const value = mask.data[(gy + y) * MODEL_SIZE + (gx + x)] ?? 0;
    values[y * w + x] = value;
    dark[y * w + x] = value > 0.25 ? 1 : 0;
  }
}
const seen = new Uint8Array(w * h);
const kept = [];
for (let start = 0; start < w * h; start += 1) {
  if (!dark[start] || seen[start]) continue;
  const stack = [start];
  seen[start] = 1;
  const cells = [];
  let border = false;
  while (stack.length > 0) {
    const at = stack.pop();
    const x = at % w, y = (at - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
    cells.push(at);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (dark[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
    }
  }
  if (border || cells.length < 4 || cells.length > 900) continue;
  kept.push(...cells);
}
console.log('components kept', kept.length, 'of', dark.reduce((a, b) => a + b, 0));
const pts = kept.map((at) => {
  const x = at % w, y = (at - x) / w;
  return { x: (gx + x - mask.padX) / mask.scale, y: (gy + y - mask.padY) / mask.scale };
});
const N = 3;
const extent = (deg) => {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const us = pts.map(p => p.x * cos + p.y * sin);
  return [Math.min(...us), Math.max(...us)];
};
const bandOf = (deg, which) => {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const vs = pts.map(p => -p.x * sin + p.y * cos);
  const [u0, u1] = [Math.min(...us), Math.max(...us)];
  const step = (u1 - u0) / N;
  const a = u0 + step * which, b = u0 + step * (which + 1);
  let v0 = Infinity, v1 = -Infinity;
  us.forEach((value, index) => { if (value >= a && value <= b) { v0 = Math.min(v0, vs[index]); v1 = Math.max(v1, vs[index]); } });
  const uc = (a + b) / 2, vc = (v0 + v1) / 2;
  return { x: uc * cos - vc * sin - (b - a) / 2, y: uc * sin + vc * cos - (v1 - v0) / 2, width: b - a, height: v1 - v0, score: 1, angle: t, lineLength: v1 - v0, lineThickness: b - a };
};
console.log('extents', [-16,-12,-8,-4,0,4,8,12,16].map(d => `${d}:${extent(d).map(v => v.toFixed(0)).join('..')}`).join(' '));
const results = [];
for (let deg = -16; deg <= 16; deg += 2) {
  let score = 0, texts = [];
  for (let i = 0; i < N; i += 1) {
    const out = await recognizeLine(bitmap, bandOf(deg, i), true).catch(() => ({ text: '', confidence: 0 }));
    score += out.confidence * Math.min(1, [...out.text].length / 4);
    texts.push(`${out.text}(${out.confidence.toFixed(2)})`);
  }
  results.push({ deg, score, texts });
}
for (const r of results) console.log(r.deg, r.score.toFixed(2), r.texts.join(' | '));
results.sort((a, b) => b.score - a.score);
const best = results[0].deg;
console.log('best', best);
for (let i = 0; i < N; i += 1) {
  const band = bandOf(best, i);
  const out = await recognizeLine(bitmap, band, true).catch(() => ({ text: '', confidence: 0 }));
  console.log('final band', i, JSON.stringify(out));
  const up = createCanvas(Math.round(band.width), Math.round(band.height));
  drawUpright(up.getContext('2d'), bitmap, band, up.width, up.height);
  const c = createCanvas(up.width * 5, up.height * 5);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(up, 0, 0, c.width, c.height);
  writeFileSync(`.dsh/tmp/best2-${i}.png`, c.toBuffer('image/png'));
}
