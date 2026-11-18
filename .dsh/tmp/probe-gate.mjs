import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { blockInk } from '../../src/lib/ocr/blockHints.ts';
import { majorAxis } from '../../src/lib/rect.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
for (const blk of detected.blkBoxes) {
  const pts = blockInk(detected.mask, blk);
  if (pts.length < 40) continue;
  const axis = majorAxis(pts);
  const groupLean = axis === null ? 0 : (axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2);
  const cos = Math.cos(groupLean), sin = Math.sin(groupLean);
  const us = pts.map(p => p.x * cos + p.y * sin);
  const across = Math.max(...us) - Math.min(...us);
  const glyph = Math.max(12, blk.height / 8);
  const columns = Math.max(1, Math.min(4, Math.round(across / glyph)));
  const inside = detected.detBoxes.filter(box => box.x < blk.x + blk.width && box.x + box.width > blk.x && box.y < blk.y + blk.height && box.y + box.height > blk.y);
  console.log(`blk ${blk.x.toFixed(0)},${blk.y.toFixed(0)} ${blk.width.toFixed(0)}x${blk.height.toFixed(0)} across ${across.toFixed(0)} glyph ${glyph.toFixed(0)} cols ${columns} det ${inside.length}`);
}
