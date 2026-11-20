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

// src/lib/ocr/recognize.ts
import * as ort2 from "onnxruntime-web/webgpu";
var webgpu2 = typeof navigator !== "undefined" && "gpu" in navigator;

// src/lib/mask.ts
var MODEL_SIZE = 1024;

// src/lib/ocr/cloudOcr.ts
var TRANSCRIBE_PROMPT = [
  "The image is a crop of a Japanese comic, shown in the orientation it has on the page.",
  "A crop usually holds one text line. Vertical Japanese reads top to bottom with the columns running right to left; horizontal Japanese reads left to right, top to bottom.",
  "A crop can hold several parallel text lines when one detection box covered more than one column. Report each one separately, in reading order.",
  "Transcribe the text exactly as printed.",
  "Keep small kana (\u3063 \u3083 \u3085 \u3087 \u3041 \u3043 \u3045 \u3047 \u3049 \u30FC), dakuten and handakuten, punctuation (\u3001\u3002\u300C\u300D\u300E\u300F\u2026\uFF01\uFF1F), Latin letters, digits and symbols.",
  "Do not translate, do not explain, do not add spaces, and do not convert full-width characters to half-width or the reverse.",
  "Never complete a word from context: transcribe only the glyphs that are visible.",
  "row is the 1-based position of the line in reading order. columns is the number of parallel character columns that line itself holds, which is 1 for a normal line.",
  'Return JSON only: {"lines":[{"row":1,"columns":1,"text":"\u2026"}]}'
].join(" ");
var REGION_EXAMPLE = {
  text: "\u2026",
  type: "chat",
  direction: "v",
  // How far the line leans, clockwise from upright, and the size of one
  // character in page pixels. Both are required: a leaned line drawn upright
  // is the one thing the reader cannot leave to a box edge.
  lean: 0,
  em: 24,
  // The number printed on the blue rectangle that holds the line. The page
  // box follows, for a crop whose numbers cannot be read.
  box: 2,
  x: 268,
  y: 412,
  width: 27,
  height: 162
};
var BLOCK_EXAMPLE = { regions: [REGION_EXAMPLE] };
var BLOCK_PROMPT = [
  "The image is a crop of one region of a Japanese comic page: a speech balloon, a caption, or a sound effect.",
  "Report one entry per text line, in reading order. A vertical column is one entry, a horizontal row is one entry. Never merge two columns or two rows into one entry, even when they form one sentence: each entry carries only the characters printed in its own column.",
  "One entry is one run of characters printed at one size. If a block mixes sizes, split it by size, not by row: a name box printed as a small \u4FEE\u58EB1\u5E74 followed by a large \u6709\u7559\u6728 \u5186 is two entries, each with its own box, and a large heading above a small caption is two entries for the same reason.",
  "Furigana is not text. The small kana printed beside or above kanji to show how it is read are never an entry, never part of text, never a box, and never a field of their own. The test is size: furigana characters are clearly smaller than the characters of the line they belong to, so a small column sitting inside or beside a large column is a reading, and the entry is the large characters only.",
  "Blue rectangles mark the text of this block, as the detector found it. Text inside a blue rectangle is the only text to read: report those lines. Anything outside every blue rectangle is artwork or handwriting, so it is not a line, never goes into text, and never has an entry of its own. A formula, a scribbled number, an arrow or a signature drawn by hand is ignored completely, even when it runs beside a column or through the gap between columns. A column stays inside its own blue rectangle.",
  "text: exactly as printed, with small kana, dakuten, punctuation, Latin letters and digits. Never complete a word from context.",
  "Do not translate: this answer is read only. A separate request translates the text once the whole block has been read.",
  "A grid is drawn over the image and every line of it carries its page coordinate: thin lines mark single cells, a thicker line marks every fifth. The numbers along the top edge are blue and are the x of that line in page pixels; the numbers along the left edge are red and are its y. They are absolute page pixels, not a count: a line printed 1035 is x 1035 on the page, wherever the crop starts. A small grey number beside every fifth coordinate is the cell index, which you do not need.",
  "A reading can sit inside a blue rectangle, in the gap between the large characters and the box edge. It is still not a line: the entry covers the large characters, its box stays on the large characters, and the reading is left out of text. Never report it in any field. Small kana that belong to the word itself, such as the \u3063 in \u3044\u3063\u3066, are part of the word and stay.",
  'type: "chat" for dialogue, including a short \u306F\u3044, \u3046\u3093, \u3048\u3048, \u305D\u3046, \u3042\u3042, \u3044\u3048, \u3044\u3084 and a line that starts with an ellipsis. "name" for a box that holds a name, a title, a place name or a label and no sentence: \u6709\u7559\u6728 \u74B0 is a name, and so is a lone \u5186 printed with its reading \u3064\u3076\u3089 beside it. "sfx" for onomatopoeia and sound effects such as \u30C9\u30C9\u30C9, \u30B4\u30B4\u30B4, \u30B6\u30EF\u30B6\u30EF, \u30C9\u30F3, \u30D0\u30F3, \u30AC\u30B7\u30E3.',
  'direction: "v" when the line reads top to bottom, "h" when it reads left to right. A leaned line is still "v" or "h": do not use another letter for it.',
  "lean: for a leaned line, how far it is rotated clockwise from upright, in degrees between -45 and 45. A vertical line is upright when it runs straight down; if the bottom of the column leans left, lean is positive (for example 12). A horizontal line is upright when it runs left to right; if its right end rises, lean is negative. Every entry must carry lean; give 0 when the line is upright.",
  "em: the size of one character in page pixels, measured across the glyph itself (its width and height are about equal), not the gap between columns and not the whole box. Read it from the grid lines. Every entry must carry em, even when the line is upright.",
  "angle: the old name for lean, kept only for a horizontal line measured from the horizontal axis. Prefer lean; do not send both.",
  "box: the number printed in green at the top left corner of the blue rectangle that holds this line. This is the position that matters: the rectangle is where the ink is, so naming it is exact. If one entry covers more than one rectangle, give their numbers in reading order, as an array, e.g. [3,2].",
  "x and y: only when no number is visible. The page pixel of the top left corner of the line, read from the numbers on the grid: an edge a few pixels past the line printed 1035 is 1037, and one a few pixels above the line printed 140 is 137. width and height: the size of the box in page pixels, from the same numbers.",
  "The box is tight around that line. For a vertical line width is the width of one character and height runs from the top of the first character to the bottom of the last; for a horizontal line height is one character and width is the length of the run. A character is about as many pixels across as it is down, so six characters of a 27 pixel character are about 162 pixels tall. Measure the character you see, not the gap between two grid lines.",
  "Do not round a corner to a grid line and do not count cells: answer with the pixels the number reads, so a character whose left edge is a few pixels past the line printed 1034 has x 1037. x, y, width and height are whole pixels. When an edge is cut off by the crop, still give the page pixel of the visible ink.",
  `The numbers in the example show the shape of the answer, not this crop. Skip artwork with no text. Return JSON only: ${JSON.stringify(BLOCK_EXAMPLE)}`
].join(" ");
function leanOfBox(mask, box, direction) {
  if (!mask) return void 0;
  const x0 = Math.max(0, Math.floor(box.x * mask.scale + mask.padX));
  const y0 = Math.max(0, Math.floor(box.y * mask.scale + mask.padY));
  const x1 = Math.min(MODEL_SIZE - 1, Math.ceil((box.x + box.width) * mask.scale + mask.padX));
  const y1 = Math.min(MODEL_SIZE - 1, Math.ceil((box.y + box.height) * mask.scale + mask.padY));
  if (x1 <= x0 || y1 <= y0) return void 0;
  const points = [];
  for (let my = y0; my <= y1; my += 1) {
    for (let mx = x0; mx <= x1; mx += 1) {
      if (mask.data[my * MODEL_SIZE + mx] < 0.3) continue;
      points.push({ x: (mx - mask.padX) / mask.scale, y: (my - mask.padY) / mask.scale });
      if (points.length >= 4e4) break;
    }
    if (points.length >= 4e4) break;
  }
  if (points.length < 24) return void 0;
  const axis = majorAxis(points);
  if (axis === null) return void 0;
  const lean = direction === "v" ? axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2 : axis;
  if (!Number.isFinite(lean) || Math.abs(lean) > Math.PI / 4) return void 0;
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  const across = points.map((point) => direction === "v" ? point.x * cos - point.y * sin : -point.x * sin + point.y * cos).sort((left, right) => left - right);
  const thickness = across[Math.floor(across.length * 0.75)] - across[Math.floor(across.length * 0.25)];
  return { lean, thickness: Number.isFinite(thickness) && thickness >= 4 ? thickness : 0 };
}
function tightBounds(centreX, centreY, length, thickness, angle, direction) {
  const width = direction === "v" ? thickness : length;
  const height = direction === "v" ? length : thickness;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  return {
    x: centreX - (width * cos + height * sin) / 2,
    y: centreY - (width * sin + height * cos) / 2,
    width: width * cos + height * sin,
    height: width * sin + height * cos
  };
}
function applyInclination(regions2, boxes, mask) {
  if (regions2.length === 0) return;
  const byBox = /* @__PURE__ */ new Map();
  for (const region of regions2) {
    const id = (region.boxIds ?? []).find((value) => value >= 1 && value <= boxes.length);
    if (id === void 0) continue;
    const list = byBox.get(id);
    if (list) list.push(region);
    else byBox.set(id, [region]);
  }
  const claimed = /* @__PURE__ */ new Set();
  for (const [id, group] of byBox) {
    group.forEach((region) => claimed.add(region));
    const box = boxes[id - 1];
    const direction = group[0].direction;
    const measured = leanOfBox(mask, box, direction);
    const groupLean = measured?.lean ?? 0;
    if (measured === void 0 || Math.abs(groupLean) < 0.5 * Math.PI / 180) {
      group.forEach((region) => {
        region.angle = void 0;
      });
      continue;
    }
    const acrossStart = direction === "v" ? box.x : box.y;
    const acrossSize = direction === "v" ? box.width : box.height;
    const alongStart = direction === "v" ? box.y : box.x;
    const alongSize = direction === "v" ? box.height : box.width;
    const ordered = [...group].sort((left, right) => {
      const ownLeft = left.own ?? left;
      const ownRight = right.own ?? right;
      const acrossOf = (item) => direction === "v" ? item.x + item.width / 2 : item.y + item.height / 2;
      return direction === "v" ? acrossOf(ownRight) - acrossOf(ownLeft) : acrossOf(ownLeft) - acrossOf(ownRight);
    });
    const band = acrossSize / ordered.length;
    ordered.forEach((region, index) => {
      const centreAcross = direction === "v" ? acrossStart + acrossSize - band * (index + 0.5) : acrossStart + band * (index + 0.5);
      const centreAlong = alongStart + alongSize / 2;
      const lean = groupLean;
      const cos = Math.max(0.5, Math.cos(lean));
      const length = alongSize / cos;
      const inkEm = measured?.thickness && measured.thickness >= 4 ? measured.thickness : void 0;
      const reportedEm = region.glyphSize && region.glyphSize >= 4 ? region.glyphSize : void 0;
      const em = ordered.length === 1 ? Math.max(reportedEm ?? 0, (inkEm ?? 0) * 0.6) || band : Math.min(reportedEm ?? band, inkEm ?? band, band);
      const thickness = Math.max(4, Math.min(em, band * 0.95));
      const bounds = tightBounds(centreAcross, centreAlong, length, thickness, lean, direction);
      region.x = bounds.x;
      region.y = bounds.y;
      region.width = bounds.width;
      region.height = bounds.height;
      region.angle = lean;
      region.lineLength = length;
      region.lineThickness = thickness;
      region.glyphSize = thickness;
      region.frame = { ...bounds };
    });
  }
  for (const region of regions2) {
    if (claimed.has(region)) continue;
    const own = region.own ?? region;
    const measured = leanOfBox(mask, own, region.direction);
    if (!measured || Math.abs(measured.lean) < 0.5 * Math.PI / 180) {
      region.angle = void 0;
      continue;
    }
    const lean = measured.lean;
    const length = (region.direction === "v" ? own.height : own.width) / Math.max(0.5, Math.cos(lean));
    const em = region.glyphSize && region.glyphSize >= 4 ? Math.min(region.glyphSize, measured.thickness || region.glyphSize) : measured.thickness || (region.direction === "v" ? own.width : own.height);
    const thickness = Math.max(4, Math.min(em, (region.direction === "v" ? own.width : own.height) * 0.95));
    const bounds = tightBounds(
      own.x + own.width / 2,
      own.y + own.height / 2,
      length,
      thickness,
      lean,
      region.direction
    );
    region.x = bounds.x;
    region.y = bounds.y;
    region.width = bounds.width;
    region.height = bounds.height;
    region.angle = lean;
    region.lineLength = length;
    region.lineThickness = thickness;
    region.glyphSize = thickness;
    region.frame = { ...bounds };
  }
}

// .dsh/tmp/probe-leanband.mjs
await prepareOrt();
var bitmap = await loadImage("fixtures/page-forty.jpg");
var detected = await detectLines(bitmap, []);
var bands = [325, 348, 371].map((x, i) => ({ x, y: 580, width: 22, height: 150, heightOk: true }));
var regions = bands.map((b, i) => ({ x: b.x, y: b.y, width: b.width, height: b.height, text: `r${i}`, direction: "v", columns: 1, rows: 1, kind: "chat" }));
applyInclination(regions, [], detected.mask);
for (const r of regions) console.log("band", r.x.toFixed(0), "angle", r.angle === void 0 ? "none" : (r.angle * 180 / Math.PI).toFixed(2), "glyph", r.glyphSize?.toFixed(1), "len", r.lineLength?.toFixed(0));
var whole = [{ x: 312, y: 582, width: 78, height: 155, text: "w", direction: "v", columns: 1, rows: 1, kind: "chat" }];
applyInclination(whole, [], detected.mask);
console.log("whole angle", whole[0].angle === void 0 ? "none" : (whole[0].angle * 180 / Math.PI).toFixed(2), "glyph", whole[0].glyphSize?.toFixed(1));
