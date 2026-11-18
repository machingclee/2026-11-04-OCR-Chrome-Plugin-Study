// scripts/harness/env.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
var ROOT = process.cwd();
var candidates = [
  process.env.CANVAS_ROOT,
  `${ROOT}/node_modules`,
  "/Users/chingcheonglee/Repos/Javascript/ShinobuTranslator/node_modules"
].filter((value) => typeof value === "string" && value.length > 0);
var canvasModule = null;
var tried = [];
for (const directory of candidates) {
  try {
    canvasModule = createRequire(`${directory}/package.json`)("canvas");
    break;
  } catch (cause) {
    tried.push(`${directory}: ${cause instanceof Error ? cause.code ?? cause.message : String(cause)}`);
  }
}
if (!canvasModule) {
  throw new Error([
    "No canvas implementation found, so the pipeline cannot render in Node.",
    "Install one with `npm install --no-save canvas`, or point CANVAS_ROOT at a",
    "checkout whose node_modules holds it. Tried:",
    ...tried.map((line) => `  ${line}`)
  ].join("\n"));
}
var { createCanvas, loadImage } = canvasModule;
globalThis.OffscreenCanvas = class OffscreenCanvasShim {
  constructor(width, height) {
    return createCanvas(width, height);
  }
};
globalThis.document = {
  createElement: (tag) => {
    if (tag !== "canvas") throw new Error(`The page harness only creates canvases, not <${tag}>.`);
    return createCanvas(1, 1);
  }
};
if (typeof globalThis.ImageData === "undefined" && canvasModule.ImageData) {
  globalThis.ImageData = canvasModule.ImageData;
}
globalThis.createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
globalThis.chrome = {
  runtime: {
    getURL: (path) => `${ROOT}/public/${path}`
  }
};
var realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (typeof url === "string" && url.startsWith("/")) {
    return new Response(readFileSync(url), {
      status: 200,
      headers: { "content-type": "application/octet-stream" }
    });
  }
  return realFetch(input, init);
};
async function prepareOrt() {
  const [{ default: ort3 }, webgpu3] = await Promise.all([
    import("onnxruntime-web"),
    import("onnxruntime-web/webgpu")
  ]);
  for (const instance of [ort3, webgpu3]) {
    instance.env.wasm.numThreads = 1;
    instance.env.wasm.proxy = false;
    instance.env.wasm.wasmPaths = `${ROOT}/node_modules/onnxruntime-web/dist/`;
  }
  return ort3;
}

// src/shared/constants.ts
var DETECTOR_MODEL_PATH = "models/comictextdetector.pt.onnx";
var DETECTOR_INPUT_SIZE = 1024;
var OCR_MODEL_PATH = "models/ppocr_v6_medium_rec.onnx";
var OCR_DICT_PATH = "models/ppocr_v6_dict.txt";
var OCR_INPUT_HEIGHT = 48;
var OCR_INPUT_WIDTH = 320;
var OCR_NORMALIZE = "minus_one";

