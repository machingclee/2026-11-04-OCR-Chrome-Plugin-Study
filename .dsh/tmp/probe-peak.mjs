import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { blockInk } from '../../src/lib/ocr/blockHints.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const boxes = [
  { name: 'speech', box: { x: 319, y: 579, width: 74, height: 136 }, want: -16 },
  { name: 'caption', box: { x: 867, y: 608, width: 125, height: 262 }, want: 0 },
  { name: 'banner', box: { x: 202, y: 984, width: 146, height: 377 }, want: 18 },
];
for (const { name, box, want } of boxes) {
  const pts = blockInk(detected.mask, box);
  const rows = [];
  for (let deg = -24; deg <= 24; deg += 2) {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const us = pts.map(p => p.x * cos + p.y * sin);
    const u0 = Math.min(...us), u1 = Math.max(...us);
    // Gaussian splat onto a 1px grid.
    const sigma = 2;
    const radius = 6;
    const bins = new Float64Array(Math.ceil(u1 - u0) + 2 * radius + 2);
    for (const u of us) {
      const centre = u - u0 + radius;
      const base = Math.floor(centre);
      for (let i = base - radius; i <= base + radius; i += 1) {
        const w = Math.exp(-((i - centre) ** 2) / (2 * sigma * sigma));
        if (i >= 0 && i < bins.length) bins[i] += w;
      }
    }
    let sum = 0, sum2 = 0;
    for (const v of bins) { sum += v; sum2 += v * v; }
    rows.push({ deg, peak: sum2 / (sum * sum) });
  }
  const sorted = [...rows].sort((a, b) => b.peak - a.peak);
  console.log(name, 'want', want, 'best', sorted.slice(0, 5).map(r => `${r.deg}:${r.peak.toFixed(4)}`).join(' '), '|| at want', rows.find(r => r.deg === want)?.peak.toFixed(4));
}
