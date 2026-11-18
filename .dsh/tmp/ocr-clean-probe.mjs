import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { requestDeepSeek } from '../../src/lib/ocr/cloudOcr.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const key = readApiKey();
for (const box of [
  { x: 315, y: 575, w: 40, h: 170 },
  { x: 310, y: 570, w: 50, h: 180 },
  { x: 320, y: 580, w: 35, h: 160 },
]) {
  const scale = 6;
  const c = createCanvas(box.w * scale, box.h * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.95);
  const lines = await requestDeepSeek(key, [url], 'off');
  console.log(JSON.stringify(box), '->', JSON.stringify(lines.map(l => l.text)));
}
