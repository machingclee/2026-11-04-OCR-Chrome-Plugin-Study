import { loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
const mask = detected.mask;
const S = 1024;
const boxes = [
  { name: 'blk8', x: 311, y: 581, width: 79, height: 156 },
  { name: 'blk7', x: 177, y: 1033, width: 169, height: 358 },
];
for (const b of boxes) {
  const x0 = Math.max(0, Math.floor(b.x * mask.scale + mask.padX));
  const y0 = Math.max(0, Math.floor(b.y * mask.scale + mask.padY));
  const x1 = Math.min(S - 1, Math.ceil((b.x + b.width) * mask.scale + mask.padX));
  const y1 = Math.min(S - 1, Math.ceil((b.y + b.height) * mask.scale + mask.padY));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    ink[y * w + x] = mask.data[(y0 + y) * S + (x0 + x)] >= 0.3 ? 1 : 0;
  }
  const seen = new Uint8Array(w * h);
  const comps = [];
  const q = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x;
    if (!ink[idx] || seen[idx]) continue;
    q.length = 0; q.push(idx); seen[idx] = 1;
    let minX = x, maxX = x, minY = y, maxY = y, n = 0;
    while (q.length) {
      const at = q.pop(); const cy = Math.floor(at / w), cx = at - cy * w; n++;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ny = cy + dy, nx = cx + dx;
        if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue;
        const ni = ny * w + nx;
        if (ink[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni); }
      }
    }
    comps.push({ n, w: maxX - minX + 1, h: maxY - minY + 1, x: minX + x0, y: minY + y0 });
  }
  comps.sort((a, b) => b.n - a.n);
  console.log(b.name, 'scale', mask.scale, 'components', comps.length);
  console.log(comps.slice(0, 30).map(c => `${c.w}x${c.h}@${c.x},${c.y} n=${c.n}`).join('  '));
  const plausible = comps.filter(c => c.n >= 8 && c.w >= 3 && c.h >= 3 && c.w <= w * 0.8 && c.h <= h * 0.5);
  const sizes = plausible.map(c => (c.w + c.h) / 2 / mask.scale).sort((a, b) => a - b);
  console.log(' median px', sizes.length ? sizes[sizes.length >> 1].toFixed(1) : null, 'count', sizes.length);
}
