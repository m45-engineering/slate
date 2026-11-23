import type { AuthoringResult } from './schema.ts';

export type NodePosition = { x: number; y: number; width?: number; height?: number };
export type ControlLayout = Record<string, NodePosition>;
export function validPosition(value: unknown): value is NodePosition {
  if (!value || typeof value !== 'object') return false;
  const point = value as NodePosition;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
export function retainedLayout(layout: ControlLayout, result: AuthoringResult): ControlLayout {
  return Object.fromEntries(result.graph.components.filter(c => validPosition(layout[c.id])).map(c => [c.id, layout[c.id]]));
}
