import type { ControlLayout, NodePosition } from './layout';
import { getOrthogonalRoute, Position } from './orthogonal-route';

const coordinate = (value: number) => Math.round(value * 1e6) / 1e6;

// Work in SVG coordinates, independent of zoom, pan, and nested Mermaid groups.
export function editableSvgLayout(svg: SVGSVGElement) {
  const rootMatrix = svg.getScreenCTM()!;
  const toRoot = (element: SVGGraphicsElement) => rootMatrix.inverse().multiply(element.getScreenCTM()!);
  const nodes = [...svg.querySelectorAll<SVGGElement>('.control-component')].map(element => {
    const box = element.getBBox(), matrix = toRoot(element);
    const point = new DOMPoint(box.x, box.y).matrixTransform(matrix);
    return { element, id: element.dataset.diagramId!, position: { x: point.x, y: point.y, width: box.width, height: box.height }, transform: element.getAttribute('transform') ?? '', parent: toRoot(element.parentElement as unknown as SVGGraphicsElement).inverse() };
  });
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const paths = [...svg.querySelectorAll<SVGPathElement>('.control-connection')];
  const pair = (path: SVGPathElement) => [path.dataset.sourceId, path.dataset.targetId].sort().join(':');
  function port(point: DOMPoint, box: NodePosition & { width: number; height: number }) {
    const sides = [
      { side: Position.Top, gap: point.y - box.y, offset: point.x - box.x - box.width / 2 },
      { side: Position.Bottom, gap: point.y - box.y - box.height, offset: point.x - box.x - box.width / 2 },
      { side: Position.Left, gap: point.x - box.x, offset: point.y - box.y - box.height / 2 },
      { side: Position.Right, gap: point.x - box.x - box.width, offset: point.y - box.y - box.height / 2 },
    ];
    return sides.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))[0];
  }
  const edges = paths.map(element => {
    const matrix = toRoot(element), inverse = matrix.inverse(), length = element.getTotalLength();
    const first = element.getPointAtLength(0), last = element.getPointAtLength(length);
    const start = new DOMPoint(first.x, first.y).matrixTransform(matrix);
    const end = new DOMPoint(last.x, last.y).matrixTransform(matrix);
    const from = element.dataset.sourceId!, to = element.dataset.targetId!;
    const sourcePort = port(start, nodeById.get(from)!.position), targetPort = port(end, nodeById.get(to)!.position);
    const siblings = paths.filter(path => pair(path) === pair(element));
    const routeOffset = (siblings.indexOf(element) - (siblings.length - 1) / 2) * 24;
    const label = [...svg.querySelectorAll<SVGGElement>('.control-connection-label')].find(label => label.dataset.diagramId === element.dataset.diagramId);
    const labelBox = label?.getBBox();
    const labelCenter = label && labelBox ? new DOMPoint(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2).matrixTransform(toRoot(label)) : null;
    return { element, originalPath: element.getAttribute('d')!, inverse, from, to, sourcePort, targetPort, routeOffset, hit: element.previousElementSibling,
      label, labelBox, labelCenter, labelTransform: label?.getAttribute('transform') ?? '', labelParent: label ? toRoot(label.parentElement as unknown as SVGGraphicsElement).inverse() : null };
  });
  const originalBox = { x: svg.viewBox.baseVal.x, y: svg.viewBox.baseVal.y, width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height };
  const initial = Object.fromEntries(nodes.map(n => [n.id, n.position]));
  function draw(positions: ControlLayout, resize = false) {
    const deltas: Record<string, NodePosition> = {};
    for (const node of nodes) {
      const target = positions[node.id] ?? node.position;
      const delta = { x: coordinate(target.x - node.position.x), y: coordinate(target.y - node.position.y) };
      deltas[node.id] = delta;
      const origin = new DOMPoint(0, 0).matrixTransform(node.parent);
      const shifted = new DOMPoint(delta.x, delta.y).matrixTransform(node.parent);
      node.element.setAttribute('transform', `translate(${coordinate(shifted.x - origin.x)},${coordinate(shifted.y - origin.y)}) ${node.transform}`);
    }
    const routeExtents: NodePosition[] = [];
    for (const edge of edges) {
      const from = deltas[edge.from], to = deltas[edge.to];
      if (!from || !to) continue;
      let path = edge.originalPath, labelX = edge.labelCenter?.x ?? 0, labelY = edge.labelCenter?.y ?? 0;
      if (from.x || from.y || to.x || to.y) {
        const source = nodeById.get(edge.from)!.position, target = nodeById.get(edge.to)!.position;
        const sourceBounds = { ...source, x: source.x + from.x, y: source.y + from.y };
        const targetBounds = { ...target, x: target.x + to.x, y: target.y + to.y };
        const route = getOrthogonalRoute({
          sourceX: sourceBounds.x, sourceY: sourceBounds.y, sourceBounds, sourcePosition: edge.sourcePort.side, sourceAnchorOffset: edge.sourcePort.offset,
          targetX: targetBounds.x, targetY: targetBounds.y, targetBounds, targetPosition: edge.targetPort.side, targetAnchorOffset: edge.targetPort.offset,
          routeOffset: edge.routeOffset, labelOffset: 0,
        });
        // Leave room for Mermaid's arrowhead at the destination boundary.
        const tip = route.points.at(-1)!;
        const gap = Math.abs(edge.targetPort.gap);
        if (edge.targetPort.side === Position.Top) tip.y -= gap;
        else if (edge.targetPort.side === Position.Bottom) tip.y += gap;
        else if (edge.targetPort.side === Position.Left) tip.x -= gap;
        else tip.x += gap;
        path = route.points.map((point, i) => {
          routeExtents.push(point);
          const p = new DOMPoint(point.x, point.y).matrixTransform(edge.inverse);
          return `${i ? 'L' : 'M'}${coordinate(p.x)},${coordinate(p.y)}`;
        }).join(' ');
        labelX = route.labelX; labelY = route.labelY;
        if (edge.labelBox) {
          routeExtents.push({ x: labelX - edge.labelBox.width / 2, y: labelY - edge.labelBox.height / 2 },
            { x: labelX + edge.labelBox.width / 2, y: labelY + edge.labelBox.height / 2 });
        }
      }
      edge.element.setAttribute('d', path);
      edge.hit?.setAttribute('d', path);
      if (edge.label && edge.labelParent && edge.labelCenter) {
        const origin = new DOMPoint(0, 0).matrixTransform(edge.labelParent);
        const shifted = new DOMPoint(labelX - edge.labelCenter.x, labelY - edge.labelCenter.y).matrixTransform(edge.labelParent);
        edge.label.setAttribute('transform', `translate(${coordinate(shifted.x - origin.x)},${coordinate(shifted.y - origin.y)}) ${edge.labelTransform}`);
      }
    }
    if (resize) {
      const points = [...nodes.map(n => ({ ...n.position, x: n.position.x + deltas[n.id].x, y: n.position.y + deltas[n.id].y })), ...routeExtents];
      const x = Math.min(originalBox.x, ...points.map(p => p.x - 24));
      const y = Math.min(originalBox.y, ...points.map(p => p.y - 24));
      const right = Math.max(originalBox.x + originalBox.width, ...points.map(p => p.x + (p.width ?? 0) + 24));
      const bottom = Math.max(originalBox.y + originalBox.height, ...points.map(p => p.y + (p.height ?? 0) + 24));
      svg.setAttribute('viewBox', `${x} ${y} ${right - x} ${bottom - y}`);
    }
  }
  return { initial, draw };
}