// src/lib/rect.ts
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best = null;
  let bestArea = Infinity;
  for (let index = 0; index < hull.length; index += 1) {
    const a = hull[index];
    const b = hull[(index + 1) % hull.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of hull) {
      const x = point.x * cos + point.y * sin;
      const y = -point.x * sin + point.y * cos;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const area = width * height;
    if (area >= bestArea) continue;
    bestArea = area;
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    best = {
      centre: {
        x: centreX * cos - centreY * sin,
        y: centreX * sin + centreY * cos
      },
      length: width,
      thickness: height,
      angle: Math.atan2(Math.sin(angle), Math.cos(angle))
    };
  }
  return best;
}
function majorAxis(points) {
  if (points.length < 2) return null;
  let meanX = 0;
  let meanY = 0;
  for (const point of points) {
    meanX += point.x;
    meanY += point.y;
  }
  meanX /= points.length;
  meanY /= points.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  if (xx === 0 && yy === 0) return null;
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

// src/lib/detect/lines.ts
var LINE = 0.3;
var LINE_SCORE = 0.6;
var UNCLIP = 1.5;
var STROKE = 0.46;
var MIN_LINE_PIXELS = 20;
var MIN_STROKE_PIXELS = 12;
var MIN_SIDE = 3;
var UPRIGHT = 20 * Math.PI / 180;
var ALONG_GAP = 1.1;
var ACROSS_OVERLAP = 0.35;
var SIZE_RATIO = 2.5;
var CUT_EMPTY_SHARE = 0.15;
var CUT_MIN_RUN = 3;
var CUT_MIN_PIECE = 0.3;
function oddMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
function insidePrepared(prepared, x, y) {
  return x >= prepared.padX && y >= prepared.padY && x < prepared.padX + Math.round(prepared.width * prepared.scale) && y < prepared.padY + Math.round(prepared.height * prepared.scale);
}
function components(map, threshold, prepared) {
  const size = DETECTOR_INPUT_SIZE;
  const visited = new Uint8Array(size * size);
  const pixels = [];
  const stack = [];
  const out = [];
  for (let start = 0; start < size * size; start += 1) {
    if (map[start] < threshold || visited[start]) continue;
    if (!insidePrepared(prepared, start % size, Math.floor(start / size))) continue;
    stack.push(start);
    visited[start] = 1;
    pixels.length = 0;
    let count = 0;
    let sum = 0;
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    while (stack.length > 0) {
      const index = stack.pop();
      const x = index % size;
      const y = (index - x) / size;
      count += 1;
      sum += map[index];
      pixels.push(index);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!insidePrepared(prepared, nx, ny)) continue;
          const next = ny * size + nx;
          if (visited[next] || map[next] < threshold) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    out.push({
      pixels: [...pixels],
      count,
      sum,
      rect: { x0: minX, y0: minY, x1: maxX, y1: maxY }
    });
  }
  return out;
}
function boundaryPoints(component, map) {
  const size = DETECTOR_INPUT_SIZE;
  const inside = new Set(component.pixels);
  const points = [];
  for (const index of component.pixels) {
    const x = index % size;
    const y = (index - x) / size;
    let edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
    for (let dy = -1; dy <= 1 && !edge; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const next = (y + dy) * size + (x + dx);
        if (map[next] < LINE || !inside.has(next)) {
          edge = true;
          break;
        }
      }
    }
    if (edge) points.push({ x, y });
  }
  return points;
}
function mapToPage(prepared, value, axis) {
  const pad = axis === "x" ? prepared.padX : prepared.padY;
  return (value - pad) / prepared.scale;
}
function clampRect(rect, width, height) {
  return {
    x0: Math.max(0, rect.x0),
    y0: Math.max(0, rect.y0),
    x1: Math.min(width, rect.x1),
    y1: Math.min(height, rect.y1)
  };
}
function padRect(rect, pad, width, height) {
  return clampRect({
    x0: rect.x0 - pad,
    y0: rect.y0 - pad,
    x1: rect.x1 + pad,
    y1: rect.y1 + pad
  }, width, height);
}
function unionRect(rects) {
  if (rects.length === 0) return null;
  let rect = { ...rects[0] };
  for (let index = 1; index < rects.length; index += 1) {
    const other = rects[index];
    rect = {
      x0: Math.min(rect.x0, other.x0),
      y0: Math.min(rect.y0, other.y0),
      x1: Math.max(rect.x1, other.x1),
      y1: Math.max(rect.y1, other.y1)
    };
  }
  return rect;
}
function centreInside(rect, x, y, margin) {
  return x >= rect.x0 - margin && x <= rect.x1 + margin && y >= rect.y0 - margin && y <= rect.y1 + margin;
}
function foldedAngle(angle) {
  let folded = (angle % Math.PI + Math.PI) % Math.PI;
  if (folded > Math.PI / 2) folded -= Math.PI;
  if (folded > Math.PI / 4) folded -= Math.PI / 2;
  if (folded <= -Math.PI / 4) folded += Math.PI / 2;
  return Math.abs(folded) < UPRIGHT ? 0 : folded;
}
function cornersOf(centre, length, thickness, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfLength = length / 2;
  const halfThickness = thickness / 2;
  return [
    [-halfLength, -halfThickness],
    [halfLength, -halfThickness],
    [halfLength, halfThickness],
    [-halfLength, halfThickness]
  ].map(([along, across]) => ({
    x: centre.x + along * cos - across * sin,
    y: centre.y + along * sin + across * cos
  }));
}
function axisAlignedRect(points) {
  let rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const point of points) {
    rect = {
      x0: Math.min(rect.x0, point.x),
      y0: Math.min(rect.y0, point.y),
      x1: Math.max(rect.x1, point.x),
      y1: Math.max(rect.y1, point.y)
    };
  }
  return rect;
}
function boxFromQuad(centre, length, thickness, angle, score, width, height) {
  const corners = cornersOf(centre, length, thickness, angle);
  const rect = clampRect(axisAlignedRect(corners), width, height);
  const boxWidth = rect.x1 - rect.x0;
  const boxHeight = rect.y1 - rect.y0;
  if (boxWidth < 4 || boxHeight < 4) return null;
  const stored = foldedAngle(angle);
  if (stored === 0) {
    return { x: rect.x0, y: rect.y0, width: boxWidth, height: boxHeight, score };
  }
  return {
    x: rect.x0,
    y: rect.y0,
    width: boxWidth,
    height: boxHeight,
    score,
    angle: stored,
    lineLength: length,
    lineThickness: thickness
  };
}
function lineSeeds(det, prepared) {
  const found = [];
  for (const component of components(det, LINE, prepared)) {
    if (component.count < MIN_LINE_PIXELS) continue;
    const score = component.sum / component.count;
    if (score < LINE_SCORE) continue;
    const rect = minAreaRect(boundaryPoints(component, det));
    if (!rect) continue;
    const short = Math.min(rect.length, rect.thickness);
    if (short < 2) continue;
    const area = rect.length * rect.thickness;
    const perimeter = 2 * (rect.length + rect.thickness);
    const grow = area * UNCLIP / perimeter;
    const length = rect.length + grow * 2;
    const thickness = rect.thickness + grow * 2;
    const box = boxFromQuad(
      { x: mapToPage(prepared, rect.centre.x, "x"), y: mapToPage(prepared, rect.centre.y, "y") },
      length / prepared.scale,
      thickness / prepared.scale,
      rect.angle,
      score,
      prepared.width,
      prepared.height
    );
    if (box) found.push(box);
  }
  return found;
}
function splitAcrossPlaneGaps(box, plane, width, height, options) {
  if (box.angle !== void 0 && box.angle !== 0) return [box];
  const vertical = box.height >= box.width;
  const crossStart = vertical ? box.x : box.y;
  const crossSpan = Math.round(vertical ? box.width : box.height);
  const alongStart = vertical ? box.y : box.x;
  const alongSpan = vertical ? box.height : box.width;
  if (crossSpan < 24 || alongSpan < 24) return [box];
  const steps = Math.min(24, Math.max(8, Math.round(alongSpan / 8)));
  const profile = new Float32Array(crossSpan);
  let peak = 0;
  for (let index = 0; index < crossSpan; index += 1) {
    const across = crossStart + index + 0.5;
    let best = 0;
    for (let step = 0; step < steps; step += 1) {
      const along = alongStart + alongSpan * (step + 0.5) / steps;
      const value = vertical ? planeAt(plane, across, along) : planeAt(plane, along, across);
      if (value > best) best = value;
    }
    profile[index] = best;
    if (best > peak) peak = best;
  }
  if (peak < options.minPeak) return [box];
  const floor = peak * options.emptyShare;
  const cuts = [];
  let run = -1;
  for (let index = 0; index <= crossSpan; index += 1) {
    const blank = index < crossSpan && profile[index] <= floor;
    if (blank) {
      if (run < 0) run = index;
      continue;
    }
    if (run >= 0) {
      if (run > 0 && index < crossSpan && index - run >= options.minRun) {
        cuts.push(Math.round((run + index - 1) / 2));
      }
      run = -1;
    }
  }
  if (cuts.length === 0) return [box];
  const bounds = [0, ...cuts, crossSpan];
  const pieces = [];
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1];
    const to = bounds[index];
    if (to - from < Math.max(8, crossSpan * CUT_MIN_PIECE)) return [box];
    const padStart = from === 0 ? 1 : 0;
    const padEnd = to === crossSpan ? 1 : 0;
    const start = crossStart + from - padStart;
    const size = to - from + padStart + padEnd;
    pieces.push(vertical ? {
      ...box,
      x: Math.max(0, start),
      width: Math.min(width, start + size) - Math.max(0, start)
    } : {
      ...box,
      y: Math.max(0, start),
      height: Math.min(height, start + size) - Math.max(0, start)
    });
  }
  return pieces.length >= 2 ? pieces : [box];
}
function splitAcrossDetGaps(box, plane, width, height) {
  return splitAcrossPlaneGaps(box, plane, width, height, {
    minPeak: LINE,
    emptyShare: CUT_EMPTY_SHARE,
    minRun: CUT_MIN_RUN
  });
}
function splitAcrossStrokeGaps(box, plane, width, height) {
  return splitAcrossPlaneGaps(box, plane, width, height, {
    minPeak: STROKE / 2,
    emptyShare: 0.25,
    minRun: 2
  });
}
function strokeParts(seg, prepared) {
  const maxSide = Math.max(24, Math.min(prepared.width, prepared.height) * 0.45);
  const parts = [];
  for (const component of components(seg, STROKE, prepared)) {
    if (component.count < MIN_STROKE_PIXELS) continue;
    const rect = component.rect;
    const x0 = mapToPage(prepared, rect.x0, "x");
    const y0 = mapToPage(prepared, rect.y0, "y");
    const width = (rect.x1 - rect.x0 + 1) / prepared.scale;
    const height = (rect.y1 - rect.y0 + 1) / prepared.scale;
    if (Math.min(width, height) < MIN_SIDE) continue;
    if (Math.max(width, height) > maxSide) continue;
    parts.push({
      x0,
      y0,
      x1: x0 + width,
      y1: y0 + height,
      width,
      height,
      cx: x0 + width / 2,
      cy: y0 + height / 2
    });
  }
  return parts;
}
function overlapsAcross(a, b, vertical) {
  return vertical ? Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) : Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
}
function gapAlong(a, b, vertical) {
  return vertical ? Math.max(0, Math.max(b.y0 - a.y1, a.y0 - b.y1)) : Math.max(0, Math.max(b.x0 - a.x1, a.x0 - b.x1));
}
function widthOf(rect) {
  return rect.x1 - rect.x0;
}
function heightOf(rect) {
  return rect.y1 - rect.y0;
}
function extendToStrokes(start, strokes, claimed) {
  const vertical = heightOf(start) >= widthOf(start);
  let rect = { ...start };
  const members = [];
  while (true) {
    const thickness = vertical ? widthOf(rect) : heightOf(rect);
    const alongLimit = Math.max(8, thickness * ALONG_GAP);
    let best = -1;
    let bestGap = Infinity;
    for (let index = 0; index < strokes.length; index += 1) {
      if (claimed[index]) continue;
      const stroke2 = strokes[index];
      const across = overlapsAcross(rect, stroke2, vertical);
      if (across < Math.min(thickness, vertical ? stroke2.width : stroke2.height) * ACROSS_OVERLAP) continue;
      const cross = vertical ? stroke2.width : stroke2.height;
      if (cross > thickness * 2.2 || cross < thickness * 0.2) continue;
      const gap = gapAlong(rect, stroke2, vertical);
      if (gap > alongLimit) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    }
    if (best < 0) break;
    claimed[best] = 1;
    members.push(best);
    const stroke = strokes[best];
    rect = {
      x0: Math.min(rect.x0, stroke.x0),
      y0: Math.min(rect.y0, stroke.y0),
      x1: Math.max(rect.x1, stroke.x1),
      y1: Math.max(rect.y1, stroke.y1)
    };
  }
  return { rect, members };
}
function groupLeftoverStrokes(strokes, claimed) {
  const parent = strokes.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const similar = (a, b) => {
    const small = Math.min(a.width, a.height, b.width, b.height);
    const large = Math.max(a.width, a.height, b.width, b.height);
    return small > 0 && large / small <= SIZE_RATIO * 1.6;
  };
  for (let left = 0; left < strokes.length; left += 1) {
    if (claimed[left]) continue;
    for (let right = left + 1; right < strokes.length; right += 1) {
      if (claimed[right]) continue;
      const a = strokes[left];
      const b = strokes[right];
      if (!similar(a, b)) continue;
      const across = overlapsAcross(a, b, true);
      const gap = gapAlong(a, b, true);
      const limit = Math.max(6, Math.min(a.width, b.width) * 0.9);
      if (across >= Math.min(a.width, b.width) * 0.5 && gap <= limit) union(left, right);
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (let index = 0; index < strokes.length; index += 1) {
    if (claimed[index]) continue;
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket) bucket.push(index);
    else groups.set(root, [index]);
  }
  const singles = [...groups.values()].filter((group) => group.length === 1).map((group) => group[0]);
  for (let left = 0; left < singles.length; left += 1) {
    const a = strokes[singles[left]];
    for (let right = left + 1; right < singles.length; right += 1) {
      const b = strokes[singles[right]];
      if (!similar(a, b)) continue;
      const across = overlapsAcross(a, b, false);
      const gap = gapAlong(a, b, false);
      const limit = Math.max(6, Math.min(a.height, b.height) * 0.9);
      if (across >= Math.min(a.height, b.height) * 0.5 && gap <= limit) {
        union(singles[left], singles[right]);
      }
    }
  }
  const merged = /* @__PURE__ */ new Map();
  for (let index = 0; index < strokes.length; index += 1) {
    if (claimed[index]) continue;
    const root = find(index);
    const bucket = merged.get(root);
    if (bucket) bucket.push(index);
    else merged.set(root, [index]);
  }
  return [...merged.values()];
}
function overlapRatio(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const shared = (right - left) * (bottom - top);
  return shared / Math.min(a.width * a.height, b.width * b.height);
}
function samplePlane(plane, rect, samples = 16) {
  let sum = 0;
  let count = 0;
  for (let row = 0; row < samples; row += 1) {
    const y = rect.y + rect.height * (row + 0.5) / samples;
    for (let column = 0; column < samples; column += 1) {
      const x = rect.x + rect.width * (column + 0.5) / samples;
      sum += planeAt(plane, x, y);
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}
function planeAt(plane, pageX, pageY) {
  const x = Math.round(pageX * plane.scale + plane.padX);
  const y = Math.round(pageY * plane.scale + plane.padY);
  if (x < 0 || y < 0 || x >= DETECTOR_INPUT_SIZE || y >= DETECTOR_INPUT_SIZE) return 0;
  return plane.data[y * DETECTOR_INPUT_SIZE + x];
}
function extractLineBoxes(input) {
  const { det, seg, prepared, bubbles } = input;
  const width = prepared.width;
  const height = prepared.height;
  const pageArea = width * height;
  const detPlane = { data: det, scale: prepared.scale, padX: prepared.padX, padY: prepared.padY };
  const segPlane = seg ? { data: seg, scale: prepared.scale, padX: prepared.padX, padY: prepared.padY } : null;
  const seeds = lineSeeds(det, prepared).sort(
    (a, b) => b.width * b.height - a.width * a.height
  );
  const strokes = seg ? strokeParts(seg, prepared) : [];
  const claimed = new Uint8Array(strokes.length);
  const boxes = [];
  for (const seed of seeds) {
    const seedRect = {
      x0: seed.x,
      y0: seed.y,
      x1: seed.x + seed.width,
      y1: seed.y + seed.height
    };
    const members = [];
    for (let index = 0; index < strokes.length; index += 1) {
      if (claimed[index]) continue;
      if (!centreInside(seedRect, strokes[index].cx, strokes[index].cy, 2)) continue;
      members.push(index);
    }
    if (seed.angle !== void 0 && seed.angle !== 0) {
      for (const index of members) claimed[index] = 1;
      boxes.push(seed);
      continue;
    }
    const start = unionRect([
      seedRect,
      ...members.map((index) => strokes[index])
    ]);
    for (const index of members) claimed[index] = 1;
    const grown = extendToStrokes(start, strokes, claimed);
    const finalRect = padRect(grown.rect, 1, width, height);
    const boxWidth = finalRect.x1 - finalRect.x0;
    const boxHeight = finalRect.y1 - finalRect.y0;
    if (boxWidth < 4 || boxHeight < 4) continue;
    const line = {
      x: finalRect.x0,
      y: finalRect.y0,
      width: boxWidth,
      height: boxHeight,
      score: seed.score
    };
    boxes.push(...splitAcrossDetGaps(line, detPlane, width, height));
  }
  if (seg) {
    const thicknesses = boxes.map((box) => Math.min(box.width, box.height)).filter((size) => size >= 4).sort((left, right) => left - right);
    const median = oddMedian(thicknesses);
    for (const group of groupLeftoverStrokes(strokes, claimed)) {
      const rect = unionRect(group.map((index) => strokes[index]));
      if (!rect) continue;
      const padded = padRect(rect, 1, width, height);
      const box = {
        x: padded.x0,
        y: padded.y0,
        width: padded.x1 - padded.x0,
        height: padded.y1 - padded.y0,
        score: 0.6
      };
      if (box.width < 5 || box.height < 5) continue;
      if (box.width * box.height > pageArea * 0.25) continue;
      if (group.length < 2) continue;
      const long = Math.max(box.width, box.height);
      const short = Math.max(1, Math.min(box.width, box.height));
      if (median > 0 && (short > median * 4 || short < median * 0.35)) continue;
      if (boxes.some((other) => overlapRatio(box, other) > 0.35)) continue;
      const insideBalloon = bubbles.some(
        (bubble) => box.x + box.width / 2 >= bubble.x - 8 && box.x + box.width / 2 <= bubble.x + bubble.width + 8 && box.y + box.height / 2 >= bubble.y - 8 && box.y + box.height / 2 <= bubble.y + bubble.height + 8
      );
      if (!insideBalloon && long < short * 1.8) continue;
      const detMean = samplePlane(detPlane, box);
      if (!insideBalloon && detMean < 0.12) continue;
      boxes.push({ ...box, score: insideBalloon ? 0.55 : 0.6 });
    }
  }
  const separated = segPlane ? boxes.flatMap((box) => splitAcrossStrokeGaps(box, segPlane, width, height)) : boxes;
  const ranked = [...separated].sort((a, b) => b.width * b.height - a.width * a.height);
  const kept = [];
  for (const box of ranked) {
    if (kept.some((other) => overlapRatio(box, other) > 0.5)) continue;
    const paint = samplePlane(detPlane, box) + (segPlane ? samplePlane(segPlane, box) : 0);
    if (paint < 0.02) continue;
    kept.push(box);
  }
  return kept.sort((a, b) => Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x);
}

// src/lib/detect/inference.ts
import * as ort from "onnxruntime-web/webgpu";
ort.env.wasm.numThreads = 1;
var webgpu = typeof navigator !== "undefined" && "gpu" in navigator;
var sessionPromise = null;
function loadDetector() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(DETECTOR_MODEL_PATH), {
      executionProviders: webgpu ? ["webgpu", "wasm"] : ["wasm"],
      graphOptimizationLevel: "all"
    }).catch(async (cause) => {
      if (!webgpu) {
        sessionPromise = null;
        throw cause;
      }
      console.warn("WebGPU detector failed, using WASM.", cause);
      try {
        return await ort.InferenceSession.create(chrome.runtime.getURL(DETECTOR_MODEL_PATH), {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all"
        });
      } catch (fallbackCause) {
        sessionPromise = null;
        throw fallbackCause;
      }
    });
  }
  void sessionPromise.then(() => console.info(`Detector provider: ${webgpu ? "webgpu preferred" : "wasm"}`));
  return sessionPromise;
}
async function prepareInput(bitmap2) {
  const scale = Math.min(DETECTOR_INPUT_SIZE / bitmap2.width, DETECTOR_INPUT_SIZE / bitmap2.height);
  const drawWidth = Math.max(1, Math.round(bitmap2.width * scale));
  const drawHeight = Math.max(1, Math.round(bitmap2.height * scale));
  const padX = Math.floor((DETECTOR_INPUT_SIZE - drawWidth) / 2);
  const padY = Math.floor((DETECTOR_INPUT_SIZE - drawHeight) / 2);
  const canvas = new OffscreenCanvas(DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2d context is available.");
  context.fillStyle = "#000";
  context.fillRect(0, 0, DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE);
  context.drawImage(bitmap2, padX, padY, drawWidth, drawHeight);
  const { data } = context.getImageData(0, 0, DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE);
  const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
  const values = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    values[i] = data[i * 4] / 255;
    values[plane + i] = data[i * 4 + 1] / 255;
    values[plane * 2 + i] = data[i * 4 + 2] / 255;
  }
  return {
    tensor: new ort.Tensor("float32", values, [1, 3, DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE]),
    scale,
    padX,
    padY,
    width: bitmap2.width,
    height: bitmap2.height
  };
}
function pickDet(outputs) {
  const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
  const entries = Object.entries(outputs);
  const named = entries.find(([key]) => key.toLowerCase().includes("det"));
  const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;
  for (const [, value] of ordered) {
    if (!(value instanceof ort.Tensor) || !(value.data instanceof Float32Array)) continue;
    const dims = value.dims;
    if (dims.length !== 4 || dims[0] !== 1 || dims[1] < 1) continue;
    if (dims[2] !== DETECTOR_INPUT_SIZE || dims[3] !== DETECTOR_INPUT_SIZE) continue;
    if (value.data.length < plane) continue;
    return value.data.subarray(0, plane);
  }
  return null;
}
function pickSeg(outputs) {
  const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
  const entries = Object.entries(outputs);
  const named = entries.find(([key]) => key.toLowerCase().includes("seg"));
  const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;
  for (const [, value] of ordered) {
    if (!(value instanceof ort.Tensor) || !(value.data instanceof Float32Array)) continue;
    const dims = value.dims;
    if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) continue;
    if (value.data.length < plane) continue;
    return value.data.subarray(0, plane);
  }
  return null;
}
function pickBlk(outputs) {
  const byName = outputs.blk;
  if (byName && byName.dims.length === 3 && byName.dims[2] >= 6) return byName;
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 3 && value.dims[2] >= 6) return value;
  }
  return null;
}
function overlap(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const shared = (right - left) * (bottom - top);
  return shared / (a.width * a.height + b.width * b.height - shared);
}
function readBlocks(outputs, prepared) {
  const tensor = pickBlk(outputs);
  if (!tensor || !(tensor.data instanceof Float32Array)) return [];
  const rows = tensor.dims[1] ?? 0;
  const cols = tensor.dims[2] ?? 0;
  if (rows <= 0 || cols < 6) return [];
  const data = tensor.data;
  const candidates2 = [];
  for (let row = 0; row < rows; row += 1) {
    const base = row * cols;
    const centreX = data[base];
    const centreY = data[base + 1];
    const width = data[base + 2];
    const height = data[base + 3];
    const objectness = data[base + 4];
    if (!Number.isFinite(centreX + centreY + width + height + objectness)) continue;
    let best = 1;
    for (let column = 5; column < cols; column += 1) {
      best = Math.max(best, data[base + column]);
    }
    const score = objectness * best;
    if (score < 0.35) continue;
    if (width < 6 || height < 6) continue;
    const x = (centreX - width / 2 - prepared.padX) / prepared.scale;
    const y = (centreY - height / 2 - prepared.padY) / prepared.scale;
    const boxWidth = width / prepared.scale;
    const boxHeight = height / prepared.scale;
    if (boxWidth < 6 || boxHeight < 6) continue;
    if (boxWidth * boxHeight > prepared.width * prepared.height * 0.25) continue;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(prepared.width, x + boxWidth);
    const bottom = Math.min(prepared.height, y + boxHeight);
    if (right - left < 6 || bottom - top < 6) continue;
    candidates2.push({ x: left, y: top, width: right - left, height: bottom - top, score });
  }
  candidates2.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of candidates2) {
    if (kept.some((other) => overlap(candidate, other) >= 0.35)) continue;
    kept.push(candidate);
    if (kept.length >= 96) break;
  }
  return kept;
}
async function runDetector(bitmap2) {
  const session = await loadDetector();
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error("The detector exposes no input.");
  const prepared = await prepareInput(bitmap2);
  const outputs = await session.run({ [inputName]: prepared.tensor });
  const det = pickDet(outputs);
  if (!det) throw new Error("The detector returned no score map.");
  return { det, seg: pickSeg(outputs), blocks: readBlocks(outputs, prepared), prepared };
}

