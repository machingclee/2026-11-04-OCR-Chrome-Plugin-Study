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
function readApiKey() {
  const fromEnvironment = process.env.DEEPSEEK_API_KEY ?? process.env.VITE_DEEPSEEK_API_KEY;
  if (fromEnvironment && fromEnvironment.trim().length > 0) return fromEnvironment.trim();
  try {
    const text = readFileSync(`${ROOT}/.env`, "utf8");
    const value = text.match(/^\s*(?:VITE_)?DEEPSEEK_API_KEY\s*=\s*(.*)$/m)?.[1]?.trim() ?? "";
    return value.replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
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
  const inside2 = new Set(component.pixels);
  const points = [];
  for (const index of component.pixels) {
    const x = index % size;
    const y = (index - x) / size;
    let edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
    for (let dy = -1; dy <= 1 && !edge; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const next = (y + dy) * size + (x + dx);
        if (map[next] < LINE || !inside2.has(next)) {
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
  const similar2 = (a, b) => {
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
      if (!similar2(a, b)) continue;
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
      if (!similar2(a, b)) continue;
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
  const named = entries.find(([key2]) => key2.toLowerCase().includes("det"));
  const ordered = named ? [named, ...entries.filter(([key2]) => key2 !== named[0])] : entries;
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
  const named = entries.find(([key2]) => key2.toLowerCase().includes("seg"));
  const ordered = named ? [named, ...entries.filter(([key2]) => key2 !== named[0])] : entries;
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

// src/lib/ocr/grid.ts
var GRID_CELL = 4;
var CELLS_LONG = 120;
var CELL_SPACING = 20;
var MAJOR_EVERY = 5;
function gridCell(crop, scale) {
  const long = Math.max(1, Math.max(crop.width, crop.height));
  const room = Math.round(CELL_SPACING / Math.max(0.1, scale));
  const span = Math.round(long / CELLS_LONG);
  return Math.max(GRID_CELL, room, span);
}
function gridGeometry(crop, cell) {
  return {
    cell,
    columns: Math.max(1, Math.floor(crop.width / cell)),
    rows: Math.max(1, Math.floor(crop.height / cell))
  };
}
function cellToPage(crop, cell, box) {
  return {
    x: crop.x + box.x * cell,
    y: crop.y + box.y * cell,
    width: box.width * cell,
    height: box.height * cell
  };
}
var MINOR = "rgba(15, 23, 42, 0.18)";
var MAJOR = "rgba(15, 23, 42, 0.45)";
var COLUMN_INK = "#1d4ed8";
var ROW_INK = "#b91c1c";
var INDEX_INK = "#6b7280";
function paintGrid(context, width, height, geometry, scale, origin) {
  const { cell, columns, rows } = geometry;
  const at = (index) => Math.round(index * cell * scale);
  const edge = Math.max(1, Math.round(cell * scale * 0.07));
  const major = Math.max(edge + 1, Math.round(cell * scale * 0.14));
  context.save();
  for (let index = 0; index <= columns; index += 1) {
    const x = at(index);
    if (x > width) break;
    context.lineWidth = index % MAJOR_EVERY === 0 ? major : edge;
    context.strokeStyle = index % MAJOR_EVERY === 0 ? MAJOR : MINOR;
    context.beginPath();
    context.moveTo(x + 0.5, 0);
    context.lineTo(x + 0.5, height);
    context.stroke();
  }
  for (let index = 0; index <= rows; index += 1) {
    const y = at(index);
    if (y > height) break;
    context.lineWidth = index % MAJOR_EVERY === 0 ? major : edge;
    context.strokeStyle = index % MAJOR_EVERY === 0 ? MAJOR : MINOR;
    context.beginPath();
    context.moveTo(0, y + 0.5);
    context.lineTo(width, y + 0.5);
    context.stroke();
  }
  const size = Math.max(8, Math.min(11, Math.round(cell * scale * 0.5)));
  const indexSize = Math.max(6, Math.min(8, Math.round(size * 0.8)));
  const row = size + 3;
  context.textBaseline = "top";
  context.textAlign = "left";
  const chip = (text, left, top, ink, font) => {
    context.font = font;
    const room = context.measureText(text).width;
    context.fillStyle = "rgba(255, 255, 255, 0.9)";
    context.fillRect(left - 1, top - 1, room + 4, size + 2);
    context.fillStyle = ink;
    context.fillText(text, left + 1, top);
  };
  for (let index = 0; index <= columns; index += 1) {
    const x = at(index);
    if (x > width - 1) break;
    const label = String(Math.round(origin.x + index * cell));
    const room = context.measureText(label).width;
    const left = Math.min(Math.max(0, x + 1), Math.max(0, width - room - 4));
    const top = index % 2 === 0 ? 2 : 2 + row;
    chip(label, left, top, COLUMN_INK, `bold ${size}px "Helvetica Neue", Arial, sans-serif`);
    if (index % MAJOR_EVERY === 0) {
      context.font = `${indexSize}px "Helvetica Neue", Arial, sans-serif`;
      const mark = String(index);
      context.fillStyle = "rgba(255, 255, 255, 0.85)";
      context.fillRect(left - 1, top + row - 1, context.measureText(mark).width + 3, indexSize + 2);
      context.fillStyle = INDEX_INK;
      context.fillText(mark, left, top + row);
    }
  }
  for (let index = 1; index <= rows; index += 1) {
    const y = at(index);
    if (y > height - 1) break;
    const top = Math.min(y + 1, Math.max(0, height - size - 2));
    const label = String(Math.round(origin.y + index * cell));
    chip(label, 1, top, ROW_INK, `bold ${size}px "Helvetica Neue", Arial, sans-serif`);
    if (index % MAJOR_EVERY === 0) {
      const room = context.measureText(label).width;
      context.font = `${indexSize}px "Helvetica Neue", Arial, sans-serif`;
      context.fillStyle = "rgba(255, 255, 255, 0.85)";
      context.fillRect(room + 4, top, context.measureText(String(index)).width + 3, indexSize + 2);
      context.fillStyle = INDEX_INK;
      context.fillText(String(index), room + 5, top + 1);
    }
  }
  context.restore();
}

// src/lib/ocr/blockCrop.ts
var BLOCK_PAD = 10;
var RULER_LEFT = 22;
var RULER_TOP = 24;
var TARGET_SHORT_SIDE = 440;
var MAX_SIDE = 2e3;
var MAX_SCALE = 4;
var GROW_SHARE = 0.6;
var GROW_MIN = 32;
function blockCropBox(pageWidth, pageHeight, block, boxes = []) {
  let x0 = block.x - BLOCK_PAD;
  let y0 = block.y - BLOCK_PAD;
  let x1 = block.x + block.width + BLOCK_PAD;
  let y1 = block.y + block.height + BLOCK_PAD;
  const growX = Math.max(GROW_MIN, block.width * GROW_SHARE);
  const growY = Math.max(GROW_MIN, block.height * GROW_SHARE);
  for (const box of boxes) {
    x0 = Math.max(block.x - growX, Math.min(x0, box.x));
    y0 = Math.max(block.y - growY, Math.min(y0, box.y));
    x1 = Math.min(block.x + block.width + growX, Math.max(x1, box.x + box.width));
    y1 = Math.min(block.y + block.height + growY, Math.max(y1, box.y + box.height));
  }
  const left = Math.max(0, Math.min(x0, x1 - 1));
  const top = Math.max(0, Math.min(y0, y1 - 1));
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(pageWidth, x1) - left),
    height: Math.max(1, Math.min(pageHeight, y1) - top)
  };
}
function readerCropBox(pageWidth, pageHeight, block, boxes = []) {
  const box = blockCropBox(pageWidth, pageHeight, block, boxes);
  const left = Math.max(0, box.x - RULER_LEFT);
  const top = Math.max(0, box.y - RULER_TOP);
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(pageWidth, box.x + box.width) - left),
    height: Math.max(1, Math.min(pageHeight, box.y + box.height) - top)
  };
}
function blockCropScale(crop) {
  const short = Math.max(1, Math.min(crop.width, crop.height));
  const long = Math.max(crop.width, crop.height);
  return Math.min(MAX_SCALE, Math.max(1, TARGET_SHORT_SIDE / short), MAX_SIDE / long);
}
function blockCropDataUrl(source, pageWidth, pageHeight, block, boxes = []) {
  const crop = readerCropBox(pageWidth, pageHeight, block, boxes);
  const scale = blockCropScale(crop);
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(crop.height * scale));
  const cell = gridCell(crop, scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser refused a 2D context for a block crop.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  paintGrid(context, width, height, gridGeometry(crop, cell), scale, { x: crop.x, y: crop.y });
  context.save();
  context.strokeStyle = "rgba(29, 78, 216, 0.95)";
  context.lineWidth = Math.max(2, Math.round(scale * 1.4));
  const idSize = Math.max(9, Math.round(scale * 7));
  context.textBaseline = "top";
  context.textAlign = "left";
  context.font = `bold ${idSize}px "Helvetica Neue", Arial, sans-serif`;
  boxes.forEach((box, index) => {
    const left = (box.x - crop.x) * scale;
    const top = (box.y - crop.y) * scale;
    context.strokeRect(left, top, box.width * scale, box.height * scale);
    const label = String(index + 1);
    const room = context.measureText(label).width;
    const chipX = Math.max(1, Math.min(left - room - 5, width - room - 4));
    const chipY = Math.max(1, Math.min(top - idSize - 4, height - idSize - 3));
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.fillRect(chipX - 1, chipY - 1, room + 4, idSize + 2);
    context.fillStyle = "#15803d";
    context.fillText(label, chipX + 1, chipY);
  });
  context.restore();
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.92), crop, cell };
}

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

