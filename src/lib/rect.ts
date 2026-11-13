import type { Point } from './types';

/** Andrew's monotone chain: the smallest convex polygon that holds every point. */
function convexHull(points: Point[]): Point[] {
    const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    if (sorted.length < 3) return sorted;

    const cross = (o: Point, a: Point, b: Point): number =>
        (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower: Point[] = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }

    const upper: Point[] = [];
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

export type RotatedRect = {
    /** Centre of the rectangle, in page pixels. */
    centre: Point;
    /** Length along the text direction. */
    length: number;
    /** Thickness across the text direction. */
    thickness: number;
    /** Radians, from the x axis, in [-pi/2, pi/2]. */
    angle: number;
};

/**
 * The smallest rectangle that covers a set of points, at any angle. A slanted
 * line has an axis aligned box far larger than the glyphs, and this finds the
 * box that follows the slant instead.
 */
export function minAreaRect(points: Point[]): RotatedRect | null {
    const hull = convexHull(points);
    if (hull.length < 3) return null;

    let best: RotatedRect | null = null;
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
                y: centreX * sin + centreY * cos,
            },
            length: width,
            thickness: height,
            angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
        };
    }

    return best;
}

/**
 * First principal axis of the points, the major axis of their covariance.
 * A corner pulls the minimum rectangle; this follows the mass instead.
 */
export function majorAxis(points: Point[]): number | null {
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

/** Points more than this far from the main mass, across the text, are another cluster. */
const CLUSTER_GAP = 8;

/**
 * Drop a side cluster. The text is the heaviest run along the minor axis;
 * a seg blob that sits off that run does not get to tilt it.
 */
export function mainCluster(points: Point[]): { angle: number; points: Point[] } | null {
    const first = majorAxis(points);
    if (first === null) return null;
    const acrossX = -Math.sin(first);
    const acrossY = Math.cos(first);
    const ranked = points
        .map((point) => ({ point, across: point.x * acrossX + point.y * acrossY }))
        .sort((a, b) => a.across - b.across);

    const runs: Point[][] = [];
    let run: Point[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (const entry of ranked) {
        if (run.length > 0 && entry.across - previous > CLUSTER_GAP) {
            runs.push(run);
            run = [];
        }
        run.push(entry.point);
        previous = entry.across;
    }
    if (run.length > 0) runs.push(run);

    let best = runs[0];
    for (const candidate of runs) {
        if (candidate.length > best.length) best = candidate;
    }
    const angle = majorAxis(best) ?? first;
    return { angle, points: best };
}

/**
 * A rectangle has no direction, so every angle folds into (-pi/2, pi/2]. The
 * guard at the end treats a near axis aligned line as exactly axis aligned.
 */
export function foldAngle(angle: number): number {
    const halfTurn = Math.PI;
    let folded = ((angle % halfTurn) + halfTurn) % halfTurn;
    if (folded > Math.PI / 2) folded -= halfTurn;
    if (folded <= -Math.PI / 2) folded += halfTurn;
    return Math.abs(folded) < 0.01 ? 0 : folded;
}

/** The four corners of a rotated rect, clockwise from the top left of the text. */
export function cornersOf(rect: RotatedRect): Point[] {
    const cos = Math.cos(rect.angle);
    const sin = Math.sin(rect.angle);
    const halfLength = rect.length / 2;
    const halfThickness = rect.thickness / 2;
    const corner = (x: number, y: number): Point => ({
        x: rect.centre.x + x * cos - y * sin,
        y: rect.centre.y + x * sin + y * cos,
    });
    return [
        corner(-halfLength, -halfThickness),
        corner(halfLength, -halfThickness),
        corner(halfLength, halfThickness),
        corner(-halfLength, halfThickness),
    ];
}