// src/lib/detect/index.ts
async function detectLines(bitmap2, bubbles = [], options = {}) {
  const { det, seg, blocks, prepared } = await runDetector(bitmap2);
  const letterbox = { scale: prepared.scale, padX: prepared.padX, padY: prepared.padY };
  const mask = seg ? { data: seg, ...letterbox } : null;
  return {
    detBoxes: options.lines === false ? [] : extractLineBoxes({ det, seg, prepared, bubbles }),
    blkBoxes: blocks,
    mask,
    det: { data: det, ...letterbox }
  };
}

// src/lib/mask.ts
var MODEL_SIZE = 1024;

// src/lib/ocr/recognize.ts
import * as ort2 from "onnxruntime-web/webgpu";

// src/lib/ocr/charset.ts
var charsetPromise = null;
function loadCharset(url) {
  if (!charsetPromise) {
    charsetPromise = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`The charset request failed with ${response.status}.`);
      return response.text();
    }).then((text) => {
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return ["", ...lines, " "];
    }).catch((cause) => {
      charsetPromise = null;
      throw cause;
    });
  }
  return charsetPromise;
}

// src/lib/ocr/decode.ts
var BLANK = 0;
function decodeCtc(logits, timeSteps, classes, charset) {
  const tokens = [];
  const kept = [];
  let previous = -1;
  for (let step = 0; step < timeSteps; step += 1) {
    let best = 0;
    let bestScore = logits[step * classes];
    for (let index = 1; index < classes; index += 1) {
      const score = logits[step * classes + index];
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best === BLANK) {
      previous = -1;
      continue;
    }
    if (best === previous) continue;
    tokens.push(best);
    kept.push(bestScore);
    previous = best;
  }
  const text = tokens.map((token) => charset[token] ?? "").join("");
  const confidence = kept.length === 0 ? 0 : Math.exp(kept.reduce((sum, score) => sum + Math.log(Math.max(score, 1e-10)), 0) / kept.length);
  return { text, confidence };
}

