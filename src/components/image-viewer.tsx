'use client';

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { SlateDocument } from '@/lib/document';
import { imageMimeType } from '../../electron/file-types.cjs';
import { NativeSelect } from './ui/native-select';
import { OpenOriginal, PreviewButton, type PreviewHandle } from './preview-controls';

export const ImageViewer = forwardRef<PreviewHandle, { document: SlateDocument; onError(message: string): void }>(function ImageViewer({ document: doc, onError }, ref) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | 'fit'>('fit');
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = image.current;
    setError(Boolean(element?.complete && !element.naturalWidth));
    setDimensions({ width: element?.complete ? element.naturalWidth : 0, height: element?.complete ? element.naturalHeight : 0 });
    setScale('fit');
  }, [doc.content]);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const fit = dimensions.width ? Math.min(1, Math.max(1, available.width - 64) / dimensions.width, Math.max(1, available.height - 64) / dimensions.height) : 1;
  const actualScale = scale === 'fit' ? fit : scale;
  const scaleRef = useRef(actualScale);
  scaleRef.current = actualScale;
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const zoom = (direction: 'in' | 'out' | 'reset') => setScale(direction === 'reset' ? 1 : Math.max(.1, Math.min(8, scaleRef.current * (direction === 'in' ? 1.25 : .8))));
  useImperativeHandle(ref, () => ({ zoom, find() {}, findNext() {} }));
  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(([entry]) => setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = image.current?.getBoundingClientRect();
      if (!rect?.width) return;
      anchor.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, clientX: event.clientX, clientY: event.clientY };
      setScale(Math.max(.1, Math.min(8, scaleRef.current * Math.exp(-event.deltaY * .01))));
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);
  useLayoutEffect(() => {
    const point = anchor.current;
    const rect = image.current?.getBoundingClientRect();
    if (point && rect && viewport.current) {
      viewport.current.scrollLeft += rect.left + rect.width * point.x - point.clientX;
      viewport.current.scrollTop += rect.top + rect.height * point.y - point.clientY;
      anchor.current = null;
    }
  }, [actualScale]);
  return <section className="file-preview" aria-label="Image viewer">
    <header className="preview-toolbar">
      <span className="preview-description">{dimensions.width ? `${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()} px` : 'Image'}</span>
      <div className="preview-actions">
        <PreviewButton label="Zoom out" disabled={actualScale <= .1} onClick={() => zoom('out')}><Minus /></PreviewButton>
        <NativeSelect aria-label="Image zoom" value={scale === 'fit' ? 'fit' : String(actualScale)} onChange={event => setScale(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}>
          <option value="fit">Fit image</option>
          {[...new Set([.25, .5, 1, 1.5, 2, 4, 8, ...(scale === 'fit' ? [] : [scale])])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{Math.round(value * 100)}%{value === 1 ? ' · Actual size' : ''}</option>)}
        </NativeSelect>
        <PreviewButton label="Zoom in" disabled={actualScale >= 8} onClick={() => zoom('in')}><Plus /></PreviewButton>
        <OpenOriginal id={doc.id} onError={onError} />
      </div>
    </header>
    <div ref={viewport} className="image-viewport" tabIndex={0} aria-label="Image canvas" onPointerDown={event => {
      if (event.button !== 0) return;
      const element = viewport.current!;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
      element.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const start = drag.current;
      if (!start || !viewport.current) return;
      viewport.current.scrollLeft = start.left + start.x - event.clientX;
      viewport.current.scrollTop = start.top + start.y - event.clientY;
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {error ? <p role="alert" className="preview-message">Slate could not display this image. Try opening it in its default app.</p> : <div className="image-stage">
        {/* Images, including SVGs, stay in an inert image context rather than inline markup. */}
        <img ref={image} src={`data:${imageMimeType(doc.name)};base64,${doc.content}`} alt={doc.name} draggable={false} onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError(true)} style={dimensions.width ? { width: dimensions.width * actualScale, height: dimensions.height * actualScale } : { maxWidth: '100%' }} />
      </div>}
    </div>
  </section>;
});
