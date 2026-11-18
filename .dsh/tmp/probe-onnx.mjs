import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const near = detected.detBoxes.filter(b => b.x < 460 && b.x + b.width > 280 && b.y < 760 && b.y + b.height > 520);
console.log('det boxes near BLK8', near.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), score: +b.score.toFixed(2), angle: b.angle })));
const blkNear = detected.blkBoxes.filter(b => b.x < 460 && b.x + b.width > 280 && b.y < 760 && b.y + b.height > 520);
console.log('blk boxes near', blkNear.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), score: +b.score.toFixed(2) })));
for (const box of near) {
  const vertical = box.height >= box.width;
  try {
    const result = await recognizeLine(bitmap, box, vertical);
    console.log('ocr', Math.round(box.x), Math.round(box.y), JSON.stringify(result));
  } catch (cause) {
    console.log('ocr failed', cause.message);
  }
}
