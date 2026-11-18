import { loadImage, prepareOrt } from '../../../scripts/harness/env.mjs';
import { detectLines } from '../../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const d = await detectLines(img, []);
const mask = d.mask;
const S = 1024;
const region = { x: 255, y: 555, width: 155, height: 190 };
const x0 = Math.max(0, Math.floor(region.x * mask.scale + mask.padX));
const y0 = Math.max(0, Math.floor(region.y * mask.scale + mask.padY));
const x1 = Math.min(S - 1, Math.ceil((region.x + region.width) * mask.scale + mask.padX));
const y1 = Math.min(S - 1, Math.ceil((region.y + region.height) * mask.scale + mask.padY));
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
  let minX = x, maxX = x, minY = y, maxY = y, n = 0, sx = 0;
  while (q.length) {
    const at = q.pop(); const cy = Math.floor(at / w), cx = at - cy * w; n++; sx += cx;
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ny = cy + dy, nx = cx + dx;
      if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue;
      const ni = ny * w + nx;
      if (ink[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni); }
    }
  }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  if (n < 6 || bw > 45 || bh > 70) continue;
  if (bh > h * 0.7 && bw < 5) continue; // panel edge
  comps.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, bw, bh, n, x: (minX + x0 - mask.padX) / mask.scale });
}
comps.sort((a, b) => a.x - b.x);
console.log('components', comps.length);
console.log(comps.map(c => `${c.x.toFixed(0)}(${c.bw}x${c.bh})`).join(' '));
const centres = comps.map(c => c.x).sort((a, b) => a - b);
const clusters = [];
for (const x of centres) {
  const last = clusters[clusters.length - 1];
  if (last && x - last[last.length - 1] <= 12) last.push(x);
  else clusters.push([x]);
}
console.log('clusters', clusters.map(c => `${c[0].toFixed(0)}-${c[c.length-1].toFixed(0)} n${c.length}`).join(' | '));
