// Pure routing logic ported from M45 ControlStructureEdge; no React Flow dependency.
export const Position = { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' } as const
export type Position = typeof Position[keyof typeof Position]

interface OrthogonalRouteInput {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  sourceBounds?: NodeBounds
  targetBounds?: NodeBounds
  sourceAnchorOffset?: number
  targetAnchorOffset?: number
  routeOffset: number
  sourceStubOffset?: number
  targetStubOffset?: number
  labelOffset: number
}

interface Point {
  x: number
  y: number
}

interface NodeBounds {
  x: number
  y: number
  width: number
  height: number
}

export function getOrthogonalRoute(input: OrthogonalRouteInput): {
  path: string
  points: Point[]
  labelX: number
  labelY: number
} {
  const points = avoidEndpointBoxes(buildRoutePoints(input), input)
  const longestSegment = findLongestSegment(points)
  const label = labelPointForSegment(
    longestSegment.start,
    longestSegment.end,
    input.labelOffset,
  )

  return {
    path: pointsToPath(points),
    points,
    labelX: label.x,
    labelY: label.y,
  }
}

function avoidEndpointBoxes(points: Point[], input: OrthogonalRouteInput): Point[] {
  const bounds = [input.sourceBounds, input.targetBounds].filter((box): box is NodeBounds => Boolean(box))
  const crossesBox = (route: Point[]) => bounds.some(box => routeCrossesBounds(route, box))
  if (!crossesBox(points)) return points

  // After a box moves, the saved side may face away from the other box.
  // Keep that attachment and find a short route around both endpoint boxes.
  const source = points[0], target = points[points.length - 1]
  const sourceStub = add(source, multiply(directionForPosition(input.sourcePosition), MANUAL_ROUTE_STUB))
  const targetStub = add(target, multiply(directionForPosition(input.targetPosition), MANUAL_ROUTE_STUB))
  const xs = [Math.min(...bounds.map(box => box.x), sourceStub.x, targetStub.x) - MANUAL_ROUTE_STUB,
    Math.max(...bounds.map(box => box.x + box.width), sourceStub.x, targetStub.x) + MANUAL_ROUTE_STUB]
  const ys = [Math.min(...bounds.map(box => box.y), sourceStub.y, targetStub.y) - MANUAL_ROUTE_STUB,
    Math.max(...bounds.map(box => box.y + box.height), sourceStub.y, targetStub.y) + MANUAL_ROUTE_STUB]
  const candidates: Point[][] = [
    [sourceStub, { x: sourceStub.x, y: targetStub.y }, targetStub],
    [sourceStub, { x: targetStub.x, y: sourceStub.y }, targetStub],
    ...xs.map(x => [sourceStub, { x, y: sourceStub.y }, { x, y: targetStub.y }, targetStub]),
    ...ys.map(y => [sourceStub, { x: sourceStub.x, y }, { x: targetStub.x, y }, targetStub]),
    ...xs.flatMap(x => ys.flatMap(y => [
      [sourceStub, { x, y: sourceStub.y }, { x, y }, { x: targetStub.x, y }, targetStub],
      [sourceStub, { x: sourceStub.x, y }, { x, y }, { x, y: targetStub.y }, targetStub],
    ])),
  ]
  const route = candidates.map(candidate => compactPoints([source, ...candidate, target]))
    .filter(candidate => !crossesBox(candidate))
    .sort((a, b) => routeLength(a) - routeLength(b))[0]
  return route ?? points
}

function buildRoutePoints({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceBounds,
  targetBounds,
  sourceAnchorOffset = 0,
  targetAnchorOffset = 0,
  routeOffset,
  sourceStubOffset = 0,
  targetStubOffset = 0,
}: OrthogonalRouteInput): Point[] {
  const source = boundaryAnchor(
    { x: sourceX, y: sourceY },
    sourcePosition,
    sourceAnchorOffset,
    sourceBounds,
  )
  const target = boundaryAnchor(
    { x: targetX, y: targetY },
    targetPosition,
    targetAnchorOffset,
    targetBounds,
  )
  const sourceDirection = directionForPosition(sourcePosition)
  const targetDirection = directionForPosition(targetPosition)
  const stubLength = Math.max(28, Math.min(72, distance(source, target) * 0.18))
  const sourceStub = add(
    source,
    multiply(sourceDirection, stubLength + sourceStubOffset),
  )
  const targetStub = add(
    target,
    multiply(targetDirection, stubLength + targetStubOffset),
  )
  const shouldRouteVertically =
    isVerticalPosition(sourcePosition) || isVerticalPosition(targetPosition)

  if (
    !shouldRouteVertically &&
    areOpposingHorizontalHandles(sourcePosition, targetPosition) &&
    Math.abs(source.y - target.y) <= 1
  ) {
    return compactPoints([source, target])
  }

  if (
    shouldRouteVertically &&
    areOpposingVerticalHandles(sourcePosition, targetPosition) &&
    Math.abs(source.x - target.x) <= 1
  ) {
    return compactPoints([source, target])
  }

  if (
    shouldRouteVertically &&
    areOpposingVerticalHandles(sourcePosition, targetPosition)
  ) {
    const correctionY =
      (sourcePosition === Position.Top ? sourceStub.y : targetStub.y) +
      routeOffset
    return compactPoints([
      source,
      sourceStub,
      { x: sourceStub.x, y: correctionY },
      { x: targetStub.x, y: correctionY },
      targetStub,
      target,
    ])
  }

  if (
    !shouldRouteVertically &&
    areOpposingHorizontalHandles(sourcePosition, targetPosition)
  ) {
    const correctionX =
      (sourcePosition === Position.Left ? sourceStub.x : targetStub.x) +
      routeOffset
    return compactPoints([
      source,
      sourceStub,
      { x: correctionX, y: sourceStub.y },
      { x: correctionX, y: targetStub.y },
      targetStub,
      target,
    ])
  }

  if (
    !shouldRouteVertically &&
    sourcePosition === targetPosition &&
    sourcePosition !== Position.Top &&
    sourcePosition !== Position.Bottom
  ) {
    const sideDirection = sourcePosition === Position.Left ? -1 : 1
    const baseX =
      sourcePosition === Position.Left
        ? Math.min(sourceStub.x, targetStub.x)
        : Math.max(sourceStub.x, targetStub.x)
    const routeX = baseX + sideDirection * (Math.abs(routeOffset) + 18)
    return compactPoints([
      source,
      sourceStub,
      { x: routeX, y: sourceStub.y },
      { x: routeX, y: targetStub.y },
      targetStub,
      target,
    ])
  }

  if (shouldRouteVertically) {
    const routeX = routeCoordinate({
      source: sourceStub.x,
      target: targetStub.x,
      sourcePosition,
      targetPosition,
      routeOffset,
      vertical: true,
    })
    return compactPoints([
      source,
      sourceStub,
      { x: routeX, y: sourceStub.y },
      { x: routeX, y: targetStub.y },
      targetStub,
      target,
    ])
  }

  const routeY = routeCoordinate({
    source: sourceStub.y,
    target: targetStub.y,
    sourcePosition,
    targetPosition,
    routeOffset,
    vertical: false,
  })
  return compactPoints([
    source,
    sourceStub,
    { x: sourceStub.x, y: routeY },
    { x: targetStub.x, y: routeY },
    targetStub,
    target,
  ])
}

function routeCoordinate({
  source,
  sourcePosition,
  target,
  targetPosition,
  routeOffset,
  vertical,
}: {
  source: number
  target: number
  sourcePosition: Position
  targetPosition: Position
  routeOffset: number
  vertical: boolean
}): number {
  const sourceIsAligned = vertical
    ? !isVerticalPosition(sourcePosition)
    : isVerticalPosition(sourcePosition)
  const targetIsAligned = vertical
    ? !isVerticalPosition(targetPosition)
    : isVerticalPosition(targetPosition)
  const base = sourceIsAligned
    ? source
    : targetIsAligned
      ? target
      : (source + target) / 2
  return base + routeOffset
}

function pointsToPath(points: Point[]): string {
  const [first, ...rest] = points
  return [
    `M ${formatCoord(first.x)} ${formatCoord(first.y)}`,
    ...rest.map((point) => `L ${formatCoord(point.x)} ${formatCoord(point.y)}`),
  ].join(" ")
}

function findLongestSegment(points: Point[]): { start: Point; end: Point } {
  let longest = { start: points[0], end: points[points.length - 1], length: 0 }
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
    if (length > longest.length) {
      longest = { start, end, length }
    }
  }
  return longest
}

