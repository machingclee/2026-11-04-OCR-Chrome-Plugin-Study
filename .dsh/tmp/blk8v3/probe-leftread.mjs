import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../../scripts/harness/env.mjs';
import { requestDeepSeek } from '../../../src/lib/ocr/cloudOcr.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const key = readApiKey();
for (const box of [
  { x: 282, y: 595, w: 34, h: 147 },
  { x: 285, y: 600, w: 30, h: 140 },
  { x: 278, y: 590, w: 40, h: 155 },
]) {
  const scale = 4;
  const c = createCanvas(box.w * scale, box.h * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.92);
  const lines = await requestDeepSeek(key, [url], 'off');
  console.log(JSON.stringify(box), '->', JSON.stringify(lines.map(l => l.text)));
}
