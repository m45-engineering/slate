'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { editableSvgLayout } from '@/lib/control-structure/svg-layout';
import type { ControlLayout } from '@/lib/control-structure/layout';
import { ZoomIn, ZoomOut, Maximize2, Expand, X } from 'lucide-react';
import { EditorIconButton } from './editor-icon-button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';

type NodeEditing = { positions?: ControlLayout; onMove?(positions: ControlLayout): void };
type Layout = { width: number; height: number; viewportWidth: number; viewportHeight: number; fit: number };
type View = { scale: number; x: number; y: number };

export function DiagramViewer({ svg, title = 'Mermaid diagram', selectedId, onCanvasClick, positions, onMove, fill = false, expandable = true, preserveViewport = false }: NodeEditing & { expandable?: boolean; preserveViewport?: boolean; svg: string; title?: string; fill?: boolean; selectedId?: string; onCanvasClick?(target: Element, point?: { x: number; y: number }): void }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  if (!expandable) return <DiagramCanvas preserveViewport={preserveViewport} positions={positions} onMove={onMove} fill={fill} selectedId={selectedId} onCanvasClick={onCanvasClick} title={title} svg={svg} />;

  return <Dialog open={expanded} onOpenChange={setExpanded}>
    <DiagramCanvas preserveViewport={preserveViewport} positions={positions} onMove={onMove} fill={fill} selectedId={selectedId} onCanvasClick={onCanvasClick} title={title} svg={svg} suspended={expanded} action={<DialogTrigger asChild>
      <EditorIconButton label="Expand diagram"><Expand aria-hidden="true" /></EditorIconButton>
    </DialogTrigger>} />
    <DialogContent ref={dialog} className="diagram-dialog" aria-describedby={undefined} onOpenAutoFocus={event => {
      event.preventDefault();
      dialog.current?.querySelector<HTMLElement>('.diagram-viewport')?.focus();
    }}>
      <DiagramCanvas preserveViewport={preserveViewport} positions={positions} onMove={onMove} selectedId={selectedId} onCanvasClick={onCanvasClick} title={title} svg={svg} expanded action={
        <EditorIconButton label="Close expanded diagram" onClick={() => setExpanded(false)}><X aria-hidden="true" /></EditorIconButton>
      } />
    </DialogContent>
  </Dialog>;
}

