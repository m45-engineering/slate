'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildModelPackage, type ModelPackage } from '@/lib/mbse/model';
import { ModelDiagram } from './model-diagram';
import { ModelInteraction } from './model-interaction';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { ModelTable } from './model-table';
import { readSavedDiagrams, type SavedDiagram } from '@/lib/mbse/diagrams';

export function ModelViewer({ content }: { content: string }) {
  const [data, setData] = useState<{ bundle: ModelPackage; diagrams: SavedDiagram[] } | null>(null);
  const [error, setError] = useState('');
  const [diagramId, setDiagramId] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 650));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [data]);
  useEffect(() => {
    let canceled = false;
    setData(null); setError(''); setSelected('');
    void (async () => {
      const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
      const bundle = await buildModelPackage(bytes, 'local.mdzip');
      const diagrams = await readSavedDiagrams(bytes);
      if (!canceled) { setData({ bundle, diagrams }); setDiagramId(diagrams.find(d => d.supported && (d.shapes.length > 0 || d.table || bundle.matrices.some(m => m.id === d.id)))?.id ?? ''); }
    })().catch(e => { if (!canceled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { canceled = true; };
  }, [content]);
  const elements = useMemo(() => new Map(data?.bundle.model.elements.map(e => [e.id, e])), [data]);
  if (error) return <div role="alert" className="p-6">Cannot open model: {error}</div>;
  if (!data) return <div role="status" className="p-6">Reading model and saved diagrams…</div>;
  const isAvailable = (d: SavedDiagram) => d.supported && (d.shapes.length > 0 || d.table || data.bundle.matrices.some(m => m.id === d.id));
  const available = data.diagrams.filter(isAvailable);
  const unavailable = data.diagrams.filter(d => !isAvailable(d));
  const matchesQuery = (d: SavedDiagram) => `${d.name} ${d.type}`.toLowerCase().includes(query.toLowerCase());
  const matches = available.filter(matchesQuery);
  const unavailableMatches = unavailable.filter(matchesQuery);
  const diagram = data.diagrams.find(d => d.id === diagramId);
  const element = elements.get(selected);
  const matrix = data.bundle.matrices.find(m => m.id === diagram?.id);
  return <div className="model-viewer" ref={root} aria-label="Read-only model viewer">
    <ResizablePanelGroup key={compact ? 'stacked' : 'columns'} orientation={compact ? 'vertical' : 'horizontal'} className={`model-panels${compact ? ' is-stacked' : ''}`}>
    <ResizablePanel id="model-navigation" defaultSize={compact ? '25%' : '22%'} minSize="15%" maxSize="50%">
    <aside className="model-navigation" aria-label="Diagram navigation"><strong>Available previews</strong><p className="model-navigation-status">{available.length} of {data.diagrams.length} diagrams</p><input aria-label="Find diagram" placeholder="Find diagram…" value={query} onChange={e => setQuery(e.target.value)} />
      {matches.map(d => <button key={d.id} aria-pressed={diagramId === d.id} onClick={() => { setDiagramId(d.id); setSelected(''); }}><span>{d.name}</span><small>{d.type}</small></button>)}
      {matches.length === 0 && <p className="model-navigation-status">{available.length ? 'No available previews match your search.' : 'This model has no available saved previews.'}</p>}
      {unavailableMatches.length > 0 && <details className="model-unavailable" key={query ? 'search' : 'browse'} open={query ? true : undefined}><summary>Unavailable previews ({unavailableMatches.length})</summary><p>These diagrams are in the model, but Slate cannot preview them yet.</p>{unavailableMatches.map(d => <div className="model-unavailable-item" key={d.id}><span>{d.name}</span><small>{d.type}{d.supported ? ' · No saved layout' : ''}</small></div>)}</details>}
    </aside>
    </ResizablePanel>
    <ResizableHandle aria-label="Resize diagram navigation" className="workspace-resize-handle model-resize-handle"/>
    <ResizablePanel id="model-canvas" minSize="20%">
    <section className="model-canvas-area"><header><div><strong>{diagram?.name ?? 'No available preview'}</strong><p>Read-only · {diagram?.table || matrix ? 'Saved table definition' : 'Saved positions · Simplified notation'}</p></div>{diagram && !diagram.table && !matrix && <label>Zoom <select aria-label="Diagram zoom" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={0}>Fit diagram</option>{[50,75,100,125,150,200].map(z => <option key={z} value={z}>{z}%</option>)}</select></label>}</header>
      {diagram ? diagram.table || matrix ? <ModelTable diagram={diagram} bundle={data.bundle} matrix={matrix} onSelect={setSelected}/> : <>
        <p className="model-note">Select a shape to explore its properties.</p>
        {diagram.notes.length > 0 && <details className="model-note"><summary>Layout notes ({diagram.notes.length})</summary>{diagram.notes.map(n => <p key={n}>{n}</p>)}</details>}
        {diagram.type === 'SysML Sequence Diagram' && diagram.shapes.every(s => s.kind === 'DiagramFrame') && <ModelInteraction contextId={diagram.contextId} elements={elements} onSelect={setSelected}/>}
        <ModelDiagram diagram={diagram} elements={elements} selected={selected} onSelect={setSelected} zoom={zoom}/>
      </> : <p className="p-6">This model has no saved diagrams or table definitions available to preview.</p>}
    </section>
    </ResizablePanel>
    {selected && <>
    <ResizableHandle aria-label="Resize element details" className="workspace-resize-handle model-resize-handle"/>
    <ResizablePanel id="model-details" defaultSize={compact ? '30%' : '26%'} minSize="20%" maxSize="55%">
    <aside className="model-inspector" aria-label="Model element details"><div className="model-inspector-heading"><strong>Element details</strong><button aria-label="Close element details" onClick={() => setSelected('')}>×</button></div>{element ? <><h2>{element.name || element.type.localName}</h2><p>{element.type.localName} {element.stereotypes.map(s=>`· ${s.type.localName}`).join(' ')}</p>{element.ownerId && <button onClick={()=>setSelected(element.ownerId!)}>Owner: {elements.get(element.ownerId)?.name || element.ownerId}</button>}<dl>{Object.entries(element.properties).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}{element.stereotypes.flatMap(s=>Object.entries(s.properties).filter(([k])=>!k.startsWith('base_')).map(([k,v])=><div key={`${s.id}:${k}`}><dt>{k}</dt><dd>{v}</dd></div>))}</dl>{element.references.map((r,i)=><div key={i}><small>{r.role}</small><button onClick={()=>setSelected(r.targetId)}>{elements.get(r.targetId)?.name || r.targetId}</button></div>)}<small>{element.id}</small></> : <p>{selected ? `External or unresolved element: ${selected}` : 'Select a shape or connector.'}</p>}<details><summary>Import notes</summary>{data.bundle.model.diagnostics.map(n=><p key={n}>{n}</p>)}</details></aside>
    </ResizablePanel></>}
    </ResizablePanelGroup>
  </div>;
}
