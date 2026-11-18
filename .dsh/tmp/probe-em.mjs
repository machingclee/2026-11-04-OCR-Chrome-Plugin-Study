import { prepareOrt, loadImage } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';

await prepareOrt();
for (const image of ['fixtures/page-325.jpg', 'fixtures/page-forty.jpg']) {
  const bitmap = await loadImage(image);
  const detected = await detectLines(bitmap, []);
  console.log('==', image);
  for (const blk of detected.blkBoxes) {
    const inside = detected.detBoxes.filter(box => box.x < blk.x + blk.width && box.x + box.width > blk.x && box.y < blk.y + blk.height && box.y + box.height > blk.y);
    const region = { x: blk.x, y: blk.y, width: blk.width, height: blk.height, text: 'x', direction: 'v', columns: 1, rows: 1, kind: 'chat' };
    applyInclination([region], [], detected.mask);
    console.log(`blk ${blk.x.toFixed(0)},${blk.y.toFixed(0)} ${blk.width.toFixed(0)}x${blk.height.toFixed(0)} -> lean ${(region.angle === undefined ? 0 : region.angle * 180 / Math.PI).toFixed(1)} glyph ${region.glyphSize?.toFixed(1)}`,
      inside.map(b => `${b.width.toFixed(0)}x${b.height.toFixed(0)}`).join(' '));
  }
}
