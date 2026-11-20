import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
import { readdirSync } from 'node:fs';
const target = await loadImage('/Users/chingcheonglee/Library/Application Support/dsh-desktop/harness/attachments/v1/objects/b5/b50d25e0e0d8e92a79ad234a9c711c97c989ad8f7f75f473155216a77d593af1');
const signature = (img) => {
  const c = createCanvas(48, 64);
  c.getContext('2d').drawImage(img, 0, 0, img.width, img.height, 0, 0, 48, 64);
  return c.getContext('2d').getImageData(0, 0, 48, 64).data;
};
const t = signature(target);
for (const file of readdirSync('fixtures').filter(f => f.endsWith('.jpg'))) {
  const img = await loadImage(`fixtures/${file}`);
  const s = signature(img);
  let diff = 0;
  for (let i = 0; i < s.length; i += 4) diff += Math.abs(s[i] - t[i]);
  console.log(file, (diff / (s.length / 4)).toFixed(1));
}
