import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';
import { detectLines } from '../../src/lib/detect/index.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';

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
const blocks = [
  { name: 'speech', box: { x: 312, y: 582, width: 78, height: 155 } },
  { name: 'caption', box: { x: 860, y: 600, width: 140, height: 280 } },
  { name: 'top', box: { x: 74, y: 196, width: 120, height: 258 } },
  { name: 'banner', box: { x: 195, y: 975, width: 160, height: 390 } },
];
const started = Date.now(); let calls = 0;
for (const block of blocks) {
  const pts = compPoints(block.box);
  if (pts.length < 20) { console.log(block.name, 'no ink'); continue; }
  const region = { x: block.box.x, y: block.box.y, width: block.box.width, height: block.box.height, text: 'x', direction: 'v', columns: 1, rows: 1, kind: 'chat' };
  applyInclination([region], [], mask);
  const groupLean = region.angle ?? 0;
  const glyph = Math.max(14, Math.min(64, block.box.height / 8));
  const uAt = (deg) => {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const us = pts.map(p => p.x * cos + p.y * sin);
    return { us, cos, sin, u0: Math.min(...us), u1: Math.max(...us) };
  };
  const g = uAt(groupLean * 180 / Math.PI);
  const across = g.u1 - g.u0;
  const multi = across > glyph * 1.6;
  const N = Math.max(2, Math.min(4, Math.round(across / glyph)));
  let lean = groupLean * 180 / Math.PI;
  if (multi) {
    let best = Infinity;
    for (let deg = -24; deg <= 24; deg += 2) {
      const { us, u0, u1 } = uAt(deg);
      const step = (u1 - u0) / N;
      let total = 0;
      for (let i = 0; i < N; i += 1) {
        const a = u0 + step * i, b = a + step;
        const own = us.filter(v => v >= a && v <= b);
        if (own.length === 0) { total += 1e6; continue; }
        const centre = own.reduce((x, y) => x + y, 0) / own.length;
        total += own.reduce((s, v) => s + (v - centre) ** 2, 0);
      }
      const score = total / us.length;
      if (score < best) { best = score; lean = deg; }
    }
  }
  const t = lean * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const vs = pts.map(p => -p.x * sin + p.y * cos);
  const u0 = Math.min(...us), u1 = Math.max(...us);
  const n = multi ? N : 1;
  const step = (u1 - u0) / n;
  const readings = [];
  for (let i = 0; i < n; i += 1) {
    const a = u0 + step * i, b = a + step;
    let v0 = Infinity, v1 = -Infinity;
    us.forEach((value, index) => { if (value >= a && value <= b) { v0 = Math.min(v0, vs[index]); v1 = Math.max(v1, vs[index]); } });
    const uc = (a + b) / 2, vc = (v0 + v1) / 2;
    const band = { x: uc * cos - vc * sin - (b - a) / 2, y: uc * sin + vc * cos - (v1 - v0) / 2, width: b - a, height: v1 - v0, score: 1, angle: t, lineLength: v1 - v0, lineThickness: b - a };
    const out = await recognizeLine(bitmap, band, true).catch(() => ({ text: '', confidence: 0 }));
    calls += 1;
    readings.push({ text: out.text, confidence: +out.confidence.toFixed(2), box: [Math.round(band.x), Math.round(band.y), Math.round(band.width), Math.round(band.height)] });
  }
  console.log(block.name, 'multi', multi, 'N', n, 'lean', lean, 'across', across.toFixed(0), 'glyph', glyph.toFixed(0));
  console.log('   ', JSON.stringify(readings));
}
console.log('calls', calls, 'ms', Date.now() - started);
