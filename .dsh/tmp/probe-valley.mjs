import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';

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
for (const blk of [ { name: 'speech', box: { x: 312, y: 582, width: 78, height: 155 } }, { name: 'caption', box: { x: 860, y: 600, width: 140, height: 280 } }, { name: 'banner', box: { x: 195, y: 975, width: 160, height: 390 } } ]) {
  const pts = compPoints(blk.box);
  const rows = [];
  for (let deg = -20; deg <= 20; deg += 2) {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const us = pts.map(p => p.x * cos + p.y * sin);
    const u0 = Math.min(...us), u1 = Math.max(...us);
    const bins = new Map();
    for (const u of us) { const k = Math.floor((u - u0) / 2); bins.set(k, (bins.get(k) ?? 0) + 1); }
    const n = Math.ceil((u1 - u0) / 2);
    const counts = Array.from({ length: n }, (_, i) => bins.get(i) ?? 0);
    const peak = Math.max(...counts);
    let valleys = 0, deepest = 1;
    for (let i = 2; i < counts.length - 2; i += 1) {
      if (counts[i] < peak * 0.25 && counts[i] <= counts[i - 1] && counts[i] <= counts[i + 1]) { valleys += 1; deepest = Math.min(deepest, counts[i] / peak); }
    }
    rows.push(`${deg}:${valleys}/${deepest.toFixed(2)}`);
  }
  console.log(blk.name, rows.join(' '));
}
