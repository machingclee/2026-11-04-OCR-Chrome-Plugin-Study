import { loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { majorAxis } from '../../src/lib/rect.ts';

await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
console.log('mask', !!detected.mask, detected.mask?.scale, detected.mask?.padX, detected.mask?.padY);
const mask = detected.mask;
const at = (x, y) => {
  const mx = Math.round(x * mask.scale + mask.padX);
  const my = Math.round(y * mask.scale + mask.padY);
  if (mx < 0 || my < 0 || mx >= 1024 || my >= 1024) return 0;
  return mask.data[my * 1024 + mx];
};
const boxes = [
  { name: 'blk8-blue', x: 311, y: 581, width: 79, height: 156 },
  { name: 'blk8-block', x: 312, y: 580, width: 73, height: 135 },
  { name: 'blk7-blue', x: 177, y: 1033, width: 169, height: 358 },
  { name: 'blk7-block', x: 202, y: 983, width: 146, height: 376 },
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