// src/lib/warp.ts
function angleOf(box) {
  return box.angle ?? 0;
}
function cropSize(box) {
  const angle = angleOf(box);
  if (Math.abs(angle) < 0.01) {
    return { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) };
  }
  const length = box.lineLength ?? box.width;
  const thickness = box.lineThickness ?? box.height;
  const tall = box.height >= box.width;
  return tall ? { width: Math.max(1, Math.round(thickness)), height: Math.max(1, Math.round(length)) } : { width: Math.max(1, Math.round(length)), height: Math.max(1, Math.round(thickness)) };
}
function uprightFrame(box) {
  const angle = angleOf(box);
  const { width, height } = cropSize(box);
  return {
    centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    along: { x: Math.cos(angle), y: Math.sin(angle) },
    across: { x: -Math.sin(angle), y: Math.cos(angle) },
    width,
    height
  };
}
function drawUpright(context, bitmap2, box, width, height) {
  const frame = uprightFrame(box);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(-angleOf(box));
  context.translate(-frame.centre.x, -frame.centre.y);
  context.drawImage(bitmap2, 0, 0);
  context.restore();
}

// src/lib/ocr/prepare.ts
function buildOcrInput(bitmap2, box, vertical) {
  const size = cropSize(box);
  const thickness = vertical ? size.width : size.height;
  const length = vertical ? size.height : size.width;
  const scale = OCR_INPUT_HEIGHT / Math.max(1, thickness);
  const rawWidth = Math.max(1, Math.round(length * scale));
  const width = Math.min(OCR_INPUT_WIDTH, Math.ceil(rawWidth / 32) * 32);
  const contentWidth = Math.min(width, rawWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = OCR_INPUT_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser refused a 2D context for the crop.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, OCR_INPUT_HEIGHT);
  const upright = document.createElement("canvas");
  upright.width = Math.max(1, Math.round(size.width));
  upright.height = Math.max(1, Math.round(size.height));
  const uprightContext = upright.getContext("2d");
  if (!uprightContext) throw new Error("The browser refused a 2D context for the upright crop.");
  drawUpright(uprightContext, bitmap2, box, upright.width, upright.height);
  if (vertical) {
    context.translate(0, OCR_INPUT_HEIGHT);
    context.rotate(-Math.PI / 2);
    context.drawImage(upright, 0, 0, upright.width, upright.height, 0, 0, OCR_INPUT_HEIGHT, contentWidth);
  } else {
    context.drawImage(upright, 0, 0, upright.width, upright.height, 0, 0, contentWidth, OCR_INPUT_HEIGHT);
  }
  const pixels = context.getImageData(0, 0, width, OCR_INPUT_HEIGHT).data;
  const plane = width * OCR_INPUT_HEIGHT;
  const data = new Float32Array(3 * plane);
  const offsetBase = OCR_NORMALIZE === "minus_one" ? 127.5 : 255;
  const shift = OCR_NORMALIZE === "minus_one" ? 1 : 0;
  for (let index = 0; index < plane; index += 1) {
    const offset = index * 4;
    data[index] = pixels[offset] / offsetBase - shift;
    data[plane + index] = pixels[offset + 1] / offsetBase - shift;
    data[2 * plane + index] = pixels[offset + 2] / offsetBase - shift;
  }
  return { data, dims: [1, 3, OCR_INPUT_HEIGHT, width], width };
}

