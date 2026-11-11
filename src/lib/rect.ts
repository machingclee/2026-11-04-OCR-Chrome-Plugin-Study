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
