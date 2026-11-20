import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { blockInk } from '../../src/lib/ocr/blockHints.ts';
import { majorAxis } from '../../src/lib/rect.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const boxes = [
  { name: 'speech', box: { x: 319, y: 579, width: 74, height: 136 } },
  { name: 'caption', box: { x: 867, y: 608, width: 125, height: 262 } },
  { name: 'banner', box: { x: 202, y: 984, width: 146, height: 377 } },
];
for (const { name, box } of boxes) {
  const pts = blockInk(detected.mask, box);
  for (const n of [1, 2, 3, 4]) {
    const rows = [];
    for (let deg = -24; deg <= 24; deg += 4) {
      const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
      const us = pts.map(p => p.x * cos + p.y * sin);
      const u0 = Math.min(...us), u1 = Math.max(...us);
      const band = (u1 - u0) / n;
      let spread = 0;
      for (let i = 0; i < n; i += 1) {
        const own = us.filter(v => v >= u0 + band * i && v <= u0 + band * (i + 1));
        if (own.length === 0) { spread += 1e6; continue; }
        const c = own.reduce((a, b) => a + b, 0) / own.length;
        spread += own.reduce((s, v) => s + (v - c) ** 2, 0) / own.length;
      }
      rows.push(`${deg}:${(spread / Math.max(1, band) ** 2).toFixed(2)}`);
    }
    rows.sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
    console.log(name, 'n', n, 'best', rows.slice(0, 5).join(' '));
  }
}
