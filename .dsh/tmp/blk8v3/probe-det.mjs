import { loadImage, prepareOrt } from '../../../scripts/harness/env.mjs';
import { detectLines } from '../../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const d = await detectLines(img, []);
for (const b of d.detBoxes) {
  if (b.y > 520 && b.y < 760 && b.x > 240 && b.x < 430) console.log(JSON.stringify(b));
}
console.log('blk', d.blkBoxes.filter(b => b.y > 520 && b.y < 760).map(b => JSON.stringify(b)).join('\n'));
