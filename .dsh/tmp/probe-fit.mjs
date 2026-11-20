import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const mask = detected.mask;
const blocks = [
  { name: 'speech', x: 312, y: 582, width: 78, height: 155, N: 3 },
  { name: 'banner', x: 195, y: 975, width: 160, height: 390, N: 1 },
];
function points(box) {
  const w = Math.ceil(box.width * mask.scale) + 2, h = Math.ceil(box.height * mask.scale) + 2;
  const gx = Math.floor(box.x * mask.scale + mask.padX) - 1, gy = Math.floor(box.y * mask.scale + mask.padY) - 1;
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) dark[y * w + x] = (mask.data[(gy + y) * MODEL_SIZE + (gx + x)] ?? 0) > 0.25 ? 1 : 0;
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let start = 0; start < w * h; start += 1) {
    if (!dark[start] || seen[start]) continue;
    const stack = [start]; seen[start] = 1;
    const cells = []; let border = false;
    while (stack.length) {
      const at = stack.pop(); const x = at % w, y = (at - x) / w;
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
    for (const at of cells) { const x = at % w, y = (at - x) / w; out.push({ x: (gx + x - mask.padX) / mask.scale, y: (gy + y - mask.padY) / mask.scale }); }
  }
  return out;
}
for (const block of blocks) {
  const pts = points(block);
  const results = [];
  for (let deg = -20; deg <= 20; deg += 1) {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const us = pts.map(p => p.x * cos + p.y * sin);
    const u0 = Math.min(...us), u1 = Math.max(...us);
    const step = (u1 - u0) / block.N;
    let total = 0;
    for (let i = 0; i < block.N; i += 1) {
      const a = u0 + step * i, b = a + step;
      const own = us.filter(v => v >= a && v <= b);
      if (own.length === 0) { total += 1e6; continue; }
      const centre = own.reduce((x, y) => x + y, 0) / own.length;
      total += own.reduce((sum, v) => sum + (v - centre) ** 2, 0);
    }
    results.push({ deg, total: total / us.length });
  }
  results.sort((a, b) => a.total - b.total);
  console.log(block.name, 'points', pts.length, 'best', results.slice(0, 5).map(r => `${r.deg}:${r.total.toFixed(1)}`).join(' '), 'worst', results.slice(-2).map(r => `${r.deg}:${r.total.toFixed(1)}`).join(' '));
}