// src/lib/loneGlyph.ts
var ORNAMENT = /[\s\u2060\u3000。、，．,.!?！？…‥⋯︙・「」『』（）()［］\[\]〈〉《》【】〔〕｛｝{}"'“”‘’〜～]/u;
var KANA = /[\u3040-\u309F\u30A0-\u30FF\u30FC\u30FB]/u;
function spokenGlyphs(text) {
  return [...text].filter((character) => !ORNAMENT.test(character));
}
function isLoneGlyph(text) {
  const glyphs = spokenGlyphs(text);
  if (glyphs.length !== 1) return false;
  return !KANA.test(glyphs[0]);
}

// src/lib/mask.ts
var MODEL_SIZE = 1024;

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
function similar(left, right) {
  const a = [...left.replace(/[\s、。！？…「」『』]/gu, "")];
  const b = [...right.replace(/[\s、。！？…「」『』]/gu, "")];
  if (a.length < 2 || b.length < 2) return false;
  const shared = a.filter((glyph) => b.includes(glyph)).length;
  return shared / Math.min(a.length, b.length) >= 0.5;
}
function extentOf(points, lean) {
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  const across = points.map((point) => point.x * cos + point.y * sin);
  return Math.max(...across) - Math.min(...across);
}
async function readBlockHint(bitmap2, block, mask, placed = 0) {
  if (!mask) return null;
  const points = blockInk(mask, block);
  if (points.length < 40) return null;
  const axis = majorAxis(points);
  const groupLean = axis === null ? 0 : axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2;
  const glyph = Math.max(12, block.height / GLYPHS_PER_COLUMN);
  const across = extentOf(points, groupLean);
  if (!(across > 0)) return null;
  const widest = Math.max(1, Math.min(4, Math.round(across / glyph)));
  if (placed > widest - 2) return null;
  if (widest <= 1) return null;
  const readCut = async (columns, lean) => {
    const readings2 = [];
    for (const band of bandsOf(points, columns, lean)) {
      const result = await readBand(bitmap2, band, lean);
      readings2.push({ text: result.text, confidence: result.confidence, box: band });
    }
    return { lines: readings2, lean, columns };
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
  const shaky = best.lines.some((line) => line.text.trim().length === 0 || line.confidence < 0.7) || best.lines.some((line, at) => best.lines.some((other, otherAt) => at < otherAt && similar(line.text, other.text)));
  if (shaky && widest > 2) {
    const cut = await readCut(widest - 1, best.lean);
    if (scoreOfCut(cut) > bestScore) {
      best = cut;
      bestScore = scoreOfCut(cut);
    }
  }
  const reliable = best.lines.every((line, at) => line.text.trim().length > 0 && line.confidence >= 0.7 && !best.lines.some((other, otherAt) => at !== otherAt && similar(line.text, other.text)));
  if (!reliable) return null;
  best.lines.sort((left, right) => right.box.x + right.box.width / 2 - (left.box.x + left.box.width / 2));
  return best;
}

// src/lib/ocr/cloudOcr.ts
var CONCURRENCY = 6;
var RETRY_DELAY_MS = 1400;
var REQUEST_TIMEOUT_MS = 6e4;
var DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
var DEEPSEEK_MODEL = "deepseek-flash";
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
function thinkingOf(effort) {
  if (effort === "off") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}
function deepSeekBody(dataUrls, prompt, effort) {
  const content = [{ type: "text", text: prompt }];
  dataUrls.forEach((dataUrl) => {
    content.push({ type: "image_url", image_url: { url: dataUrl } });
  });
  return {
    model: DEEPSEEK_MODEL,
    // One call does the transcription, the layout and the translation, so it
    // gets the effort the translation needs. Reading glyphs alone would not
    // justify a chain of thought; deciding the columns, the type and the
    // Chinese wording in the same pass does.
    ...thinkingOf(effort),
    messages: [
      { role: "system", content: "You read Japanese comic pages: you transcribe the text and describe where each line sits. You never translate; a separate request does that." },
      { role: "user", content }
    ]
  };
}
async function post(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("The cloud reader did not answer within a minute.");
    throw cause;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`The cloud reader answered ${response.status}. ${detail.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}
function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return content.trim();
  return content.slice(start, end + 1).trim();
}
function assertImagesRead(tokens, images, provider) {
  if (typeof tokens !== "number" || tokens <= 0 || images === 0) return;
  const floor = 250 + images * 80;
  console.info(`[cloud-ocr] ${provider}: ${images} crops, ${tokens} input tokens (floor ${floor})`);
  if (tokens < floor) {
    throw new Error(
      `The ${provider} model answered with ${tokens} input tokens for ${images} crops, so it never read the images.`
    );
  }
}
function deepSeekContent(payload) {
  const body = payload;
  return body.choices?.[0]?.message?.content ?? "";
}
function deepSeekInputTokens(payload) {
  const body = payload;
  return body.usage?.prompt_tokens;
}
async function deepSeekContentForSync(key2, dataUrls, prompt, effort) {
  const raw = await post(DEEPSEEK_ENDPOINT, { Authorization: `Bearer ${key2}` }, deepSeekBody(dataUrls, prompt, effort));
  const payload = JSON.parse(raw);
  assertImagesRead(deepSeekInputTokens(payload), dataUrls.length, "deepseek");
  const usage = payload.usage;
  console.info(`[read] deepseek effort ${effort}, tokens ${usage?.completion_tokens ?? "?"}, reasoning ${usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
  return deepSeekContent(payload);
}
var READ_EFFORT = "off";
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
function blockPrompt(hint) {
  if (!hint || hint.lines.length === 0) return BLOCK_PROMPT;
  const read = hint.lines.filter((line) => line.text.trim().length > 0);
  if (read.length === 0) return BLOCK_PROMPT;
  const quoted = hint.lines.map((line) => line.text.trim().length > 0 ? `"${line.text}"` : "(nothing)").join(", ");
  const complete = read.length === hint.lines.length;
  const reference = [
    `A Japanese recogniser also read this crop on the device, uprighted by about ${Math.round(hint.lean * 180 / Math.PI)} degrees and cut into ${hint.lines.length} column(s). It read ${quoted}, in reading order (right to left).`,
    complete ? `It found text in every one of those columns, so this crop holds at least ${read.length} text line(s).` : "It left at least one column blank, so treat its cut as a guess about where the columns are.",
    "Its characters are often right where its words are wrong: it confuses \u30D2 and \u30D3, \u3063 and \u3064, prints a run of hiragana as katakana, and cuts a column short. Where the quote prints a word in katakana that the image prints in hiragana, write it in hiragana: \u30E2\u30CE in the quote is \u3082\u306E when the page prints \u3082\u306E. Read the kana from the image, and use the reference only to confirm a glyph the image leaves ambiguous: never let it replace what the image shows, and never add a line the image does not have."
  ].join(" ");
  return `${BLOCK_PROMPT} ${reference}`;
}
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
function splitRegion(region) {
  const count = Math.max(1, region.columns > 1 ? region.columns : region.rows);
  if (count < 2) return [region];
  const vertical = region.columns > 1;
  const thickness = vertical ? region.width : region.height;
  if (thickness / count < 10) return [region];
  const step = thickness / count;
  const pieces = [];
  for (let index = 0; index < count; index += 1) {
    const offset = vertical ? region.x + thickness - step * (index + 1) : region.y + step * index;
    pieces.push(vertical ? { ...region, x: offset, width: step, columns: 1, rows: 1, cells: void 0 } : { ...region, y: offset, height: step, columns: 1, rows: 1, cells: void 0 });
  }
  return pieces;
}
var KANA_ONLY = /^[\u3040-\u309F\u30A0-\u30FF\u30FC\u30FB]+$/u;
function acrossSize(item) {
  return item.direction === "v" ? item.width : item.height;
}
function readingHostOf(region, others, widest) {
  const text = region.text.replace(/[\s、。！？…「」『』]/gu, "");
  if (!(text.length > 0 && text.length <= 8 && KANA_ONLY.test(text))) return void 0;
  const glyphs = (item) => [...item.text.replace(/\s/gu, "")].length;
  const spanAcross = (item) => item.direction === "v" ? [item.x, item.x + item.width] : [item.y, item.y + item.height];
  const spanAlong = (item) => item.direction === "v" ? [item.y, item.y + item.height] : [item.x, item.x + item.width];
  const advance = (item) => {
    const [from, to] = spanAlong(item);
    return (to - from) / Math.max(1, glyphs(item));
  };
  return others.find((host) => {
    if (host === region) return false;
    if (host.direction !== region.direction) return false;
    if (acrossSize(region) > acrossSize(host)) return false;
    if (acrossSize(region) > acrossSize(host) - 2) return false;
    const [hostFrom, hostTo] = spanAlong(host);
    const [from, to] = spanAlong(region);
    const overlap2 = Math.min(hostTo, to) - Math.max(hostFrom, from);
    if (overlap2 < (to - from) * 0.5) return false;
    const [hostStart, hostEnd] = spanAcross(host);
    const [ownStart, ownEnd] = spanAcross(region);
    if (ownStart >= hostStart - 1 && ownEnd <= hostEnd + 1 && acrossSize(region) <= widest * 0.7 && acrossSize(host) >= acrossSize(region) * 1.5) {
      return true;
    }
    const gap = Math.max(hostStart - ownEnd, ownStart - hostEnd, 0);
    if (gap > acrossSize(host)) return false;
    if (glyphs(host) < 1 || glyphs(region) < 2) return false;
    return advance(region) <= advance(host) * 0.75;
  });
}
function dropReadingsInsideColumns(regions) {
  if (regions.length < 2) return regions;
  const widest = Math.max(...regions.map(acrossSize));
  if (!(widest > 0)) return regions;
  return regions.filter((region) => !readingHostOf(region, regions, widest));
}
function mergeCompanionRegions(regions) {
  if (regions.length < 2) return regions;
  const thickness = (region) => region.direction === "v" ? region.width : region.height;
  const widest = Math.max(...regions.map(thickness));
  if (!(widest > 0)) return regions;
  const hosts = regions.filter((region) => thickness(region) >= widest * 0.55);
  if (hosts.length === 0) return regions;
  const companions = regions.filter((region) => thickness(region) < widest * 0.55);
  if (companions.length === 0) return regions;
  const merged = hosts.map((host) => ({ ...host }));
  for (const companion of companions) {
    const text = companion.text.replace(/[\s、。！？…「」『』]/gu, "");
    const kana = text.length > 0 && text.length <= 6 && KANA_ONLY.test(text);
    if (!kana) {
      merged.push({ ...companion });
      continue;
    }
    const cross = (region) => region.direction === "v" ? region.x + region.width / 2 : region.y + region.height / 2;
    let host = merged[0];
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of merged) {
      if (candidate.direction !== companion.direction) continue;
      const distance = Math.abs(cross(candidate) - cross(companion));
      if (distance < best) {
        best = distance;
        host = candidate;
      }
    }
    if (isLoneGlyph(host.text)) continue;
    const along = (region) => region.direction === "v" ? { start: region.y, end: region.y + region.height } : { start: region.x, end: region.x + region.width };
    const hostSpan = along(host);
    const companionSpan = along(companion);
    const overlap2 = Math.min(hostSpan.end, companionSpan.end) - Math.max(hostSpan.start, companionSpan.start);
    if (overlap2 <= (companionSpan.end - companionSpan.start) * 0.2) {
      merged.push({ ...companion });
      continue;
    }
    const before = companion.direction === "v" ? cross(companion) > cross(host) : cross(companion) < cross(host);
    host.text = before ? `${companion.text}${host.text}` : `${host.text}${companion.text}`;
    const left = Math.min(host.x, companion.x);
    const top = Math.min(host.y, companion.y);
    const right = Math.max(host.x + host.width, companion.x + companion.width);
    const bottom = Math.max(host.y + host.height, companion.y + companion.height);
    host.x = left;
    host.y = top;
    host.width = right - left;
    host.height = bottom - top;
  }
  return merged;
}
function separateOverlaps(regions) {
  const vertical = regions.filter((region) => region.direction === "v").sort((left, right) => left.x - right.x);
  for (let index = 1; index < vertical.length; index += 1) {
    const left = vertical[index - 1];
    const right = vertical[index];
    if (right.x > left.x && right.x < left.x + left.width) {
      left.width = Math.max(4, right.x - left.x);
    }
  }
  const horizontal = regions.filter((region) => region.direction === "h").sort((left, right) => left.y - right.y);
  for (let index = 1; index < horizontal.length; index += 1) {
    const top = horizontal[index - 1];
    const bottom = horizontal[index];
    if (bottom.y > top.y && bottom.y < top.y + top.height) {
      top.height = Math.max(4, bottom.y - top.y);
    }
  }
  return regions;
}
function inkOf(text) {
  return spokenGlyphs(text.normalize("NFKC")).join("");
}
function sharedShare(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height / Math.min(left.width * left.height, right.width * right.height);
}
function dropRepeatedReadings(readings2) {
  const dropped = /* @__PURE__ */ new Set();
  const mark = (index, at, why) => {
    dropped.add(`${index}:${at}`);
    console.info(`[read] block ${index + 1}: ${JSON.stringify(readings2[index].regions[at].text)} ${why}`);
  };
  readings2.forEach((reading, index) => {
    const children = readings2.filter((other) => other !== reading && containsBlock(reading.block, other.block));
    if (children.length === 0) return;
    const inside2 = children.flatMap((child) => child.regions);
    const words = new Set(inside2.map((region) => inkOf(region.text)));
    reading.regions.forEach((region, at) => {
      const word = inkOf(region.text);
      if (word.length === 0) return;
      if (words.has(word)) {
        mark(index, at, "is already read by the block inside it");
        return;
      }
      if (joinedRuns(region, inside2).has(word)) {
        mark(index, at, "is the join of the columns already read inside it");
        return;
      }
      if (inside2.some((child) => sharedShare(region, child) >= 0.3)) {
        mark(index, at, "lies on ink the block inside it already read");
      }
    });
  });
  const entries = readings2.flatMap((reading, index) => reading.regions.map((region, at) => ({ index, at, region })));
  const order = [...entries].sort((left, right) => left.region.width * left.region.height - right.region.width * right.region.height);
  const kept = /* @__PURE__ */ new Map();
  for (const entry of order) {
    const key2 = `${entry.index}:${entry.at}`;
    if (dropped.has(key2)) continue;
    const same = [...kept.values()].find((other) => sharedShare(entry.region, other) >= 0.3 && inkOf(entry.region.text) === inkOf(other.text));
    if (same) {
      mark(entry.index, entry.at, `is the ink of ${JSON.stringify(same.text)}, already read`);
      continue;
    }
    kept.set(key2, entry.region);
  }
  return readings2.map((reading, index) => ({
    ...reading,
    regions: reading.regions.filter((_, at) => !dropped.has(`${index}:${at}`))
  }));
}
function containsBlock(outer, inner) {
  if (outer.width * outer.height <= inner.width * inner.height * 1.1) return false;
  return sharedShare(outer, inner) >= 0.9;
}
function joinedRuns(anchor, regions) {
  const ordered = readersOrdered(anchor, regions);
  const runs = /* @__PURE__ */ new Set();
  for (let from = 0; from < ordered.length; from += 1) {
    let joined = "";
    for (let to = from; to < ordered.length; to += 1) {
      joined += inkOf(ordered[to].text);
      if (to > from) runs.add(joined);
    }
  }
  return runs;
}
function readersOrdered(anchor, regions) {
  const vertical = anchor.direction === "v";
  return [...regions].sort((left, right) => vertical ? right.x - left.x || left.y - right.y : left.y - right.y || left.x - right.x);
}
function inkFrameOf(region, boxes, siblings = []) {
  if (boxes.length === 0) return null;
  const vertical = region.direction === "v";
  const across = (box) => vertical ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
  const along = (box) => vertical ? [box.y, box.y + box.height] : [box.x, box.x + box.width];
  const [ownFrom, ownTo] = across(region);
  const overlaps = boxes.map((box) => {
    const [from, to] = across(box);
    return { box, shared: Math.min(ownTo, to) - Math.max(ownFrom, from) };
  });
  const best = Math.max(...overlaps.map((one) => one.shared));
  if (!(best > 0)) return null;
  const candidates2 = overlaps.filter((one) => one.shared >= best * 0.9).map((one) => one.box);
  if (candidates2.length === 0) return null;
  const [runFrom, runTo] = along(region);
  const near = candidates2.filter((box) => {
    const [from, to] = along(box);
    return Math.min(runTo, to) - Math.max(runFrom, from) >= 0;
  });
  const run = near.length > 0 ? near : candidates2;
  const ink = {
    x: Math.min(...run.map((box) => box.x)),
    y: Math.min(...run.map((box) => box.y)),
    width: Math.max(...run.map((box) => box.x + box.width)) - Math.min(...run.map((box) => box.x)),
    height: Math.max(...run.map((box) => box.y + box.height)) - Math.min(...run.map((box) => box.y))
  };
  const [inkFrom, inkTo] = across(ink);
  const shared = siblings.some((other) => other !== region && Math.abs((across(other)[0] + across(other)[1]) / 2 - (inkFrom + inkTo) / 2) < (inkTo - inkFrom) / 2);
  if (shared) {
    return vertical ? { x: region.x, y: ink.y, width: region.width, height: ink.height } : { x: ink.x, y: region.y, width: ink.width, height: region.height };
  }
  return ink;
}
function columnBoxes(boxes) {
  if (boxes.length < 2) return boxes;
  const vertical = boxes.filter((box) => box.height >= box.width).length >= boxes.length / 2;
  const thicknessOf = (box) => vertical ? box.width : box.height;
  const thicknesses = boxes.map(thicknessOf).sort((left, right) => left - right);
  const median = thicknesses[thicknesses.length >> 1];
  if (!(median > 0)) return boxes;
  const spanOf = (box) => vertical ? [box.y, box.y + box.height] : [box.x, box.x + box.width];
  return boxes.filter((box) => {
    if (thicknessOf(box) >= median * 0.6) return true;
    const [from, to] = spanOf(box);
    const beside = boxes.some((other) => {
      if (other === box || thicknessOf(other) < thicknessOf(box) * 1.4) return false;
      const [otherFrom, otherTo] = spanOf(other);
      return Math.min(to, otherTo) - Math.max(from, otherFrom) >= (to - from) * 0.5;
    });
    return !beside;
  });
}
function blockFrames(regions, boxes) {
  if (boxes.length === 0) return regions.map(() => void 0);
  const unionOf = (list) => {
    const x = Math.min(...list.map((box) => box.x));
    const y = Math.min(...list.map((box) => box.y));
    const right = Math.max(...list.map((box) => box.x + box.width));
    const bottom = Math.max(...list.map((box) => box.y + box.height));
    return { x, y, width: right - x, height: bottom - y };
  };
  const claims = /* @__PURE__ */ new Map();
  for (const region of regions) {
    for (const id of region.boxIds ?? []) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  const claimed = /* @__PURE__ */ new Set();
  const frames = regions.map((region) => {
    const ids = (region.boxIds ?? []).filter((id) => id <= boxes.length && claims.get(id) === 1);
    if (ids.length === 0) return void 0;
    ids.forEach((id) => claimed.add(id));
    return unionOf(ids.map((id) => boxes[id - 1]));
  });
  const missing = frames.map((frame, at) => frame ? -1 : at).filter((at) => at >= 0);
  if (missing.length === 0) return frames;
  const free = boxes.filter((_, index) => !claimed.has(index + 1));
  if (free.length === missing.length) {
    const ordered = [...free].sort((left, right) => {
      const band = Math.max(left.height, right.height) * 0.35;
      if (Math.abs(left.y - right.y) > band) return left.y - right.y;
      return right.x - left.x;
    });
    missing.forEach((at, index) => {
      frames[at] = { ...ordered[index] };
    });
    return frames;
  }
  for (const at of missing) {
    frames[at] = inkFrameOf(regions[at], free.length > 0 ? free : boxes, regions) ?? void 0;
  }
  return frames;
}
function readBlockAnswer(content, crop, cell, boxes = []) {
  const parsed = JSON.parse(extractJson(content));
  const items = Array.isArray(parsed.regions) ? parsed.regions : [];
  if (items.length === 0) return [];
  const geometry = gridGeometry(crop, cell);
  const scale = blockCropScale(crop);
  const regions = [];
  for (const item of items) {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text.length === 0) continue;
    const degrees = Number(item.angle);
    const numbers = [item.x, item.y, item.width, item.height].map(Number);
    const fractions = [item.left, item.top, item.width, item.height].map(Number);
    const whole = numbers.every((value) => Number.isFinite(value));
    const box = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
    const startsIn = (candidate, fromX, fromY, toX, toY) => candidate.width >= 6 && candidate.height >= 6 && candidate.x >= fromX - 8 && candidate.y >= fromY - 8 && candidate.x < toX && candidate.y < toY;
    const asCells = whole && numbers.every((value) => Number.isInteger(value)) && numbers[0] >= 0 && numbers[1] >= 0 && numbers[2] >= 1 && numbers[3] >= 1 && numbers[0] <= geometry.columns + 1 && numbers[1] <= geometry.rows + 1 && numbers[2] <= geometry.columns + 1 && numbers[3] <= geometry.rows + 1;
    const named = (Array.isArray(item.box) ? item.box : [item.box ?? item.boxes]).flat().map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= boxes.length).slice(0, 4);
    if (named.length === 0 && boxes.length === 1) named.push(1);
    let x;
    let y;
    let regionWidth;
    let regionHeight;
    let cellBox;
    if (named.length > 0) {
      const picked = named.map((id) => boxes[id - 1]);
      x = Math.min(...picked.map((one) => one.x));
      y = Math.min(...picked.map((one) => one.y));
      regionWidth = Math.max(...picked.map((one) => one.x + one.width)) - x;
      regionHeight = Math.max(...picked.map((one) => one.y + one.height)) - y;
    } else if (whole && startsIn(box, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height) && box.width <= crop.width * 1.2 && box.height <= crop.height * 1.2) {
      x = box.x;
      y = box.y;
      regionWidth = box.width;
      regionHeight = box.height;
    } else if (asCells) {
      const cells = numbers.map((value) => Math.round(value));
      const boxWidth = Math.min(Math.max(1, cells[2]), geometry.columns);
      const boxHeight = Math.min(Math.max(1, cells[3]), geometry.rows);
      const column = Math.min(Math.max(0, cells[0]), geometry.columns - boxWidth);
      const row = Math.min(Math.max(0, cells[1]), geometry.rows - boxHeight);
      const mapped = cellToPage(crop, geometry.cell, {
        x: column,
        y: row,
        width: boxWidth,
        height: boxHeight
      });
      x = mapped.x;
      y = mapped.y;
      regionWidth = mapped.width;
      regionHeight = mapped.height;
      cellBox = { x: column, y: row, width: boxWidth, height: boxHeight };
    } else if (whole && startsIn(
      box,
      0,
      0,
      crop.width * scale,
      crop.height * scale
    ) && box.width <= crop.width * scale * 1.2 && box.height <= crop.height * scale * 1.2) {
      x = crop.x + box.x / scale;
      y = crop.y + box.y / scale;
      regionWidth = box.width / scale;
      regionHeight = box.height / scale;
    } else if (fractions.every((value) => Number.isFinite(value))) {
      const fractionWidth = clamp01(fractions[2]);
      const fractionHeight = clamp01(fractions[3]);
      if (fractionWidth < 0.02 || fractionHeight < 0.02) continue;
      x = crop.x + clamp01(fractions[0]) * crop.width;
      y = crop.y + clamp01(fractions[1]) * crop.height;
      regionWidth = Math.min(crop.x + crop.width - x, fractionWidth * crop.width);
      regionHeight = Math.min(crop.y + crop.height - y, fractionHeight * crop.height);
    } else {
      continue;
    }
    const right = Math.min(crop.x + crop.width, x + regionWidth);
    const bottom = Math.min(crop.y + crop.height, y + regionHeight);
    x = Math.max(crop.x, x);
    y = Math.max(crop.y, y);
    regionWidth = right - x;
    regionHeight = bottom - y;
    if (regionWidth < 8 || regionHeight < 8) continue;
    const direction = item.direction === "h" ? "h" : item.direction === "v" || item.direction === "i" ? "v" : Math.abs(degrees) > 45 || !Number.isFinite(degrees) && regionHeight >= regionWidth ? "v" : "h";
    const columns = Number.isFinite(Number(item.columns)) ? Math.round(Number(item.columns)) : 1;
    const rows = Number.isFinite(Number(item.rows)) ? Math.round(Number(item.rows)) : 1;
    const region = {
      x,
      y,
      width: regionWidth,
      height: regionHeight,
      text,
      direction,
      columns: Math.max(1, columns),
      rows: Math.max(1, rows),
      ...cellBox ? { cells: cellBox } : {},
      ...named.length > 0 ? { boxIds: named.slice(0, 4) } : {},
      kind: item.type === "sfx" || item.kind === "sfx" ? "sfx" : item.type === "name" || item.kind === "name" ? "name" : "chat",
      ...typeof item.ruby === "string" && item.ruby.trim().length > 0 ? { ruby: item.ruby.trim() } : {}
    };
    if (whole && box.width >= 4 && box.height >= 4) {
      region.own = {
        x: Math.max(crop.x, Math.min(crop.x + crop.width - 1, box.x)),
        y: Math.max(crop.y, Math.min(crop.y + crop.height - 1, box.y)),
        width: box.width,
        height: box.height
      };
    }
    const em = Number(item.em);
    if (Number.isFinite(em) && em >= 4 && em <= 300) region.glyphSize = em;
    for (const piece of splitRegion(region)) {
      if (piece.glyphSize === void 0) {
        piece.glyphSize = piece.direction === "v" ? piece.width : piece.height;
      }
      regions.push(piece);
    }
  }
  return mergeCharacterRegions(regions);
}
function mergeCharacterRegions(regions) {
  if (regions.length < 2) return regions;
  const groups = /* @__PURE__ */ new Map();
  for (const region of regions) {
    const id = region.boxIds?.[0];
    const own = region.own ?? region;
    const key2 = id !== void 0 ? `box:${id}` : `own:${region.direction}:${Math.round(own.x / 8)}:${Math.round(own.y / 8)}`;
    const list = groups.get(key2);
    if (list) list.push(region);
    else groups.set(key2, [region]);
  }
  const out = [];
  for (const group of groups.values()) {
    const oneGlyph = group.some((region) => [...region.text].length <= 2);
    if (group.length < 2 || !oneGlyph) {
      out.push(...group);
      continue;
    }
    const direction = group[0].direction;
    const boxes = group.map((region) => region.own ?? region);
    const across = (box) => direction === "v" ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
    const [groupFrom, groupTo] = across({
      x: Math.min(...boxes.map((box) => box.x)),
      y: Math.min(...boxes.map((box) => box.y)),
      width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
      height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y))
    });
    const sameBand = boxes.every((box) => {
      const [from, to] = across(box);
      return Math.min(groupTo, to) - Math.max(groupFrom, from) >= Math.min(to - from, groupTo - groupFrom) * 0.4;
    });
    if (!sameBand) {
      out.push(...group);
      continue;
    }
    const along = (box) => direction === "v" ? box.y : box.x;
    const ordered = [...group].sort((left2, right2) => along(left2.own ?? left2) - along(right2.own ?? right2));
    const left = Math.min(...ordered.map((region) => (region.own ?? region).x));
    const top = Math.min(...ordered.map((region) => (region.own ?? region).y));
    const right = Math.max(...ordered.map((region) => (region.own ?? region).x + (region.own ?? region).width));
    const bottom = Math.max(...ordered.map((region) => (region.own ?? region).y + (region.own ?? region).height));
    const sizes = ordered.map((region) => region.glyphSize).filter((size) => typeof size === "number" && size >= 4).sort((a, b) => a - b);
    const first = ordered[0];
    out.push({
      ...first,
      text: ordered.map((region) => region.text).join(""),
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      glyphSize: sizes.length > 0 ? sizes[sizes.length >> 1] : first.glyphSize,
      boxIds: [...new Set(ordered.flatMap((region) => region.boxIds ?? []))],
      own: { x: left, y: top, width: right - left, height: bottom - top }
    });
  }
  return out;
}
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
function applyInclination(regions, boxes, mask, blockLean) {
  if (regions.length === 0) return;
  const byBox = /* @__PURE__ */ new Map();
  for (const region of regions) {
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
    const groupLean = direction === "v" && blockLean !== void 0 ? blockLean : measured?.lean ?? 0;
    const acrossStart = direction === "v" ? box.x : box.y;
    const acrossSize2 = direction === "v" ? box.width : box.height;
    const alongStart = direction === "v" ? box.y : box.x;
    const alongSize = direction === "v" ? box.height : box.width;
    const inkEm = measured?.thickness && measured.thickness >= 4 ? measured.thickness : void 0;
    const tight = group.length === 1 ? Math.max(4, acrossSize2 * Math.cos(groupLean) - alongSize * Math.abs(Math.sin(groupLean))) : acrossSize2 / group.length;
    const credible = inkEm !== void 0 && inkEm >= tight * 0.6;
    const boxEm = credible ? Math.min(tight, inkEm) : tight;
    if (measured === void 0 && blockLean === void 0 || Math.abs(groupLean) < 0.5 * Math.PI / 180) {
      group.forEach((region) => {
        region.angle = void 0;
        region.glyphSize = boxEm;
        region.lineThickness = Math.max(4, Math.min(boxEm, acrossSize2 * 0.95));
      });
      continue;
    }
    const ordered = [...group].sort((left, right) => {
      const ownLeft = left.own ?? left;
      const ownRight = right.own ?? right;
      const acrossOf = (item) => direction === "v" ? item.x + item.width / 2 : item.y + item.height / 2;
      return direction === "v" ? acrossOf(ownRight) - acrossOf(ownLeft) : acrossOf(ownLeft) - acrossOf(ownRight);
    });
    const band = acrossSize2 / ordered.length;
    ordered.forEach((region, index) => {
      const centreAcross = direction === "v" ? acrossStart + acrossSize2 - band * (index + 0.5) : acrossStart + band * (index + 0.5);
      const centreAlong = alongStart + alongSize / 2;
      const lean = groupLean;
      const cos = Math.max(0.5, Math.cos(lean));
      const length = alongSize / cos;
      const em = boxEm;
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
  for (const region of regions) {
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
async function readBlockRegions(bitmap2, blocks, ocr, detBoxes = [], mask = null) {
  const readings2 = blocks.map((block) => ({ block: { ...block }, regions: [], cell: 0, boxes: [] }));
  if (blocks.length === 0) return readings2;
  const queue = blocks.map((_, index) => index);
  let next = 0;
  const worker = async () => {
    while (true) {
      const cursor = next;
      next += 1;
      if (cursor >= queue.length) return;
      const index = queue[cursor];
      const reading = readings2[index];
      const padded = blockCropBox(bitmap2.width, bitmap2.height, reading.block);
      const inside2 = columnBoxes(detBoxes.filter((box) => box.x < padded.x + padded.width && box.x + box.width > padded.x && box.y < padded.y + padded.height && box.y + box.height > padded.y).slice(0, 40).map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })));
      reading.boxes = inside2;
      let cut;
      try {
        cut = blockCropDataUrl(bitmap2, bitmap2.width, bitmap2.height, reading.block, inside2);
      } catch (cause) {
        console.warn("Block reading could not cut one block.", cause);
        continue;
      }
      const crop = { ...cut.crop, score: reading.block.score };
      const dataUrl = cut.dataUrl;
      let hint = null;
      try {
        hint = await readBlockHint(bitmap2, reading.block, mask, inside2.length);
        if (hint) {
          console.info(`[hint] block ${index + 1}: ${hint.columns} column(s) at ${(hint.lean * 180 / Math.PI).toFixed(1)}deg: ` + hint.lines.map((line) => `${line.text}(${line.confidence.toFixed(2)})`).join(" | "));
        }
      } catch (cause) {
        console.warn("The on-device reading of one block failed.", cause);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const content = await deepSeekContentForSync(ocr.key, [dataUrl], blockPrompt(hint), READ_EFFORT);
          reading.raw = content;
          if (hint) reading.hint = hint;
          console.info(`[read] block ${index + 1}: ${content.slice(0, 3e3)}`);
          reading.cropUrl = dataUrl;
          const parsed = readBlockAnswer(content, crop, cut.cell, reading.boxes ?? []);
          const kept = dropReadingsInsideColumns(parsed);
          if (kept.length !== parsed.length) {
            console.info(`[read] dropped ${parsed.length - kept.length} reading(s) inside a column`);
          }
          reading.regions = separateOverlaps(mergeCompanionRegions(kept));
          const frames = blockFrames(reading.regions, reading.boxes ?? []);
          reading.regions.forEach((region, at) => {
            const frame = frames[at];
            if (frame) region.frame = frame;
          });
          applyInclination(reading.regions, reading.boxes ?? [], mask, hint?.lean);
          const geometry = gridGeometry(cut.crop, cut.cell);
          reading.cell = geometry.cell;
          console.info(`[grid] block ${index + 1}: ${geometry.columns} x ${geometry.rows} cells of ${reading.cell}px, ${reading.regions.length} line(s)`);
          if (reading.regions.length < inside2.length) {
            console.warn(`[read] block ${index + 1}: ${reading.regions.length} line(s) for ${inside2.length} box(es); the rest keep their ink`);
          }
          break;
        } catch (cause) {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            continue;
          }
          console.warn(
            "Block reading failed for one block.",
            cause,
            JSON.stringify((reading.raw ?? "").slice(0, 160))
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  return dropRepeatedReadings(readings2);
}

// .dsh/tmp/probe-banner.mjs
await prepareOrt();
var bitmap = await loadImage("fixtures/page-forty.jpg");
var detected = await detectLines(bitmap, []);
var blk = detected.blkBoxes.filter((b) => b.y > 950 && b.x < 300);
console.log("blk", blk.map((b) => ({ x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0) })));
var inside = detected.detBoxes.filter((box) => box.y > 950 && box.x < 300);
console.log("det", inside.map((b) => ({ x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0) })));
var key = readApiKey();
var readings = await readBlockRegions(bitmap, blk.map((b) => ({ ...b })), { provider: "deepseek", key }, detected.detBoxes, detected.mask);
for (const r of readings) {
  console.log("RAW", r.raw);
  console.log("REGIONS", JSON.stringify(r.regions.map((g) => ({
    text: g.text,
    boxIds: g.boxIds,
    own: g.own,
    x: +g.x.toFixed(0),
    y: +g.y.toFixed(0),
    w: +g.width.toFixed(0),
    h: +g.height.toFixed(0),
    angle: g.angle && +(g.angle * 180 / Math.PI).toFixed(1),
    glyph: g.glyphSize && +g.glyphSize.toFixed(1),
    lineLength: g.lineLength && +g.lineLength.toFixed(0)
  }))));
}