function labelPointForSegment(start: Point, end: Point, labelOffset: number): Point {
  const isVertical = Math.abs(end.y - start.y) > Math.abs(end.x - start.x)
  const defaultNudge = labelOffset >= 0 ? 1 : -1
  const offset =
    Math.abs(labelOffset) > 0 ? labelOffset : defaultNudge * LABEL_LINE_GAP
  return {
    x: (start.x + end.x) / 2 + (isVertical ? offset : 0),
    y: (start.y + end.y) / 2 + (isVertical ? 0 : -offset),
  }
}

const LABEL_LINE_GAP = 22

function formatCoord(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function directionForPosition(position: Position): Point {
  if (position === Position.Top) return { x: 0, y: -1 }
  if (position === Position.Bottom) return { x: 0, y: 1 }
  if (position === Position.Left) return { x: -1, y: 0 }
  return { x: 1, y: 0 }
}

function boundaryAnchor(
  fallback: Point,
  position: Position,
  offset: number,
  bounds: NodeBounds | undefined,
): Point {
  if (!bounds) {
    return offsetAnchor(fallback, position, offset)
  }
  const minX = bounds.x
  const maxX = bounds.x + bounds.width
  const minY = bounds.y
  const maxY = bounds.y + bounds.height
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const inset = 6

  if (position === Position.Top) {
    return {
      x: clamp(centerX + offset, minX + inset, maxX - inset),
      y: minY,
    }
  }
  if (position === Position.Bottom) {
    return {
      x: clamp(centerX + offset, minX + inset, maxX - inset),
      y: maxY,
    }
  }
  if (position === Position.Left) {
    return {
      x: minX,
      y: clamp(centerY + offset, minY + inset, maxY - inset),
    }
  }
  return {
    x: maxX,
    y: clamp(centerY + offset, minY + inset, maxY - inset),
  }
}

function offsetAnchor(point: Point, position: Position, offset: number): Point {
  if (position === Position.Top || position === Position.Bottom) {
    return { x: point.x + offset, y: point.y }
  }
  return { x: point.x, y: point.y + offset }
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2
  return Math.min(max, Math.max(min, value))
}

function isVerticalPosition(position: Position): boolean {
  return position === Position.Top || position === Position.Bottom
}

function areOpposingHorizontalHandles(
  sourcePosition: Position,
  targetPosition: Position,
): boolean {
  return (
    (sourcePosition === Position.Right && targetPosition === Position.Left) ||
    (sourcePosition === Position.Left && targetPosition === Position.Right)
  )
}

function areOpposingVerticalHandles(
  sourcePosition: Position,
  targetPosition: Position,
): boolean {
  return (
    (sourcePosition === Position.Bottom && targetPosition === Position.Top) ||
    (sourcePosition === Position.Top && targetPosition === Position.Bottom)
  )
}

function routeLength(points: Point[]): number {
  return points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0)
}

