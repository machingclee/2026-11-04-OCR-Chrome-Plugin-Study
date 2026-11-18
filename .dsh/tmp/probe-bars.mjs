import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const mask = detected.mask;
const box = { x: 312, y: 582, width: 78, height: 155 };
const w = Math.ceil(box.width * mask.scale) + 2, h = Math.ceil(box.height * mask.scale) + 2;
const gx = Math.floor(box.x * mask.scale + mask.padX) - 1, gy = Math.floor(box.y * mask.scale + mask.padY) - 1;
const dark = new Uint8Array(w * h);
for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) dark[y * w + x] = (mask.data[(gy + y) * MODEL_SIZE + (gx + x)] ?? 0) > 0.25 ? 1 : 0;
const seen = new Uint8Array(w * h);
const angles = [];
for (let start = 0; start < w * h; start += 1) {
  if (!dark[start] || seen[start]) continue;
  const stack = [start]; seen[start] = 1;
  const cells = []; let border = false;
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
  if (border || cells.length < 6 || cells.length > 900) continue;
  let mx = 0, my = 0;
  for (const c of cells) { mx += c.x; my += c.y; }
  mx /= cells.length; my /= cells.length;
  let xx = 0, xy = 0, yy = 0;
  for (const c of cells) { const dx = c.x - mx, dy = c.y - my; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI;
  const elongation = (xx + yy) / cells.length;
  // a long thin blob (a ー or a stroke) is a bar: its angle is the lean
  if (elongation > 12) angles.push({ theta, n: cells.length, w: Math.max(...cells.map(c => c.x)) - Math.min(...cells.map(c => c.x)) + 1, h: Math.max(...cells.map(c => c.y)) - Math.min(...cells.map(c => c.y)) + 1 });
}
console.log(angles.map(a => `${a.theta.toFixed(1)}deg ${a.w}x${a.h} n${a.n}`).join(' | '));
