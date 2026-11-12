// Geometry for print mode: Figma path data in and out of clipper-lib polygons.
//
// Everything is converted to page coordinates and scaled to integers, because
// clipper-lib works on integer points and that keeps unions and differences
// free of rounding errors where shapes share edges (common in pixel art).

import * as ClipperLib from 'clipper-lib'

export type Paths = ClipperLib.Paths

/** Page coordinates are multiplied by this before rounding to clipper-lib integers. */
export const GEOMETRY_SCALE = 1000

/** Curves are flattened into straight segments that stay this close to the true curve. */
export const CURVE_TOLERANCE_PX = 0.02

// clipper-lib defaults to even-odd; every operation here uses non-zero unless told otherwise.
const NON_ZERO = ClipperLib.PolyFillType.pftNonZero
const EVEN_ODD = ClipperLib.PolyFillType.pftEvenOdd

interface Point {
  x: number
  y: number
}

export const IDENTITY: Transform = [
  [1, 0, 0],
  [0, 1, 0],
]

// ---------------------------------------------------------------------------
// Boolean operations
// ---------------------------------------------------------------------------

function booleanOp(type: ClipperLib.ClipType, subject: Paths, clip: Paths, fill = NON_ZERO): Paths {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clip.length) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  const solution: Paths = []
  clipper.Execute(type, solution, fill, fill)
  return solution
}

export function union(paths: Paths, fill = NON_ZERO): Paths {
  return booleanOp(ClipperLib.ClipType.ctUnion, paths, [], fill)
}

export function intersect(subject: Paths, clip: Paths): Paths {
  return booleanOp(ClipperLib.ClipType.ctIntersection, subject, clip)
}

export function difference(subject: Paths, clip: Paths): Paths {
  return booleanOp(ClipperLib.ClipType.ctDifference, subject, clip)
}

/** Total area in square pixels, holes subtracted. */
export function area(paths: Paths): number {
  const scaled = paths.reduce((sum, path) => sum + ClipperLib.Clipper.Area(path), 0)
  return Math.abs(scaled) / GEOMETRY_SCALE / GEOMETRY_SCALE
}

/** Bounds in scaled integer units. */
export function boundsOf(paths: Paths) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const path of paths) {
    for (const point of path) {
      left = Math.min(left, point.X)
      top = Math.min(top, point.Y)
      right = Math.max(right, point.X)
      bottom = Math.max(bottom, point.Y)
    }
  }
  return { left, top, right, bottom }
}

// ---------------------------------------------------------------------------
// Figma geometry to polygons
// ---------------------------------------------------------------------------

/**
 * Converts a node's fill or stroke geometry into page-space polygons, normalized
 * to non-zero winding so later operations can mix shapes freely.
 */
export function geometryToPaths(geometry: VectorPaths, transform: Transform): Paths {
  let result: Paths = []
  for (const vectorPath of geometry) {
    const paths = parsePathData(vectorPath.data, transform)
    if (paths.length === 0) continue
    result = result.concat(union(paths, vectorPath.windingRule === 'EVENODD' ? EVEN_ODD : NON_ZERO))
  }
  return geometry.length > 1 ? union(result) : result
}

/** A width by height rectangle at the origin of `transform`, as page-space polygons. */
export function rectToPaths(width: number, height: number, transform: Transform): Paths {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  return [corners.map((corner) => toIntPoint(apply(transform, corner)))]
}

const TOKEN = /[MLQCZmlqcz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

/** Parses Figma path data (absolute M, L, Q, C, Z) into integer polygons in page space. */
export function parsePathData(data: string, transform: Transform): Paths {
  const tokens = data.match(TOKEN) || []
  const paths: Paths = []
  let current: Point[] = []
  let cursor: Point = { x: 0, y: 0 }
  let index = 0
  const next = () => apply(transform, { x: Number(tokens[index++]), y: Number(tokens[index++]) })
  const close = () => {
    if (current.length >= 3) paths.push(current.map(toIntPoint))
    current = []
  }

  while (index < tokens.length) {
    const command = tokens[index++].toUpperCase()
    if (command === 'M') {
      close()
      cursor = next()
      current.push(cursor)
    } else if (command === 'L') {
      cursor = next()
      current.push(cursor)
    } else if (command === 'Q') {
      const control = next()
      const end = next()
      flattenQuadratic(cursor, control, end, current)
      cursor = end
    } else if (command === 'C') {
      const control1 = next()
      const control2 = next()
      const end = next()
      flattenCubic(cursor, control1, control2, end, current)
      cursor = end
    } else if (command === 'Z') {
      close()
    }
  }
  close()
  return paths
}

// Segment counts follow Wang's formula, so each curve stays within CURVE_TOLERANCE_PX.
function flattenQuadratic(p0: Point, p1: Point, p2: Point, out: Point[]) {
  const deviation = Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y)
  const segments = Math.max(1, Math.ceil(Math.sqrt((0.25 * deviation) / CURVE_TOLERANCE_PX)))
  for (let step = 1; step <= segments; step++) {
    const t = step / segments
    const u = 1 - t
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y })
  }
}

function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[]) {
  const deviation = Math.max(
    Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y),
    Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y),
  )
  const segments = Math.max(1, Math.ceil(Math.sqrt((0.75 * deviation) / CURVE_TOLERANCE_PX)))
  for (let step = 1; step <= segments; step++) {
    const t = step / segments
    const u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    })
  }
}

// ---------------------------------------------------------------------------
// Polygons back to Figma path data
// ---------------------------------------------------------------------------

/**
 * Converts page-space polygons into path data in the coordinate space of a node
 * whose page transform is `transform` (usually the output frame). Use the
 * even-odd winding rule for the result: clipper-lib's holes are separate paths.
 */
export function pathsToData(paths: Paths, transform: Transform): string {
  const toLocal = invert(transform)
  const format = (value: number) => String(Math.round(value * 1000) / 1000)
  return paths
    .map((path) => {
      const commands = path.map((point, index) => {
        const local = apply(toLocal, { x: point.X / GEOMETRY_SCALE, y: point.Y / GEOMETRY_SCALE })
        return `${index === 0 ? 'M' : 'L'} ${format(local.x)} ${format(local.y)}`
      })
      return `${commands.join(' ')} Z`
    })
    .join(' ')
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export function apply(transform: Transform, point: Point): Point {
  const [[a, b, tx], [c, d, ty]] = transform
  return { x: a * point.x + b * point.y + tx, y: c * point.x + d * point.y + ty }
}

/** The transform that applies `inner` first, then `outer`. */
export function compose(outer: Transform, inner: Transform): Transform {
  const [[a, b, tx], [c, d, ty]] = outer
  const [[e, f, ux], [g, h, uy]] = inner
  return [
    [a * e + b * g, a * f + b * h, a * ux + b * uy + tx],
    [c * e + d * g, c * f + d * h, c * ux + d * uy + ty],
  ]
}

export function invert(transform: Transform): Transform {
  const [[a, b, tx], [c, d, ty]] = transform
  const determinant = a * d - b * c
  return [
    [d / determinant, -b / determinant, (b * ty - d * tx) / determinant],
    [-c / determinant, a / determinant, (c * tx - a * ty) / determinant],
  ]
}

function toIntPoint(point: Point): ClipperLib.IntPoint {
  return { X: Math.round(point.x * GEOMETRY_SCALE), Y: Math.round(point.y * GEOMETRY_SCALE) }
}