function routeCrossesBounds(points: Point[], bounds: NodeBounds): boolean {
  return points.slice(1).some((end, index) => {
    const start = points[index]
    if (start.x === end.x) return start.x > bounds.x && start.x < bounds.x + bounds.width && Math.max(start.y, end.y) > bounds.y && Math.min(start.y, end.y) < bounds.y + bounds.height
    return start.y > bounds.y && start.y < bounds.y + bounds.height && Math.max(start.x, end.x) > bounds.x && Math.min(start.x, end.x) < bounds.x + bounds.width
  })
}

function add(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y }
}

function multiply(point: Point, scalar: number): Point {
  return { x: point.x * scalar, y: point.y * scalar }
}

function distance(left: Point, right: Point): number {
  return Math.abs(right.x - left.x) + Math.abs(right.y - left.y)
}

function compactPoints(points: Point[]): Point[] {
  const nonDuplicate = points.filter((point, index) => {
    if (index === 0) return true
    const previous = points[index - 1]
    return Math.abs(point.x - previous.x) > 0.5 || Math.abs(point.y - previous.y) > 0.5
  })
  const compacted: Point[] = []
  for (const point of nonDuplicate) {
    compacted.push(point)
    while (compacted.length >= 3) {
      const previousPrevious = compacted[compacted.length - 3]
      const previous = compacted[compacted.length - 2]
      const current = compacted[compacted.length - 1]
      const sameHorizontal =
        Math.abs(previousPrevious.y - previous.y) <= 0.5 &&
        Math.abs(previous.y - current.y) <= 0.5
      const sameVertical =
        Math.abs(previousPrevious.x - previous.x) <= 0.5 &&
        Math.abs(previous.x - current.x) <= 0.5
      if (!sameHorizontal && !sameVertical) break
      compacted.splice(compacted.length - 2, 1)
    }
  }
  return compacted
}

const MANUAL_ROUTE_STUB = 32
