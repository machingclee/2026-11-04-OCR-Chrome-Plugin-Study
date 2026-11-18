import { loadImage, prepareOrt, readApiKey } from '../../../scripts/harness/env.mjs';
import { readBlockRegions } from '../../../src/lib/ocr/cloudOcr.ts';
import { detectLines } from '../../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
const key = readApiKey();
const columns = [
  { x: 280, y: 575, width: 37, height: 160, score: 0.55 },
  { x: 317, y: 575, width: 36, height: 160, score: 0.55 },
  { x: 353, y: 575, width: 37, height: 160, score: 0.55 },
];
for (const c of columns) {
  const readings = await readBlockRegions(img, [c], { provider: 'deepseek', key }, [c], detected.mask);
  console.log('COLUMN', c.x, JSON.stringify(readings[0].regions.map((r) => ({ text: r.text, angle: r.angle, glyph: r.glyphSize }))));
  console.log('RAW', readings[0].raw);
}
