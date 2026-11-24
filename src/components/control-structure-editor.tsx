'use client';

import { useRef, useState, type RefObject } from 'react';
import { Plus, Link2, Pencil, Trash2, Workflow, Undo2, Redo2, CircleHelp, X, Expand, Minimize2, Save, Copy, Check, Image as ImageIcon } from 'lucide-react';
import { EditorIconButton } from './editor-icon-button';
import { CONTROL_EXAMPLE } from '@/lib/control-structure/example';
import { NativeSelect } from './ui/native-select';
import { SourceEditor } from './source-editor';
import { ControlStructurePreview } from './control-structure-preview';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { compileAuthoringSource } from '@/lib/control-structure/resolve';
import { renameComponent } from '@/lib/control-structure/identity';
import { addVisualComponent, addVisualConnection, deleteVisualConnection, deleteVisualComponent, renameVisualConnection, createControllerDraft, addControllerDraftItem, applyControllerDraft, type ControllerDraft } from '@/lib/control-structure/visual-edits';
import { RELATIONSHIPS, TYPES, type AuthoringResult, type ComponentType, type IdentityState } from '@/lib/control-structure/schema';
import type { ControlLayout } from '@/lib/control-structure/layout';
import type { Match } from '@/lib/find';
import { controlDiagramPng } from '@/lib/control-structure/image';


