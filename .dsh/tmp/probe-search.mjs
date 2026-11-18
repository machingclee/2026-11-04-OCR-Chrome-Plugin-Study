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
const pts = [];
for (let my = Math.floor(box.y * mask.scale + mask.padY); my <= Math.ceil((box.y + box.height) * mask.scale + mask.padY); my += 1) {
  for (let mx = Math.floor(box.x * mask.scale + mask.padX); mx <= Math.ceil((box.x + box.width) * mask.scale + mask.padX); mx += 1) {
    const value = mask.data[my * MODEL_SIZE + mx];
    if (value < 0.25) continue;
    pts.push({ x: (mx - mask.padX) / mask.scale, y: (my - mask.padY) / mask.scale });
  }
}
const N = 3;
const bandOf = (deg, which) => {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const vs = pts.map(p => -p.x * sin + p.y * cos);
  const u0 = Math.min(...us), u1 = Math.max(...us);
  const step = (u1 - u0) / N;
  const a = u0 + step * which, b = u0 + step * (which + 1);
  let v0 = Infinity, v1 = -Infinity;
  pts.forEach((p, index) => { if (us[index] >= a && us[index] <= b) { v0 = Math.min(v0, vs[index]); v1 = Math.max(v1, vs[index]); } });
  const uc = (a + b) / 2, vc = (v0 + v1) / 2;
  return {
    x: uc * cos - vc * sin - (b - a) / 2,
    y: uc * sin + vc * cos - (v1 - v0) / 2,
    width: b - a, height: v1 - v0, score: 1, angle: t, lineLength: v1 - v0, lineThickness: b - a,
  };
};
const results = [];
for (let deg = -16; deg <= 16; deg += 2) {
  const band = bandOf(deg, 1);
  const out = await recognizeLine(bitmap, band, true).catch(() => ({ text: '', confidence: 0 }));
  results.push({ deg, text: out.text, conf: out.confidence });
}
console.log(results.map(r => `${r.deg}:${r.conf.toFixed(2)}:${r.text}`).join(' | '));
results.sort((a, b) => b.conf - a.conf);
const best = results[0].deg;
console.log('best lean', best);
for (let i = 0; i < N; i += 1) {
  const band = bandOf(best, i);
  const out = await recognizeLine(bitmap, band, true).catch(e => ({ text: '', confidence: 0 }));
  console.log('band', i, JSON.stringify(out), `th=${band.width.toFixed(1)} len=${band.height.toFixed(1)}`);
  const up = createCanvas(Math.round(band.width), Math.round(band.height));
  drawUpright(up.getContext('2d'), bitmap, band, up.width, up.height);
  const c = createCanvas(up.width * 5, up.height * 5);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(up, 0, 0, c.width, c.height);
  writeFileSync(`.dsh/tmp/best-${i}.png`, c.toBuffer('image/png'));
}
