import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';
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
for (const blk of detected.blkBoxes) {
  const pts = compPoints({ x: blk.x, y: blk.y, width: blk.width, height: blk.height });
  if (pts.length < 20) { console.log('blk', blk.x.toFixed(0), blk.y.toFixed(0), blk.width.toFixed(0), blk.height.toFixed(0), 'few points', pts.length); continue; }
  const region = { x: blk.x, y: blk.y, width: blk.width, height: blk.height, text: 'x', direction: 'v', columns: 1, rows: 1, kind: 'chat' };
  applyInclination([region], [], mask);
  const lean = region.angle ?? 0;
  const cos = Math.cos(lean), sin = Math.sin(lean);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const across = Math.max(...us) - Math.min(...us);
  const thickness = region.glyphSize ?? blk.width;
  const n = Math.max(1, Math.min(4, Math.round(across / Math.max(6, thickness))));
  console.log(`blk ${blk.x.toFixed(0)},${blk.y.toFixed(0)} ${blk.width.toFixed(0)}x${blk.height.toFixed(0)} lean ${(lean * 180 / Math.PI).toFixed(1)} across ${across.toFixed(0)} th ${thickness.toFixed(0)} N ${n}`);
}