function DiagramCanvas({ svg, expanded = false, suspended = false, action, title, selectedId, onCanvasClick, positions, onMove, fill = false, preserveViewport = false }: NodeEditing & {
  preserveViewport?: boolean; fill?: boolean; selectedId?: string; onCanvasClick?(target: Element, point?: { x: number; y: number }): void; title: string; svg: string; expanded?: boolean; suspended?: boolean; action?: React.ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number; moved: boolean; target: Element } | null>(null);
  const renderedSvg = useRef<SVGSVGElement | null>(null);
  const geometry = useRef<ReturnType<typeof editableSvgLayout> | null>(null);
  const moving = useRef<{ id: string; positions: ControlLayout; inverse: DOMMatrix; start: DOMPoint } | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const hasFitted = useRef(false);
  const zoomBase = useRef(1);
  const [panning, setPanning] = useState(false);

  const editable = !!onMove;
  useLayoutEffect(() => {
    const element = canvas.current?.querySelector('svg');
    if (element !== renderedSvg.current) { geometry.current = null; renderedSvg.current = element ?? null; }
    if (element && editable && !geometry.current) geometry.current = editableSvgLayout(element);
  }, [svg, suspended, editable]);

  useLayoutEffect(() => { geometry.current?.draw(positions ?? {}, true); }, [svg, positions, suspended, editable]);

  useLayoutEffect(() => {
    for (const element of canvas.current?.querySelectorAll<HTMLElement>('[data-diagram-id]') ?? []) {
      const selected = element.dataset.diagramId === selectedId;
      element.classList.toggle('is-selected', selected);
      if (element.getAttribute('role') === 'button') element.setAttribute('aria-pressed', String(selected));
    }
  }, [svg, selectedId, suspended]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const box = canvas.current?.querySelector('svg')?.viewBox.baseVal;
    if (!element || !box?.width || !box.height) return;
    let previousWidth = 0;
    let previousHeight = 0;
    const resize = () => {
      const width = element.clientWidth;
      if (!width) return;
      const height = expanded || fill ? element.clientHeight : Math.max(120, Math.min(box.height, box.height * width / box.width, window.innerHeight * 0.65, 560));
      if (!height) return;
      if (width === previousWidth && height === previousHeight) return;
      previousWidth = width; previousHeight = height;
      const fit = Math.min(1, width / box.width, height / box.height);
      setLayout({ width: box.width, height: box.height, viewportWidth: width, viewportHeight: height, fit });
      // Selection, inspector resizing, and editing the SVG must all retain the
      // user's viewport. Fit once on open; subsequent fits are explicit actions.
      if (!preserveViewport || !hasFitted.current) {
        hasFitted.current = true;
        zoomBase.current = fit;
        setView({ scale: fit, x: (width - box.width * fit) / 2, y: (height - box.height * fit) / 2 });
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [svg, expanded, fill, positions, editable, preserveViewport]);

  const fit = useCallback(() => {
    if (layout) {
      zoomBase.current = layout.fit;
      setView({ scale: layout.fit, x: (layout.viewportWidth - layout.width * layout.fit) / 2, y: (layout.viewportHeight - layout.height * layout.fit) / 2 });
    }
  }, [layout]);

  const zoom = useCallback((factor: number, point?: { x: number; y: number }) => {
    if (!layout) return;
    const anchor = point ?? { x: layout.viewportWidth / 2, y: layout.viewportHeight / 2 };
    setView(current => {
      const scale = Math.max(layout.fit * 0.5, Math.min(layout.fit * 16, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: anchor.x - (anchor.x - current.x) * ratio, y: anchor.y - (anchor.y - current.y) * ratio };
    });
  }, [layout]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || !layout) return;
      event.preventDefault(); event.stopPropagation();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoom(Math.exp(-delta * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    // React's wheel listener can be passive; zoom needs to keep the document from scrolling.
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [layout, zoom]);

  return <div className={`diagram-viewer${fill ? ' diagram-viewer-fill' : ''}`}>
    <div className="diagram-controls">
      {expanded ? <DialogTitle className="diagram-dialog-title">{title}</DialogTitle> : <span className="diagram-instructions">{onMove ? 'Drag boxes to arrange · Drag background to pan' : 'Scroll to zoom · Drag to move'}</span>}
      <EditorIconButton label="Zoom out diagram" onClick={() => zoom(1 / 1.25)}><ZoomOut aria-hidden="true" /></EditorIconButton>
      <output aria-label="Diagram zoom">{layout ? Math.round(view.scale / zoomBase.current * 100) : 100}%</output>
      <EditorIconButton label="Zoom in diagram" onClick={() => zoom(1.25)}><ZoomIn aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Fit diagram" onClick={fit}><Maximize2 aria-hidden="true" /></EditorIconButton>
      {action}
    </div>
    <div ref={viewport} className={`diagram-viewport${panning ? ' is-panning' : ''}`} style={expanded || fill ? undefined : { height: layout?.viewportHeight ?? 120 }}
      tabIndex={0} role="group" aria-label="Diagram canvas" aria-description={onMove ? "Drag boxes to arrange · Drag background to pan · Scroll to zoom" : "Scroll to zoom · Drag to move"} onDoubleClick={fit}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, target: event.target as Element };
        const node = (event.target as Element).closest<SVGGElement>('.control-component');
        const root = canvas.current?.querySelector('svg');
        if (node && root && geometry.current && onMove) {
          const inverse = root.getScreenCTM()!.inverse();
          moving.current = { id: node.dataset.diagramId!, positions: { ...geometry.current.initial, ...positions }, inverse, start: new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse) };
        }
        setPanning(true);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const x = event.clientX - current.x;
        const y = event.clientY - current.y;
        drag.current = { ...current, x: event.clientX, y: event.clientY, moved: current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 4 };
        if (moving.current && geometry.current) {
          const move = moving.current;
          const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(move.inverse);
          const start = move.positions[move.id];
          geometry.current.draw({ ...move.positions, [move.id]: { ...start, x: start.x + point.x - move.start.x, y: start.y + point.y - move.start.y } });
        } else setView(value => ({ ...value, x: value.x + x, y: value.y + y }));
      }}
      onPointerUp={event => {
        const gesture = drag.current;
        const move = moving.current;
        moving.current = null;
        if (move && gesture?.moved) {
          const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(move.inverse);
          const start = move.positions[move.id];
          onMove?.({ ...move.positions, [move.id]: { ...start, x: start.x + point.x - move.start.x, y: start.y + point.y - move.start.y } });
        } else if (move) geometry.current?.draw(positions ?? {});
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null; setPanning(false);
        if (gesture && !gesture.moved) onCanvasClick?.(gesture.target, { x: event.clientX, y: event.clientY });
      }}
      onLostPointerCapture={() => { if (moving.current) geometry.current?.draw(positions ?? {}); moving.current = null; drag.current = null; setPanning(false); }}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') zoom(1.25);
        else if (event.key === '-') zoom(1 / 1.25);
        else if (event.key === '0') fit();
        else if (event.key.startsWith('Arrow')) setView(current => ({ ...current,
          x: current.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0),
          y: current.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0),
        }));
        else return;
        event.preventDefault(); event.stopPropagation();
      }}>
      <div ref={canvas} className="diagram-canvas" role={onCanvasClick ? "group" : "img"} aria-label={title}
        style={{ width: layout?.width, height: layout?.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        // Keep the inline view's state, but avoid duplicate SVG IDs while the dialog is open.
        dangerouslySetInnerHTML={{ __html: suspended ? '' : svg }} />
    </div>
  </div>;
}
