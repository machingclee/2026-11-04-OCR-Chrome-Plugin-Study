import { loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { majorAxis } from '../../src/lib/rect.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
const mask = detected.mask;
const at = (x, y) => {
  const mx = Math.round(x * mask.scale + mask.padX);
  const my = Math.round(y * mask.scale + mask.padY);
  if (mx < 0 || my < 0 || mx >= 1024 || my >= 1024) return 0;
  return mask.data[my * 1024 + mx];
};
const boxes = [
  { name: 'b1-r1', x: 338, y: 580, width: 52, height: 210 },
  { name: 'b1-r2', x: 288, y: 585, width: 52, height: 160 },
  { name: 'b1-r3', x: 279, y: 630, width: 52, height: 270 },
  { name: 'b2-r1', x: 281, y: 967, width: 64, height: 78 },
  { name: 'b2-r2', x: 258, y: 1062, width: 74, height: 300 },
];
for (const b of boxes) {
  const pts = [];
  for (let y = b.y; y < b.y + b.height; y += 0.5) {
    for (let x = b.x; x < b.x + b.width; x += 0.5) {
      if (at(x, y) >= 0.3) pts.push({ x, y });
    }
  }
  const angle = majorAxis(pts);
  console.log(b.name, 'points', pts.length, 'major deg', angle === null ? null : (angle * 180 / Math.PI).toFixed(2));
}
