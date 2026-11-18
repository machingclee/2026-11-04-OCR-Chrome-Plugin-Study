import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';
import { detectLines } from '../../src/lib/detect/index.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const mask = detected.mask;
function compPoints(box) {
  const w = Math.ceil(box.width * mask.scale) + 2, h = Math.ceil(box.height * mask.scale) + 2;
  const gx = Math.floor(box.x * mask.scale + mask.padX) - 1, gy = Math.floor(box.y * mask.scale + mask.padY) - 1;
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) dark[y * w + x] = (mask.data[(gy + y) * MODEL_SIZE + (gx + x)] ?? 0) > 0.25 ? 1 : 0;
  const seen = new Uint8Array(w * h); const out = [];
  for (let start = 0; start < w * h; start += 1) {
    if (!dark[start] || seen[start]) continue;
    const stack = [start]; seen[start] = 1; const cells = []; let border = false;
    while (stack.length) {
      const at = stack.pop(); const x = at % w, y = (at - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      cells.push({ x, y });
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const next = ny * w + nx;
        if (dark[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
      }
    }
    if (border || cells.length < 4 || cells.length > 900) continue;
    for (const c of cells) out.push({ x: (gx + c.x - mask.padX) / mask.scale, y: (gy + c.y - mask.padY) / mask.scale });
  }
  return out;
}
const box = { x: 312, y: 582, width: 78, height: 155 };
const pts = compPoints(box);
console.log('points', pts.length);
const started = Date.now();
let calls = 0;
const run = async (band) => { calls += 1; return recognizeLine(bitmap, band, true).catch(() => ({ text: '', confidence: 0 })); };
const thickness = Math.max(16, Math.min(64, box.height / 8.5));
for (const deg of [-22, -18, -14, -10, -6, -2, 2, 6, 10, 14, 18]) {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const vs = pts.map(p => -p.x * sin + p.y * cos);
  const u0 = Math.min(...us), u1 = Math.max(...us);
  const strips = Math.max(1, Math.floor((u1 - u0 - thickness) / (thickness / 2)) + 1);
  let score = 0;
  const texts = [];
  for (let i = 0; i < strips; i += 1) {
    const a = u0 + i * (thickness / 2);
    const b = Math.min(u1, a + thickness);
    let v0 = Infinity, v1 = -Infinity;
    us.forEach((value, index) => { if (value >= a && value <= b) { v0 = Math.min(v0, vs[index]); v1 = Math.max(v1, vs[index]); } });
    if (!(v1 > v0)) continue;
    const uc = (a + b) / 2, vc = (v0 + v1) / 2;
    const band = { x: uc * cos - vc * sin - (b - a) / 2, y: uc * sin + vc * cos - (v1 - v0) / 2, width: b - a, height: v1 - v0, score: 1, angle: t, lineLength: v1 - v0, lineThickness: b - a };
    const out = await run(band);
    const glyphs = [...out.text].length;
    if (glyphs >= 2 && out.confidence >= 0.45) score += out.confidence * Math.min(8, glyphs);
    texts.push(`${out.text}(${out.confidence.toFixed(2)})`);
  }
  console.log(deg, 'score', score.toFixed(2), texts.join(' '));
}
console.log('calls', calls, 'ms', Date.now() - started);
