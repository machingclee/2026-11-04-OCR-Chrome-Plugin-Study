import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const target = await loadImage('/Users/chingcheonglee/Library/Application Support/dsh-desktop/harness/attachments/v1/objects/b5/b50d25e0e0d8e92a79ad234a9c711c97c989ad8f7f75f473155216a77d593af1');
console.log('target', target.width, target.height);
const t = createCanvas(target.width, target.height);
t.getContext('2d').drawImage(target, 0, 0);
const tdata = t.getContext('2d').getImageData(0, 0, 200, 200).data;
const names = ['page-320', 'page-321', 'page-322', 'page-323', 'page-324', 'page-forty', 'page-groan', 'page-name', 'page-office', 'page-wizard', 'page'];
for (const name of names) {
  const img = await loadImage(`fixtures/${name}.jpg`);
  if (img.width !== target.width) { console.log(name, 'size', img.width); continue; }
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  const data = c.getContext('2d').getImageData(0, 0, 200, 200).data;
  let diff = 0;
  for (let i = 0; i < data.length; i += 4) diff += Math.abs(data[i] - tdata[i]);
  console.log(name, 'diff', (diff / (data.length / 4)).toFixed(1));
}
