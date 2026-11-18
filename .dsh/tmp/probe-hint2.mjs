import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { readBlockHint } from '../../src/lib/ocr/blockHints.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const started = Date.now();
for (const blk of detected.blkBoxes) {
  const hint = await readBlockHint(bitmap, blk, detected.mask);
  console.log(`blk ${blk.x.toFixed(0)},${blk.y.toFixed(0)} ${blk.width.toFixed(0)}x${blk.height.toFixed(0)}`, hint
    ? `cols ${hint.columns} lean ${(hint.lean * 180 / Math.PI).toFixed(1)} :: ` + hint.lines.map(l => `"${l.text}"(${l.confidence.toFixed(2)})`).join(' | ')
    : 'no hint');
}
console.log('ms', Date.now() - started);