// src/lib/ocr/recognize.ts
var webgpu2 = typeof navigator !== "undefined" && "gpu" in navigator;
var sessionPromise2 = null;
function loadSession() {
  if (!sessionPromise2) {
    sessionPromise2 = ort2.InferenceSession.create(chrome.runtime.getURL(OCR_MODEL_PATH), {
      executionProviders: webgpu2 ? ["webgpu", "wasm"] : ["wasm"],
      graphOptimizationLevel: "all"
    }).catch(async (cause) => {
      if (!webgpu2) {
        sessionPromise2 = null;
        throw cause;
      }
      console.warn("WebGPU OCR failed, using WASM.", cause);
      try {
        return await ort2.InferenceSession.create(chrome.runtime.getURL(OCR_MODEL_PATH), {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all"
        });
      } catch (fallbackCause) {
        sessionPromise2 = null;
        throw fallbackCause;
      }
    });
  }
  void sessionPromise2.then(() => console.info(`OCR provider: ${webgpu2 ? "webgpu preferred" : "wasm"}`));
  return sessionPromise2;
}
async function recognizeLine(bitmap2, box, vertical) {
  const [session, charset] = await Promise.all([
    loadSession(),
    loadCharset(chrome.runtime.getURL(OCR_DICT_PATH))
  ]);
  const input = buildOcrInput(bitmap2, box, vertical);
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error("The recogniser exposes no input.");
  const tensor = new ort2.Tensor("float32", input.data, input.dims);
  const outputs = await session.run({ [inputName]: tensor });
  const first = Object.values(outputs)[0];
  if (!first || !(first.data instanceof Float32Array)) throw new Error("The recogniser returned no logits.");
  const dims = first.dims;
  const timeSteps = dims[dims.length - 2] ?? 0;
  const classes = dims[dims.length - 1] ?? 0;
  return decodeCtc(first.data, timeSteps, classes, charset);
}

