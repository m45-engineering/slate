'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { compileAuthoringSource } from '@/lib/control-structure/resolve';
import { controlStructureDiagram } from '@/lib/control-structure/diagram';
import type { AuthoringResult } from '@/lib/control-structure/schema';
import type { ControlLayout } from '@/lib/control-structure/layout';
import { DiagramViewer } from './diagram-viewer';

export function ControlStructurePreview({ source, result: supplied, readOnly = false, selectedId, onSelect, positions, onMove, expandable = true, fill = false }: {
  expandable?: boolean; positions?: ControlLayout; onMove?(positions: ControlLayout): void; source: string; result?: AuthoringResult; readOnly?: boolean; fill?: boolean; selectedId?: string; onSelect?(id: string): void;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const sequence = useRef(0);
  const [view, setView] = useState<{ svg: string; source: string } | null>(null);
  const [error, setError] = useState('');
  const result = supplied ?? compileAuthoringSource(source);
  const valid = result.valid;
  useEffect(() => {
    if (!valid) return;
    let canceled = false;
    const timer = setTimeout(async () => {
      try {
        if (!result.graph.components.length) { if (!canceled) { setView({ svg: '', source }); setError(''); } return; }
        const { renderDiagram } = await import('@/lib/render-diagram');
        await document.fonts.ready;
        let svg = await renderDiagram(controlStructureDiagram(result), `control${id}-${++sequence.current}`, getComputedStyle(document.body).fontFamily);
        if (onSelect && !readOnly) {
          const document = new DOMParser().parseFromString(svg, 'text/html');
          const mark = (element: Element, id: string, label?: string) => {
            element.setAttribute('data-diagram-id', id);
            if (label) {
              element.setAttribute('role', 'button');
              element.setAttribute('tabindex', '0');
              element.setAttribute('aria-label', label);
            }
          };
          for (const node of document.querySelectorAll('g.node')) {
            const index = node.id.match(/flowchart-cs(\d+)-/)?.[1];
            const component = index === undefined ? undefined : result.graph.components[Number(index)];
            if (component) {
              node.classList.add('control-component');
              // Thicken the existing rounded border for selection without changing its role color.
              node.querySelector<SVGRectElement>(':scope > rect')?.style.setProperty('stroke-width', 'var(--control-border-width, 2px)', 'important');
              mark(node, component.id, `Select component ${component.name}`);
            }
          }
          const labels = [...document.querySelectorAll('.edgeLabels g.label[data-id]')];
          // Mermaid emits paths in declaration order. Match each label by its edge ID,
          // so parallel arrows and identical labels still select the right connection.
          document.querySelectorAll('path.flowchart-link').forEach((path, index) => {
            const connection = result.graph.connections[index];
            if (!connection) return;
            mark(path, connection.id);
            path.setAttribute('data-source-id', connection.sourceId);
            path.setAttribute('data-target-id', connection.targetId);
            path.classList.add('control-connection');
            const hit = path.cloneNode(false) as SVGPathElement;
            hit.removeAttribute('id');
            hit.removeAttribute('style');
            hit.removeAttribute('marker-end');
            hit.removeAttribute('marker-start');
            hit.setAttribute('class', 'control-connection-hit');
            hit.setAttribute('aria-hidden', 'true');
            path.before(hit);
            const label = labels.find(label => label.getAttribute('data-id') === path.getAttribute('data-id'));
            if (label) {
              label.classList.add('control-connection-label');
              mark(label, connection.id, `Select connection ${connection.source.name} → ${connection.target.name}: ${connection.label}`);
            }
          });
          svg = new XMLSerializer().serializeToString(document.querySelector('svg')!);
        }
        if (!canceled) { setView({ svg, source }); setError(''); }
      } catch {
        if (!canceled) setError('Could not draw this control structure. The source is preserved.');
      }
    }, 200);
    return () => { canceled = true; clearTimeout(timer); };
    // The source fully defines the preview; supplied identities are stable for that source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, valid, id]);

  const select = (target: Element) => onSelect?.(target.closest('[data-diagram-id]')?.getAttribute('data-diagram-id') ?? '');
  return <div className="control-preview" onKeyDown={event => {
    const target = (event.target as Element).closest('[data-diagram-id]');
    if (target && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation(); select(target);
    } else if (event.key === 'Escape') onSelect?.('');
  }} data-diagram-status={!valid || error ? 'error' : view?.source === source || !source.trim() ? 'ready' : 'pending'}>
    {!valid && <p className="diagram-error" role="status">{view ? 'Last valid preview. ' : ''}Correct the highlighted source to update the diagram.</p>}
    {error && <p className="diagram-error" role="status">{error}</p>}
    {view?.svg && (readOnly ? <div role="img" aria-label="Control structure diagram" dangerouslySetInnerHTML={{ __html: view.svg }} /> : <DiagramViewer expandable={expandable} positions={positions} onMove={valid ? onMove : undefined} fill={fill} svg={view.svg} title="Control structure diagram" selectedId={selectedId} onCanvasClick={onSelect ? select : undefined} />)}
    {!view?.svg && valid && !error && <p className="diagram-loading">{result.graph.components.length ? 'Drawing control structure…' : 'Write a connection or add a component to begin.'}</p>}
  </div>;
}
