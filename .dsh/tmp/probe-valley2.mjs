import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { blockInk } from '../../src/lib/ocr/blockHints.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const boxes = [
  { name: 'speech', box: { x: 319, y: 579, width: 74, height: 136 }, want: -16 },
  { name: 'caption', box: { x: 867, y: 608, width: 125, height: 262 }, want: 0 },
  { name: 'top', box: { x: 81, y: 203, width: 107, height: 244 }, want: 0 },
  { name: 'dup', box: { x: 139, y: 645, width: 93, height: 248 }, want: 0 },
];
for (const { name, box, want } of boxes) {
  const pts = blockInk(detected.mask, box);
  const rows = [];
  for (let deg = -24; deg <= 24; deg += 1) {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const us = pts.map(p => p.x * cos + p.y * sin);
    const u0 = Math.min(...us), u1 = Math.max(...us);
    const sigma = 1.6, radius = 5;
    const bins = new Float64Array(Math.ceil(u1 - u0) + 2 * radius + 2);
    for (const u of us) {
      const centre = u - u0 + radius;
      for (let i = Math.floor(centre) - radius; i <= Math.floor(centre) + radius; i += 1) {
        if (i >= 0 && i < bins.length) bins[i] += Math.exp(-((i - centre) ** 2) / (2 * sigma * sigma));
      }
    }
    const peak = Math.max(...bins);
    const from = Math.floor(bins.length * 0.2), to = Math.ceil(bins.length * 0.8);
    let valley = peak;
    for (let i = from; i <= to; i += 1) valley = Math.min(valley, bins[i]);
    rows.push({ deg, depth: valley / peak });
  }
  const sorted = [...rows].sort((a, b) => a.depth - b.depth);
  console.log(name, 'want', want, 'best', sorted.slice(0, 6).map(r => `${r.deg}:${r.depth.toFixed(2)}`).join(' '), '|| at want', rows.find(r => r.deg === want)?.depth.toFixed(2));
}