// src/lib/ocr/blockHints.ts
var GLYPHS_PER_COLUMN = 8;
function blockInk(mask, block) {
  const inset = 1;
  const width = Math.ceil(block.width * mask.scale) + 2;
  const height = Math.ceil(block.height * mask.scale) + 2;
  const originX = Math.floor(block.x * mask.scale + mask.padX) - inset;
  const originY = Math.floor(block.y * mask.scale + mask.padY) - inset;
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (originY + y) * MODEL_SIZE + (originX + x);
      ink[y * width + x] = (mask.data[at] ?? 0) > 0.25 ? 1 : 0;
    }
  }
  const seen = new Uint8Array(width * height);
  const points = [];
  for (let start = 0; start < width * height; start += 1) {
    if (ink[start] === 0 || seen[start] === 1) continue;
    const stack = [start];
    seen[start] = 1;
    const cells = [];
    let touchesEdge = false;
    while (stack.length > 0) {
      const at = stack.pop();
      const x = at % width;
      const y = (at - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      cells.push(at);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (ink[next] === 1 && seen[next] === 0) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (touchesEdge) continue;
    if (cells.length < 4 || cells.length > 900) continue;
    for (const at of cells) {
      const x = at % width;
      const y = (at - x) / width;
      points.push({
        x: (originX + x - mask.padX) / mask.scale,
        y: (originY + y - mask.padY) / mask.scale
      });
    }
  }
  return points;
}
function bandsOf(points, columns, lean) {
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  const across = points.map((point) => point.x * cos + point.y * sin);
  const along = points.map((point) => -point.x * sin + point.y * cos);
  const from = Math.min(...across);
  const to = Math.max(...across);
  const step = (to - from) / columns;
  const bands = [];
  for (let index = 0; index < columns; index += 1) {
    const low = from + step * index;
    const high = low + step;
    let alongFrom = Number.POSITIVE_INFINITY;
    let alongTo = Number.NEGATIVE_INFINITY;
    across.forEach((value, at) => {
      if (value < low || value > high) return;
      alongFrom = Math.min(alongFrom, along[at]);
      alongTo = Math.max(alongTo, along[at]);
    });
    if (!(alongTo > alongFrom)) continue;
    const acrossCentre = (low + high) / 2;
    const alongCentre = (alongFrom + alongTo) / 2;
    const thickness = high - low;
    const length = alongTo - alongFrom;
    bands.push({
      x: acrossCentre * cos - alongCentre * sin - thickness / 2,
      y: acrossCentre * sin + alongCentre * cos - length / 2,
      width: thickness,
      height: length
    });
  }
  return bands;
}
async function readBand(bitmap2, band, lean) {
  const height = Math.max(1, band.height);
  const crop = {
    x: band.x,
    y: band.y,
    width: band.width,
    height,
    score: 1,
    angle: lean,
    lineLength: height,
    lineThickness: band.width
  };
  return recognizeLine(bitmap2, crop, true).catch(() => ({ text: "", confidence: 0 }));
}
function scoreOf(lines) {
  let total = 0;
  for (const line of lines) {
    const glyphs = [...line.text].length;
    if (glyphs === 0) continue;
    const fits = line.length / Math.max(1, line.width);
    if (glyphs > fits * 1.2 + 1) {
      total -= 0.5;
      continue;
    }
    total += line.confidence >= 0.5 ? line.confidence : -0.4;
  }
  return total / Math.max(1, lines.length);
}
function extentOf(points, lean) {
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  const across = points.map((point) => point.x * cos + point.y * sin);
  return Math.max(...across) - Math.min(...across);
}
async function readBlockHint(bitmap2, block, mask) {
  if (!mask) return null;
  const points = blockInk(mask, block);
  if (points.length < 40) return null;
  const axis = majorAxis(points);
  const groupLean = axis === null ? 0 : axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2;
  const glyph = Math.max(12, block.height / GLYPHS_PER_COLUMN);
  const across = extentOf(points, groupLean);
  if (!(across > 0)) return null;
  const widest = Math.max(1, Math.min(4, Math.round(across / glyph)));
  if (widest === 1) {
    const bands = bandsOf(points, 1, groupLean);
    const line = bands[0];
    if (!line) return null;
    const result = await readBand(bitmap2, line, groupLean);
    return { lines: [{ text: result.text, confidence: result.confidence, box: line }], lean: groupLean, columns: 1 };
  }
  const readCut = async (columns, lean) => {
    const readings = [];
    for (const band of bandsOf(points, columns, lean)) {
      const result = await readBand(bitmap2, band, lean);
      readings.push({ text: result.text, confidence: result.confidence, box: band });
    }
    return { lines: readings, lean, columns };
  };
  const scoreOfCut = (cut) => scoreOf(cut.lines.map((line) => ({
    text: line.text,
    confidence: line.confidence,
    width: line.box.width,
    length: line.box.height
  })));
  let best = await readCut(widest, groupLean);
  let bestScore = scoreOfCut(best);
  for (const degrees of [-16, -8, 0, 8, 16]) {
    if (Math.abs(degrees - best.lean * 180 / Math.PI) < 0.01) continue;
    const cut = await readCut(widest, degrees * Math.PI / 180);
    const score = scoreOfCut(cut);
    if (score > bestScore) {
      best = cut;
      bestScore = score;
    }
  }
  const shaky = best.lines.some((line) => line.text.trim().length === 0 || line.confidence < 0.7);
  if (shaky && widest > 2) {
    const cut = await readCut(widest - 1, best.lean);
    if (scoreOfCut(cut) > bestScore) {
      best = cut;
      bestScore = scoreOfCut(cut);
    }
  }
  best.lines.sort((left, right) => right.box.x + right.box.width / 2 - (left.box.x + left.box.width / 2));
  return best;
}

// .dsh/tmp/probe-hint2.mjs
await prepareOrt();
var bitmap = await loadImage("fixtures/page-forty.jpg");
var detected = await detectLines(bitmap, []);
var started = Date.now();
for (const blk of detected.blkBoxes) {
  const hint = await readBlockHint(bitmap, blk, detected.mask);
  console.log(`blk ${blk.x.toFixed(0)},${blk.y.toFixed(0)} ${blk.width.toFixed(0)}x${blk.height.toFixed(0)}`, hint ? `cols ${hint.columns} lean ${(hint.lean * 180 / Math.PI).toFixed(1)} :: ` + hint.lines.map((l) => `"${l.text}"(${l.confidence.toFixed(2)})`).join(" | ") : "no hint");
}
console.log("ms", Date.now() - started);
