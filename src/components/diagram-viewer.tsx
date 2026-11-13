'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './ui/button';

type Layout = { width: number; height: number; viewportWidth: number; viewportHeight: number; fit: number };
type View = { scale: number; x: number; y: number };

export function DiagramViewer({ svg }: { svg: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  useLayoutEffect(() => {
    const element = viewport.current;
    const box = canvas.current?.querySelector('svg')?.viewBox.baseVal;
    if (!element || !box?.width || !box.height) return;
    let previousWidth = 0;
    let previousHeight = 0;
    const resize = () => {
      const width = element.clientWidth;
      if (!width) return;
      const height = Math.max(120, Math.min(box.height, box.height * width / box.width, window.innerHeight * 0.65, 560));
      if (width === previousWidth && height === previousHeight) return;
      previousWidth = width; previousHeight = height;
      const fit = Math.min(1, width / box.width, height / box.height);
      setLayout({ width: box.width, height: box.height, viewportWidth: width, viewportHeight: height, fit });
      setView({ scale: fit, x: (width - box.width * fit) / 2, y: (height - box.height * fit) / 2 });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [svg]);

  const fit = useCallback(() => {
    if (layout) setView({ scale: layout.fit, x: (layout.viewportWidth - layout.width * layout.fit) / 2, y: (layout.viewportHeight - layout.height * layout.fit) / 2 });
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

  return <div className="diagram-viewer">
    <div className="diagram-controls">
      <span>Scroll to zoom · Drag to move</span>
      <Button variant="ghost" size="sm" aria-label="Zoom out diagram" onClick={() => zoom(1 / 1.25)}>−</Button>
      <output aria-label="Diagram zoom">{layout ? Math.round(view.scale / layout.fit * 100) : 100}%</output>
      <Button variant="ghost" size="sm" aria-label="Zoom in diagram" onClick={() => zoom(1.25)}>+</Button>
      <Button variant="ghost" size="sm" aria-label="Fit diagram" onClick={fit}>Fit</Button>
    </div>
    <div ref={viewport} className={`diagram-viewport${panning ? ' is-panning' : ''}`} style={{ height: layout?.viewportHeight ?? 120 }}
      tabIndex={0} role="group" aria-label="Diagram canvas" onDoubleClick={fit}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        setPanning(true);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const x = event.clientX - current.x;
        const y = event.clientY - current.y;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        setView(value => ({ ...value, x: value.x + x, y: value.y + y }));
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null; setPanning(false);
      }}
      onLostPointerCapture={() => { drag.current = null; setPanning(false); }}
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
      <div ref={canvas} className="diagram-canvas" role="img" aria-label="Mermaid diagram"
        style={{ width: layout?.width, height: layout?.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  </div>;
}
