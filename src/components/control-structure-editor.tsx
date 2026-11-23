'use client';

import { useRef, useState, type RefObject } from 'react';
import { Plus, Link2, Pencil, Trash2, Workflow, Undo2, Redo2, CircleHelp, X, Expand, Minimize2, Save } from 'lucide-react';
import { EditorIconButton } from './editor-icon-button';
import { CONTROL_EXAMPLE } from '@/lib/control-structure/example';
import { NativeSelect } from './ui/native-select';
import { SourceEditor } from './source-editor';
import { ControlStructurePreview } from './control-structure-preview';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { compileAuthoringSource } from '@/lib/control-structure/resolve';
import { renameComponent } from '@/lib/control-structure/identity';
import { addVisualComponent, addVisualConnection, deleteVisualConnection, deleteVisualComponent } from '@/lib/control-structure/visual-edits';
import { RELATIONSHIPS, TYPES, type AuthoringResult, type ComponentType, type IdentityState } from '@/lib/control-structure/schema';
import type { ControlLayout } from '@/lib/control-structure/layout';
import type { Match } from '@/lib/find';


export function ControlStructureEditor({ source, result: supplied, layout = {}, onChange, inputRef, matches, activeMatch, mode, onModeChange, onSave, saveDisabled, notice }: {
  mode: 'visual' | 'source'; onModeChange(mode: 'visual' | 'source'): void; onSave(): void; saveDisabled: boolean; notice?: string;
  layout?: ControlLayout; source: string; result?: AuthoringResult; onChange(source: string, identity?: IdentityState, layout?: ControlLayout): void;
  inputRef?: RefObject<HTMLTextAreaElement | null>; matches?: Match[]; activeMatch?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? ownInput;
  const pendingChange = useRef<{ source: string; identity?: IdentityState } | null>(null);
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
  const [action, setAction] = useState<'component' | 'connection' | 'rename' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<ComponentType>('controller');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [relationship, setRelationship] = useState<typeof RELATIONSHIPS[number]>('control');
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const component = result.graph.components.find(c => c.id === selected);
  const connection = result.graph.connections.find(c => c.id === selected);
  const details = result.graph.details.filter(d => d.ownerId === selected && d.body);
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
      <EditorIconButton label="Rename" hint={component ? 'Rename component' : 'Select a component to rename'} disabled={!result.valid || !component} onClick={() => { setAction('rename'); setName(component!.name); setError(''); }}><Pencil aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label={component ? 'Delete component' : connection ? 'Delete connection' : 'Delete selection'} hint={component ? 'Delete component and its connections' : connection ? 'Delete connection' : 'Select a component or connection to delete'} disabled={!result.valid || (!connection && !component)} onClick={() => { if (component) { setAction('delete'); setError(''); } else if (connection) { changeSource(deleteVisualConnection(result, connection.id).result.source); setSelected(''); } }}><Trash2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Auto-arrange" hint={'Auto-arrange · Reset manual positions'} disabled={!result.valid || !Object.keys(layout).length} onClick={() => changeSource(source, undefined, false, {})}><Workflow aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Undo" hint={'Undo · ⌘ / Ctrl Z'} disabled={currentHistory.index === 0} onClick={() => changeHistory(-1)}><Undo2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Redo" hint={'Redo · ⌘ / Ctrl Shift Z'} disabled={currentHistory.index === currentHistory.entries.length - 1} onClick={() => changeHistory(1)}><Redo2 aria-hidden="true" /></EditorIconButton>
      <EditorIconButton label="Syntax help" onClick={() => setHelp(true)}><CircleHelp aria-hidden="true" /></EditorIconButton>
      {expanded && <EditorIconButton label="Save" hint="Save · ⌘ / Ctrl S" disabled={saveDisabled} onClick={onSave}><Save aria-hidden="true" /></EditorIconButton>}
      <EditorIconButton label={expanded ? 'Collapse control structure' : 'Expand control structure'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 aria-hidden="true" /> : <Expand aria-hidden="true" />}</EditorIconButton>
    </div>
    {expanded && notice && <p role="status" className="control-expanded-notice">{notice}</p>}
    <div className="control-workspace">
      <section hidden={mode !== 'source'} className="control-source" aria-label="Control structure source pane">
        <div className="control-pane-heading">Source · M45 syntax</div>
        <div className="control-source-scroll"><SourceEditor ref={input} value={source} filename="M45 source" label="Control structure source" onChange={text => changeSource(text, undefined, true)} matches={matches} activeMatch={activeMatch} /></div>
        {diagnostics.length > 0 && <div className="control-diagnostics" aria-label="Control structure diagnostics">{diagnostics.map((d, index) => <button type="button" className={d.severity} key={index} onClick={() => focusRange(d.from, d.to)}>Line {source.slice(0, d.from).split('\n').length}: {d.message}</button>)}</div>}
      </section>
      <section hidden={mode !== 'visual'} className="control-diagram" aria-label="Control structure preview pane">
        <ControlStructurePreview expandable={false} fill positions={layout} onMove={mode === 'visual' ? positions => changeSource(source, undefined, false, positions) : undefined} source={source} result={result} selectedId={selected} onSelect={select} />
        {component && <div className="control-details"><EditorIconButton className="control-details-close" label="Clear diagram selection" onClick={() => setSelected('')}><X aria-hidden="true" /></EditorIconButton><strong>{component.name}</strong><span>{component.type ?? 'Unclassified'}</span>{details.map(d => <section key={d.kind}><button type="button" onClick={() => focusRange(d.from, d.headerTo)}>{d.kind === 'process_model' ? 'Process model' : 'Control algorithm'}</button><p>{d.body}</p></section>)}</div>}
        {connection && <div className="control-details"><EditorIconButton className="control-details-close" label="Clear diagram selection" onClick={() => setSelected('')}><X aria-hidden="true" /></EditorIconButton><strong>{connection.label}</strong><p>{connection.source.name} → {connection.target.name} · {connection.relationship}</p><button type="button" onClick={() => focusRange(connection.from, connection.to)}>Edit source</button></div>}
        <p className="control-legend">Solid: control · Blue dashed: feedback · Gray dashed: information</p>
      </section>
    </div>
    <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent onCloseAutoFocus={event => {
      event.preventDefault();
      if (mode === 'source') input.current?.focus();
      else container.current?.querySelector<HTMLElement>('.diagram-viewport')?.focus();
      const change = pendingChange.current;
      pendingChange.current = null;
      if (change) changeSource(change.source, change.identity);
    }}><DialogTitle>{action === 'component' ? 'Add component' : action === 'connection' ? 'Add connection' : action === 'delete' ? 'Delete component' : 'Rename component'}</DialogTitle><DialogDescription>{action === 'delete' ? `Remove ${component?.name}, its ${result.graph.connections.filter(c => c.sourceId === selected || c.targetId === selected).length} connections, and its controller details? You can undo this change.` : 'Updates the written structure and live preview together.'}</DialogDescription>
      <form className="control-form" onSubmit={event => { event.preventDefault(); apply(); }}>
        {action === 'connection' && <><label>From<NativeSelect aria-label="From component" value={from} onChange={e => setFrom(e.target.value)}>{result.graph.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></label><label>To<NativeSelect aria-label="To component" value={to} onChange={e => setTo(e.target.value)}>{result.graph.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></label><label>Kind<NativeSelect aria-label="Connection kind" value={relationship} onChange={e => setRelationship(e.target.value as typeof relationship)}>{RELATIONSHIPS.map(r => <option key={r}>{r}</option>)}</NativeSelect></label></>}
        {action !== 'delete' && <label>{action === 'connection' ? 'Label' : 'Name'}<Input aria-label={action === 'connection' ? 'Connection label' : 'Component name'} autoFocus value={name} onChange={e => setName(e.target.value)} /></label>}
        {action === 'component' && <label>Role<NativeSelect aria-label="Component role" value={role} onChange={e => setRole(e.target.value as ComponentType)}>{TYPES.map(t => <option key={t}>{t}</option>)}</NativeSelect></label>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit">{action === 'delete' ? 'Delete' : 'Apply'}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent><DialogTitle>M45 control structure syntax</DialogTitle><DialogDescription>Use the same simple text as the M45 editor. A component name refers to the same component throughout the document.</DialogDescription><pre className="control-help">{CONTROL_EXAMPLE}</pre><p>Roles: controller, process, sensor, actuator. Arrows default to control; add [feedback], [information], or [effect]. Use “Sensor measures Process” for observations. Quote names or labels containing reserved punctuation. Indent controller details with two spaces. Use # headings to organize the source.</p><p>Visual shows the diagram; Source shows the simple M45 text. Click a box or arrow to select it. Details appear only for the selection; click a detail heading to edit its source. Drag boxes to arrange them, drag the background to pan, and scroll to zoom. Layout is saved with the file. Auto-arrange resets manual positions. Select a box or arrow to rename or delete it. Undo also restores deleted items and layout changes.</p></DialogContent></Dialog>
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
