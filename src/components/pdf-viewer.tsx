'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Minus, Plus, Search, X } from 'lucide-react';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { PDFViewer as Viewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { SlateDocument } from '@/lib/document';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { OpenOriginal, PreviewButton, type PreviewHandle } from './preview-controls';

export const PdfViewer = forwardRef<PreviewHandle, { document: SlateDocument; onError(message: string): void }>(function PdfViewer({ document: doc, onError }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const bus = useRef<EventBus | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageEntry, setPageEntry] = useState('1');
  const [scale, setScale] = useState('page-width');
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [passwordPrompt, setPasswordPrompt] = useState('');
  const [password, setPassword] = useState('');
  const submitPassword = useRef<((password: string) => void) | null>(null);
  function find() { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }
  function findNext(direction: number) {
    if (!query) { find(); return; }
    bus.current?.dispatch('find', { query, type: 'again', caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: direction < 0, matchDiacritics: false });
  }
  function zoom(direction: 'in' | 'out' | 'reset') {
    if (!viewer.current || !pageCount) return;
    viewer.current.currentScaleValue = direction === 'reset' ? '1' : String(Math.max(.25, Math.min(4, viewer.current.currentScale * (direction === 'in' ? 1.25 : .8))));
  }
  useImperativeHandle(ref, () => ({ zoom, find, findNext }));
  useEffect(() => {
    setPageCount(0); setPage(1); setPageEntry('1'); setError(''); setPasswordPrompt(''); setMatches({ current: 0, total: 0 });
    let disposed = false;
    let task: PDFDocumentLoadingTask | undefined;
    let instance: Viewer | undefined;
    let observer: ResizeObserver | undefined;
    let eventBus: EventBus | undefined;
    const element = container.current!;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (!instance?.pagesCount) return;
      instance.currentScaleValue = String(Math.max(.25, Math.min(4, instance.currentScale * Math.exp(-event.deltaY * .01))));
    }
    element.addEventListener('wheel', wheel, { passive: false });
    void (async () => {
      // The viewer module consumes the PDF.js global installed by the engine.
      const pdfjs = await import('pdfjs-dist');
      const { PDFViewer, EventBus, PDFLinkService, PDFFindController } = await import('pdfjs-dist/web/pdf_viewer.mjs');
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      eventBus = new EventBus();
      const links = new PDFLinkService({ eventBus });
      links.externalLinkEnabled = false;
      const finder = new PDFFindController({ eventBus, linkService: links });
      instance = new PDFViewer({ container: element, viewer: pages.current!, eventBus, linkService: links, findController: finder, annotationMode: pdfjs.AnnotationMode.DISABLE, enableAutoLinking: false, enableSelectionRendering: false, removePageBorders: true });
      viewer.current = instance;
      bus.current = eventBus;
      links.setViewer(instance);
      eventBus.on('pagesinit', () => {
        if (disposed || !instance) return;
        instance.currentScaleValue = 'page-width';
        setPageCount(instance.pagesCount);
      });
      eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => { if (!disposed) { setPage(pageNumber); setPageEntry(String(pageNumber)); } });
      eventBus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => { if (!disposed) setScale(presetValue || String(scale)); });
      const updateMatches = ({ matchesCount }: { matchesCount: { current: number; total: number } }) => { if (!disposed && matchesCount) setMatches(matchesCount); };
      eventBus.on('updatefindmatchescount', updateMatches);
      eventBus.on('updatefindcontrolstate', updateMatches);
      eventBus.on('pagerendered', ({ error }: { error?: Error }) => { if (!disposed && error) setError('This PDF page could not be rendered. Try opening the original in its default app.'); });
      task = pdfjs.getDocument({ data: Uint8Array.from(atob(doc.content), char => char.charCodeAt(0)), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' });
      task.onPassword = (update: (password: string) => void, reason: number) => {
        if (disposed) return;
        submitPassword.current = update;
        setPasswordPrompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'Incorrect password. Try again.' : 'Enter the password for this PDF.');
      };
      const document = await task.promise;
      if (disposed) return;
      links.setDocument(document);
      instance.setDocument(document);
      observer = new ResizeObserver(() => {
        if (instance?.pagesCount && ['page-width', 'page-fit'].includes(instance.currentScaleValue)) instance.currentScaleValue = instance.currentScaleValue;
      });
      observer.observe(element);
    })().catch(error => { if (!disposed) setError(`Slate could not open this PDF. ${error instanceof Error ? error.message : String(error)}`); });
    return () => {
      disposed = true;
      element.removeEventListener('wheel', wheel);
      observer?.disconnect();
      eventBus?.dispatch('findbarclose', {});
      instance?.setDocument(null);
      viewer.current = null;
      bus.current = null;
      submitPassword.current = null;
      void task?.destroy();
    };
  }, [doc.content]);
  useEffect(() => {
    if (!pageCount) return;
    bus.current?.dispatch('find', { query, type: '', caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
  }, [query, pageCount]);
  function goToPage(value: number) {
    if (!viewer.current || !pageCount) return;
    const next = Math.max(1, Math.min(pageCount, Number.isFinite(value) ? Math.round(value) : page));
    viewer.current.currentPageNumber = next;
    setPageEntry(String(next));
  }
  return <section className="file-preview pdf-preview" aria-label="PDF viewer">
    <header className="preview-toolbar">
      <div className="preview-actions">
        <PreviewButton label="Previous page" disabled={page <= 1 || !pageCount} onClick={() => goToPage(page - 1)}><ChevronLeft /></PreviewButton>
        <form className="pdf-page-control" onSubmit={event => { event.preventDefault(); goToPage(Number(pageEntry)); }}>
          <Input aria-label="PDF page" inputMode="numeric" value={pageEntry} disabled={!pageCount} onChange={event => setPageEntry(event.target.value)} onBlur={() => goToPage(Number(pageEntry))} />
          <span>of {pageCount || '—'}</span>
        </form>
        <PreviewButton label="Next page" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}><ChevronRight /></PreviewButton>
      </div>
      <div className="preview-actions">
        <PreviewButton label="Search PDF" disabled={!pageCount} onClick={find}><Search /></PreviewButton>
        <PreviewButton label="Zoom out" disabled={!pageCount} onClick={() => zoom('out')}><Minus /></PreviewButton>
        <NativeSelect aria-label="PDF zoom" disabled={!pageCount} value={scale} onChange={event => { if (viewer.current) { viewer.current.currentScaleValue = event.target.value; if (event.target.value === 'page-fit') viewer.current.scrollPageIntoView({ pageNumber: page }); } }}>
          <option value="page-width">Fit width</option><option value="page-fit">Fit page</option>
          {[...new Set(['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4', ...(Number.isFinite(Number(scale)) ? [scale] : [])])].sort((a, b) => Number(a) - Number(b)).map(value => <option key={value} value={value}>{Math.round(Number(value) * 100)}%</option>)}
        </NativeSelect>
        <PreviewButton label="Zoom in" disabled={!pageCount} onClick={() => zoom('in')}><Plus /></PreviewButton>
        <OpenOriginal id={doc.id} onError={onError} />
      </div>
    </header>
    {searchOpen && <div className="pdf-search" role="search" aria-label="Search PDF text">
      <Input ref={searchInput} aria-label="Find in PDF" placeholder="Find in PDF…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { setSearchOpen(false); bus.current?.dispatch('findbarclose', {}); }
      }} />
      <span aria-live="polite">{query ? matches.total ? `${matches.current} of ${matches.total}` : 'No matches' : ''}</span>
      <PreviewButton label="Previous match" onClick={() => findNext(-1)}><ArrowUp /></PreviewButton>
      <PreviewButton label="Next match" onClick={() => findNext(1)}><ArrowDown /></PreviewButton>
      <PreviewButton label="Close PDF search" onClick={() => { setSearchOpen(false); bus.current?.dispatch('findbarclose', {}); }}><X /></PreviewButton>
    </div>}
    {passwordPrompt && <form className="pdf-password preview-message" onSubmit={event => { event.preventDefault(); submitPassword.current?.(password); setPassword(''); setPasswordPrompt(''); }}>
      <p>{passwordPrompt}</p><Input type="password" aria-label="PDF password" autoFocus value={password} onChange={event => setPassword(event.target.value)} /><Button type="submit">Unlock PDF</Button>
    </form>}
    {error && <p role="alert" className="preview-message">{error}</p>}
    {!pageCount && !error && !passwordPrompt && <p role="status" className="preview-message">Opening PDF…</p>}
    <div className="pdf-viewport-wrapper"><div ref={container} className="pdf-viewport" tabIndex={0} aria-label="PDF pages"><div ref={pages} className="pdfViewer" /></div></div>
  </section>;
});
