import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { blockInk } from '../../src/lib/ocr/blockHints.ts';
import { majorAxis } from '../../src/lib/rect.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const boxes = [
  { name: 'blk', box: { x: 319, y: 579, width: 74, height: 136 } },
  { name: 'det+pad', box: { x: 312, y: 582, width: 78, height: 155 } },
];
for (const { name, box } of boxes) {
  const pts = blockInk(detected.mask, box);
  const axis = majorAxis(pts);
  const groupLean = axis === null ? 0 : (axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2);
  const acrossAt = (deg) => {
    const t = deg * Math.PI / 180;
    const us = pts.map(p => p.x * Math.cos(t) + p.y * Math.sin(t));
    return Math.max(...us) - Math.min(...us);
  };
  console.log(name, 'pts', pts.length, 'axis', axis, 'lean', (groupLean * 180 / Math.PI).toFixed(1), 'across@group', acrossAt(groupLean * 180 / Math.PI).toFixed(0), 'across@0', acrossAt(0).toFixed(0));
  for (const n of [2, 3, 4]) {
    const rows = [];
    for (let deg = -24; deg <= 24; deg += 4) {
      const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
      const us = pts.map(p => p.x * cos + p.y * sin);
      const u0 = Math.min(...us), u1 = Math.max(...us);
      const step = (u1 - u0) / n;
      let spread = 0;
      for (let i = 0; i < n; i += 1) {
        const own = us.filter(v => v >= u0 + step * i && v <= u0 + step * (i + 1));
        if (own.length === 0) { spread += 1e6; continue; }
        const c = own.reduce((a, b) => a + b, 0) / own.length;
        spread += own.reduce((s, v) => s + (v - c) ** 2, 0);
      }
      rows.push(`${deg}:${(spread / us.length).toFixed(1)}`);
    }
    console.log(' n', n, rows.join(' '));
  }
}