export function ControlStructureEditor({ source, result: supplied, layout = {}, onChange, inputRef, matches, activeMatch, mode, onModeChange, onSave, saveDisabled, notice }: {
  mode: 'visual' | 'source'; onModeChange(mode: 'visual' | 'source'): void; onSave(): void; saveDisabled: boolean; notice?: string;
  layout?: ControlLayout; source: string; result?: AuthoringResult; onChange(source: string, identity?: IdentityState, layout?: ControlLayout): void;
  inputRef?: RefObject<HTMLTextAreaElement | null>; matches?: Match[]; activeMatch?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? ownInput;
  const pendingChange = useRef<{ source: string; identity?: IdentityState } | null>(null);
  const detailHeight = useRef(240);
  const result = supplied ?? compileAuthoringSource(source);
  const history = useRef({ entries: [{ source, identity: result.identity, layout }], index: 0, typedAt: 0 });
  const currentHistory = history.current;
  if (currentHistory.entries[currentHistory.index].source !== source) {
    currentHistory.entries.splice(currentHistory.index + 1);
    currentHistory.entries.push({ source, identity: result.identity, layout });
    currentHistory.index++;
    currentHistory.typedAt = 0;
  } else { currentHistory.entries[currentHistory.index].identity = result.identity; currentHistory.entries[currentHistory.index].layout = layout; }
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState('');
  const [action, setAction] = useState<'component' | 'connection' | 'rename' | 'delete' | 'detail' | null>(null);
  const [controllerDraft, setControllerDraft] = useState<ControllerDraft | null>(null);
  const [editingItem, setEditingItem] = useState<{ id: string; original: string } | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<ComponentType>('controller');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [relationship, setRelationship] = useState<typeof RELATIONSHIPS[number]>('control');
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [copyStatus, setCopyStatus] = useState<{ id: string; message: string } | null>(null);
  const [imageCopy, setImageCopy] = useState('');
  const component = result.graph.components.find(c => c.id === selected);
  const connection = result.graph.connections.find(c => c.id === selected);
  const details = result.graph.details.filter(d => d.ownerId === selected && d.body);
  const copyMessage = copyStatus?.id === selected ? copyStatus.message : '';
  function updateControllerItem(kind: ControllerDraft['sections'][number]['kind'], id: string, text: string) {
    setControllerDraft(draft => draft && ({ ...draft, sections: draft.sections.map(section => section.kind === kind
      ? { ...section, items: section.items.map(item => item.id === id ? { ...item, text } : item) } : section) }));
  }
  function addControllerItem(kind: ControllerDraft['sections'][number]['kind']) {
    if (!controllerDraft) return;
    const draft = addControllerDraftItem(controllerDraft, kind);
    setControllerDraft(draft);
    const item = draft.sections.find(section => section.kind === kind)!.items.at(-1)!;
    setEditingItem({ id: item.id, original: '' });
    requestAnimationFrame(() => document.getElementById(`controller-edit-${item.id}`)?.focus());
  }
  async function copyDetails() {
    const text = component ? [
      `${component.name} (${component.type ?? 'Unclassified'}) [${component.id}]`,
      ...details.map(detail => [
        `${detail.kind === 'process_model' ? 'Process model' : 'Control algorithm'} [${detail.id}]`,
        ...(detail.kind === 'process_model' ? detail.variables : detail.rules).map(item => `[${item.id}] ${item.text}`),
      ].join('\n')),
    ].join('\n\n') : connection ? `${connection.label} [${connection.id}]\n${connection.source.name} → ${connection.target.name} · ${connection.relationship}` : '';
    try {
      if (window.slate) await window.slate.copyText(text);
      else await navigator.clipboard.writeText(text);
      setCopyStatus({ id: selected, message: 'Copied' });
    } catch {
      setCopyStatus({ id: selected, message: 'Could not copy. Select the text and copy it.' });
    }
  }
  async function copyDiagram() {
    const svg = container.current?.querySelector<SVGSVGElement>('.control-preview[data-diagram-status="ready"] .diagram-canvas > svg');
    if (!svg) { setImageCopy('The diagram is not ready.'); return; }
    setImageCopy('Copying image…');
    try {
      const png = controlDiagramPng(svg);
      if (window.slate) await window.slate.copyImage(new Uint8Array(await (await png).arrayBuffer()));
      else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setImageCopy('Image copied');
    } catch {
      setImageCopy('Could not copy the diagram image.');
    }
  }
  const references = result.valid ? result.graph.details.flatMap(d => [
    ...(d.id ? [{ from: d.from, id: d.id }] : []),
    ...d.variables.map(v => ({ from: v.from, id: v.id })),
    ...d.rules.map(r => ({ from: r.from, id: r.id })),
  ]) : [];
  function focusRange(from: number, to: number) {
    const element = input.current;
    if (!element) return;
    onModeChange('source');
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(from, to); });
    element.closest('.control-source-scroll')?.scrollTo({ top: Math.max(0, source.slice(0, from).split('\n').length - 3) * 26 });
  }
  function select(id: string) {
    setSelected(id);
    const entry = result.graph.components.find(c => c.id === id)?.mentions[0] ?? result.graph.connections.find(c => c.id === id);
    if (entry && mode === 'source') focusRange(entry.from, entry.to);
  }
  function changeSource(next: string, identity?: IdentityState, typing = false, nextLayout = layout) {
    if (next === source && JSON.stringify(nextLayout) === JSON.stringify(layout)) return;
    const now = performance.now();
    // Keep a typing burst together, and each visual edit as a separate undo step.
    const group = typing && currentHistory.typedAt > 0 && now - currentHistory.typedAt < 750;
    currentHistory.entries.splice(currentHistory.index + 1);
    const snapshot = { source: next, identity: identity ?? result.identity, layout: nextLayout };
    if (group) currentHistory.entries[currentHistory.index] = snapshot;
    else { currentHistory.entries.push(snapshot); currentHistory.index++; }
    currentHistory.typedAt = typing ? now : 0;
    onChange(next, identity, nextLayout);
  }
  function changeHistory(direction: -1 | 1) {
    const index = currentHistory.index + direction;
    if (index < 0 || index >= currentHistory.entries.length) return;
    currentHistory.index = index;
    currentHistory.typedAt = 0;
    const snapshot = currentHistory.entries[index];
    onChange(snapshot.source, snapshot.identity, snapshot.layout);
  }
  function apply() {
    try {
      if (action === 'delete' && component) { pendingChange.current = { source: deleteVisualComponent(result, component.id).result.source }; setSelected(''); }
      if (action === 'component') pendingChange.current = { source: addVisualComponent(result, name, role).result.source };
      if (action === 'connection') pendingChange.current = { source: addVisualConnection(result, { sourceId: from, targetId: to, label: name, relationship }).result.source };
      if (action === 'rename' && component) {
        const renamed = renameComponent(source, result.identity, component.name, name);
        pendingChange.current = { source: renamed.source, identity: renamed.identity };
      }
      if (action === 'rename' && connection) {
        const renamed = renameVisualConnection(result, connection.id, name).result;
        pendingChange.current = { source: renamed.source, identity: renamed.identity };
      }
      if (action === 'detail' && controllerDraft && component) {
        const edited = applyControllerDraft(result, component.id, controllerDraft).result;
        pendingChange.current = { source: edited.source, identity: edited.identity };
      }
      setAction(null); setError('');
    } catch (error) { setError((error as Error).message); }
  }
  const diagnostics = result.diagnostics.filter(d => d.category !== 'profile');
  const content = <div ref={container} className="control-structure-editor" onKeyDownCapture={event => {
    if (!(event.metaKey || event.ctrlKey) || action || help) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault(); event.stopPropagation();
    changeHistory(key === 'y' || event.shiftKey ? 1 : -1);
  }}>
    <div className="control-toolbar">
      <span>Control structure</span>
      {expanded && <Tabs value={mode} onValueChange={value => onModeChange(value as 'visual' | 'source')}><TabsList className="mode-switch" aria-label="Control structure view"><TabsTrigger value="visual">Visual</TabsTrigger><TabsTrigger value="source">Source</TabsTrigger></TabsList></Tabs>}
      <EditorIconButton label="Add component" disabled={!result.valid} onClick={() => { setAction('component'); setName(''); setError(''); }}><Plus aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Add connection" disabled={!result.valid || result.graph.components.length < 2} onClick={() => { setAction('connection'); setFrom(component?.id ?? result.graph.components[0]?.id ?? ''); setTo(result.graph.components.find(c => c.id !== (component?.id ?? result.graph.components[0]?.id))?.id ?? ''); setName(''); setError(''); }}><Link2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Rename" hint={component ? 'Rename component' : connection?.relationship === 'observation' ? 'Observation labels are fixed by M45 syntax' : connection ? 'Rename connection label' : 'Select a component or connection to rename'} disabled={!result.valid || (!component && (!connection || connection.relationship === 'observation'))} onClick={() => { setAction('rename'); setName(component?.name ?? connection!.label); setError(''); }}><Pencil aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label={component ? 'Delete component' : connection ? 'Delete connection' : 'Delete selection'} hint={component ? 'Delete component and its connections' : connection ? 'Delete connection' : 'Select a component or connection to delete'} disabled={!result.valid || (!connection && !component)} onClick={() => { if (component) { setAction('delete'); setError(''); } else if (connection) { changeSource(deleteVisualConnection(result, connection.id).result.source); setSelected(''); } }}><Trash2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Auto-arrange" hint={'Auto-arrange · Reset manual positions'} disabled={!result.valid || !Object.keys(layout).length} onClick={() => changeSource(source, undefined, false, {})}><Workflow aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Undo" hint={'Undo · ⌘ / Ctrl Z'} disabled={currentHistory.index === 0} onClick={() => changeHistory(-1)}><Undo2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Redo" hint={'Redo · ⌘ / Ctrl Shift Z'} disabled={currentHistory.index === currentHistory.entries.length - 1} onClick={() => changeHistory(1)}><Redo2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Syntax help" onClick={() => setHelp(true)}><CircleHelp aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Copy diagram as image" hint="Copy full diagram as a high-resolution PNG" disabled={!result.valid || !result.graph.components.length || imageCopy === 'Copying image…'} onClick={copyDiagram}><ImageIcon aria-hidden="true" /></EditorIconButton>
      {imageCopy && <span className="control-copy-status" role="status">{imageCopy}</span>}
      {expanded && <EditorIconButton label="Save" hint="Save · ⌘ / Ctrl S" disabled={saveDisabled} onClick={onSave}><Save aria-hidden="true" /></EditorIconButton>}
      <EditorIconButton label={expanded ? 'Collapse control structure' : 'Expand control structure'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 aria-hidden="true" /> : <Expand aria-hidden="true" />}</EditorIconButton>
    </div>
    {expanded && notice && <p role="status" className="control-expanded-notice">{notice}</p>}
    <div className="control-workspace">
      <section hidden={mode !== 'source'} className="control-source" aria-label="Control structure source pane">
        <div className="control-pane-heading">Source · M45 syntax</div>
        <div className="control-source-scroll"><SourceEditor ref={input} value={source} references={references} filename="M45 source" label="Control structure source" onChange={text => changeSource(text, undefined, true)} matches={matches} activeMatch={activeMatch} /></div>
        {diagnostics.length > 0 && <div className="control-diagnostics" aria-label="Control structure diagnostics">{diagnostics.map((d, index) => <button type="button" className={d.severity} key={index} onClick={() => focusRange(d.from, d.to)}>Line {source.slice(0, d.from).split('\n').length}: {d.message}</button>)}</div>}
      </section>
      <section hidden={mode !== 'visual'} className="control-diagram" aria-label="Control structure preview pane">
        <ResizablePanelGroup orientation="vertical" className="control-panels">
        <ResizablePanel id="control-canvas" minSize="20%" className="control-canvas-panel">
        <ControlStructurePreview expandable={false} fill positions={layout} onMove={mode === 'visual' ? positions => changeSource(source, undefined, false, positions) : undefined} source={source} result={result} selectedId={selected} onSelect={select} />
        </ResizablePanel>
        {(component || connection) && <>
        <ResizableHandle aria-label="Resize controller details" className="control-details-resize-handle" />
        <ResizablePanel id="control-details" defaultSize={detailHeight.current} minSize={80} maxSize="80%" groupResizeBehavior="preserve-pixel-size" onResize={size => { if (size.inPixels > 0) detailHeight.current = size.inPixels; }}>
        <div className="control-details">
          <div className="control-details-header">
            <strong>{component?.name ?? connection?.label}</strong>
            {component && <span>{component.type ?? 'Unclassified'}</span>}
            <div className="control-details-actions">
              <span role="status">{copyMessage}</span>
              {component?.type === 'controller' && <EditorIconButton label="Edit controller details" onClick={() => { setControllerDraft(createControllerDraft(result, component.id)); setEditingItem(null); setError(''); setAction('detail'); }}><Pencil aria-hidden="true" /></EditorIconButton>}
              <EditorIconButton label="Copy inspection contents" hint={copyMessage === 'Copied' ? 'Copied' : 'Copy inspection contents'} onClick={copyDetails}>{copyMessage === 'Copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</EditorIconButton>
              <EditorIconButton label="Clear diagram selection" onClick={() => setSelected('')}><X aria-hidden="true" /></EditorIconButton>
            </div>
          </div>
          {component && details.map(d => <section key={d.kind}><div className="control-detail-heading"><button type="button" onClick={() => focusRange(d.from, d.headerTo)}>{d.kind === 'process_model' ? 'Process model' : 'Control algorithm'}</button><code className="control-reference">{d.id}</code></div><ul className="control-detail-items">{(d.kind === 'process_model' ? d.variables : d.rules).map(item => <li key={item.id} data-controller-item-id={item.id}><code className="control-reference">{item.id}</code><button className="control-detail-text" type="button" onClick={() => focusRange(item.from, item.to)}>{item.text}</button></li>)}</ul></section>)}
          {connection && <><p>{connection.source.name} → {connection.target.name} · {connection.relationship}</p><button type="button" onClick={() => focusRange(connection.from, connection.to)}>Edit source</button></>}
        </div>
        </ResizablePanel>
        </>}
        </ResizablePanelGroup>
        <p className="control-legend">Solid: control · Blue dashed: feedback · Gray dashed: information</p>
      </section>
    </div>
    <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent className={action === 'detail' ? 'controller-edit-dialog' : undefined} onCloseAutoFocus={event => {
      event.preventDefault();
      if (mode === 'source') input.current?.focus();
      else container.current?.querySelector<HTMLElement>('.diagram-viewport')?.focus();
      const change = pendingChange.current;
      pendingChange.current = null;
      if (change) changeSource(change.source, change.identity);
    }}><DialogTitle>{action === 'component' ? 'Add component' : action === 'connection' ? 'Add connection' : action === 'delete' ? 'Delete component' : action === 'detail' ? 'Edit controller details' : connection ? 'Rename connection label' : 'Rename component'}</DialogTitle><DialogDescription>{action === 'delete' ? `Remove ${component?.name}, its ${result.graph.connections.filter(c => c.sourceId === selected || c.targetId === selected).length} connections, and its controller details? You can undo this change.` : action === 'detail' ? <>{component?.name} <code className="control-reference">{component?.id}</code></> : 'Updates the written structure and live preview together.'}</DialogDescription>
      <form className={action === 'detail' ? 'controller-edit-form' : 'control-form'} onSubmit={event => { event.preventDefault(); apply(); }}>
        {action === 'connection' && <><label>From<NativeSelect aria-label="From component" value={from} onChange={e => setFrom(e.target.value)}>{result.graph.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></label><label>To<NativeSelect aria-label="To component" value={to} onChange={e => setTo(e.target.value)}>{result.graph.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></label><label>Kind<NativeSelect aria-label="Connection kind" value={relationship} onChange={e => setRelationship(e.target.value as typeof relationship)}>{RELATIONSHIPS.map(r => <option key={r}>{r}</option>)}</NativeSelect></label></>}
        {action === 'detail' && controllerDraft ? <div className="controller-edit-columns">{controllerDraft.sections.map(section => <section className="controller-edit-section" key={section.kind} aria-label={section.kind === 'process_model' ? 'Process model' : 'Control algorithm'}>
          <header><div><h3>{section.kind === 'process_model' ? 'Process model' : 'Control algorithm'}</h3><code className="control-reference">{section.id ?? 'No entries yet'}</code></div><Button type="button" variant="ghost" onClick={() => addControllerItem(section.kind)}><Plus aria-hidden="true" />{section.kind === 'process_model' ? 'Add entry' : 'Add rule'}</Button></header>
          <div className="controller-edit-rows">{section.items.length === 0 && <p className="controller-edit-empty">{section.kind === 'process_model' ? 'No entries yet.' : 'No rules yet.'}</p>}{section.items.map(item => <div className="controller-edit-row" key={item.id} data-edit-item-id={item.id}>
            <code className="controller-item-id">{item.id}</code>
            {editingItem?.id === item.id ? <Textarea autoFocus id={`controller-edit-${item.id}`} aria-label={`${section.kind === 'process_model' ? 'Process model entry' : 'Algorithm rule'} ${item.id}`} value={item.text} placeholder="Enter text…" onChange={event => updateControllerItem(section.kind, item.id, event.target.value)} onBlur={() => setEditingItem(null)} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); updateControllerItem(section.kind, item.id, editingItem.original); setEditingItem(null); }
              else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setEditingItem(null); }
            }} /> : <button className="controller-item-text" type="button" aria-label={`Edit ${item.id}`} onClick={() => setEditingItem({ id: item.id, original: item.text })}>{item.text || 'Enter text…'}</button>}
            <EditorIconButton className="controller-item-remove" label={`Remove ${item.id}`} onClick={() => setControllerDraft(draft => draft && ({ ...draft, sections: draft.sections.map(s => s.kind === section.kind ? { ...s, items: s.items.filter(i => i.id !== item.id) } : s) }))}><Trash2 aria-hidden="true" /></EditorIconButton>
          </div>)}</div>
        </section>)}</div> : action !== 'delete' && <label>{action === 'connection' || (action === 'rename' && connection) ? 'Label' : 'Name'}<Input aria-label={action === 'connection' || (action === 'rename' && connection) ? 'Connection label' : 'Component name'} autoFocus value={name} onChange={e => setName(e.target.value)} /></label>}
        {action === 'component' && <label>Role<NativeSelect aria-label="Component role" value={role} onChange={e => setRole(e.target.value as ComponentType)}>{TYPES.map(t => <option key={t}>{t}</option>)}</NativeSelect></label>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className={action === 'detail' ? 'controller-edit-footer' : undefined}><Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit">{action === 'delete' ? 'Delete' : 'Apply'}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent><DialogTitle>M45 control structure syntax</DialogTitle><DialogDescription>Use the same simple text as the M45 editor. A component name refers to the same component throughout the document.</DialogDescription><pre className="control-help">{CONTROL_EXAMPLE}</pre><p>Roles: controller, process, sensor, actuator. Arrows default to control; add [feedback], [information], or [effect]. Use “Sensor measures Process” for observations. Quote names or labels containing reserved punctuation. Indent controller details with two spaces. Use # headings to organize the source.</p><p>Visual shows the diagram; Source shows the simple M45 text. Click a box or arrow to select it. Details appear only for the selection; click a detail heading or item to edit its source. Each belief and decision rule has a persistent reference ID. IDs appear beside the items and in the source margin; select and copy them when discussing a controller. Drag boxes to arrange them, drag the background to pan, and scroll to zoom. Layout is saved with the file. Auto-arrange resets manual positions. Select a box or arrow to rename or delete it. Undo also restores deleted items and layout changes.</p></DialogContent></Dialog>
  </div>;
  return <Dialog open={expanded} onOpenChange={setExpanded}>
    {expanded ? <DialogContent className="diagram-dialog control-editor-dialog" aria-describedby={undefined}
      onInteractOutside={event => event.preventDefault()}
      onOpenAutoFocus={event => {
        event.preventDefault();
        if (mode === 'source') input.current?.focus();
        else (container.current?.querySelector<HTMLElement>('.diagram-viewport') ?? container.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        requestAnimationFrame(() => container.current?.querySelector<HTMLElement>('[aria-label="Expand control structure"]')?.focus());
      }}>
      <DialogTitle className="sr-only">Control structure editor</DialogTitle>
      {content}
    </DialogContent> : content}
  </Dialog>;
}
