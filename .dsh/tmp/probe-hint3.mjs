import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { readBlockHint } from '../../src/lib/ocr/blockHints.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const started = Date.now();
for (const blk of detected.blkBoxes) {
  const inside = detected.detBoxes.filter(box => box.x < blk.x + blk.width && box.x + box.width > blk.x && box.y < blk.y + blk.height && box.y + box.height > blk.y);
  const hint = await readBlockHint(bitmap, blk, detected.mask, inside.length);
  console.log(`blk ${blk.x.toFixed(0)},${blk.y.toFixed(0)} det ${inside.length}`, hint
    ? `cols ${hint.columns} lean ${(hint.lean * 180 / Math.PI).toFixed(1)} :: ` + hint.lines.map(l => `"${l.text}"(${l.confidence.toFixed(2)})`).join(' | ')
    : 'no hint');
}
console.log('ms', Date.now() - started);
