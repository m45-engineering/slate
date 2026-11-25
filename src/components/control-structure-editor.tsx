'use client';

import { useRef, useState, type RefObject } from 'react';
import { Plus, Link2, Trash2, Workflow, Undo2, Redo2, CircleHelp, Expand, Minimize2, Save, Copy, Check, Image as ImageIcon } from 'lucide-react';
import { EditorIconButton } from './editor-icon-button';
import { CONTROL_EXAMPLE } from '@/lib/control-structure/example';
import { NativeSelect } from './ui/native-select';
import { SourceEditor } from './source-editor';
import { ControlStructurePreview } from './control-structure-preview';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { compileAuthoringSource } from '@/lib/control-structure/resolve';
import { addVisualComponent, addVisualConnection, deleteVisualConnection, deleteVisualComponent, editVisualComponent, editVisualConnection, createControllerDraft, addControllerDraftItem, applyControllerDraft, type ControllerDraft } from '@/lib/control-structure/visual-edits';
import { RELATIONSHIPS, TYPES, type AuthoringResult, type ComponentType, type RelationshipType, type IdentityState } from '@/lib/control-structure/schema';
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
  const [action, setAction] = useState<'component' | 'connection' | 'edit' | 'delete' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmRoleChange, setConfirmRoleChange] = useState(false);
  const openingDialog = useRef(false);
  const [controllerDraft, setControllerDraft] = useState<ControllerDraft | null>(null);
  const [editingItem, setEditingItem] = useState<{ id: string; original: string } | null>(null);
  const [itemToRemove, setItemToRemove] = useState<{ kind: ControllerDraft['sections'][number]['kind']; id: string; text: string } | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<ComponentType>('controller');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [relationship, setRelationship] = useState<RelationshipType>('control');
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
      `${name} (${role}) [${component.id}]`,
      ...(role === 'controller' ? controllerDraft?.sections.filter(section => section.items.length).map(section => [
        `${section.kind === 'process_model' ? 'Process model' : 'Control algorithm'} [${section.id}]`,
        ...section.items.map(item => `[${item.id}] ${item.text}`),
      ].join('\n')) ?? [] : []),
    ].join('\n\n') : connection ? `${relationship === 'observation' ? 'Observes' : name} [${connection.id}]\n${result.graph.components.find(c => c.id === from)?.name} → ${result.graph.components.find(c => c.id === to)?.name} · ${relationship}` : '';
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
  function select(id: string, anchor?: { x: number; y: number }) {
    setSelected(id);
    setMenu(id && anchor ? anchor : null);
    openingDialog.current = false;
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
  function beginEdit() {
    openingDialog.current = true;
    setMenu(null); setError(''); setConfirmRoleChange(false); setEditingItem(null); setCopyStatus(null);
    setName(component?.name ?? connection?.label ?? '');
    setRole(component?.type ?? 'controller');
    setFrom(connection?.sourceId ?? ''); setTo(connection?.targetId ?? '');
    setRelationship(connection?.relationship ?? 'control');
    setControllerDraft(component ? createControllerDraft(result, component.id) : null);
    setAction('edit');
  }
  function apply(confirmed = false) {
    if (action === 'edit' && component && role !== 'controller' && details.length && !confirmed) {
      setConfirmRoleChange(true); return;
    }
    try {
      if (action === 'delete') {
        if (component) pendingChange.current = { source: deleteVisualComponent(result, component.id).result.source };
        else if (connection) pendingChange.current = { source: deleteVisualConnection(result, connection.id).result.source };
        setSelected('');
      }
      if (action === 'component') pendingChange.current = { source: addVisualComponent(result, name, role).result.source };
      if (action === 'connection') pendingChange.current = { source: addVisualConnection(result, { sourceId: from, targetId: to, label: name, relationship: relationship as typeof RELATIONSHIPS[number] }).result.source };
      if (action === 'edit' && component) {
        let next = result;
        if (role === 'controller' && component.type === 'controller' && controllerDraft) next = applyControllerDraft(next, component.id, controllerDraft).result;
        next = editVisualComponent(next, component.id, { name, type: role, removeDetails: confirmed }).result;
        if (role === 'controller' && component.type !== 'controller' && controllerDraft) next = applyControllerDraft(next, component.id, controllerDraft).result;
        pendingChange.current = { source: next.source, identity: next.identity };
      }
      if (action === 'edit' && connection) {
        const next = editVisualConnection(result, connection.id, { sourceId: from, targetId: to, label: name, relationship }).result;
        pendingChange.current = { source: next.source, identity: next.identity };
      }
      setConfirmRoleChange(false); setAction(null); setError('');
    } catch (error) { setConfirmRoleChange(false); setError((error as Error).message); }
  }
  const editingController = action === 'edit' && !!component && role === 'controller';
  const editingConnection = action === 'connection' || (action === 'edit' && !!connection);
  const diagnostics = result.diagnostics.filter(d => d.category !== 'profile');
  const content = <div ref={container} className="control-structure-editor" onKeyDownCapture={event => {
    if (!(event.metaKey || event.ctrlKey) || action || help || menu) return;
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
      <EditorIconButton className="destructive-action" label={component ? 'Delete component' : connection ? 'Delete connection' : 'Delete selection'} hint={component ? 'Delete component and its connections' : connection ? 'Delete connection' : 'Select a component or connection to delete'} disabled={!result.valid || (!connection && !component)} onClick={() => { setMenu(null); setAction('delete'); setError(''); }}><Trash2 aria-hidden="true" /></EditorIconButton>
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
        <ControlStructurePreview expandable={false} fill positions={layout} onMove={mode === 'visual' ? positions => { setMenu(null); changeSource(source, undefined, false, positions); } : undefined} source={source} result={result} selectedId={selected} onSelect={select} />
        <p className="control-legend">Solid: control · Blue dashed: feedback · Gray dashed: information</p>
      </section>
    </div>
    <DropdownMenu modal={false} open={!!menu} onOpenChange={open => { if (!open) setMenu(null); }}>
      <DropdownMenuTrigger asChild><button type="button" tabIndex={-1} aria-hidden="true" className="tab-menu-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} /></DropdownMenuTrigger>
      <DropdownMenuContent className="control-context-menu" aria-label="Diagram actions" align="center" sideOffset={8} onCloseAutoFocus={event => {
        event.preventDefault();
        if (!openingDialog.current) container.current?.querySelector<HTMLElement>('.diagram-viewport')?.focus({ preventScroll: true });
      }}>
        <DropdownMenuItem disabled={!result.valid} onSelect={beginEdit}>Show details</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent className={editingController ? 'controller-edit-dialog' : undefined} onCloseAutoFocus={event => {
      event.preventDefault();
      if (mode === 'source') input.current?.focus();
      else container.current?.querySelector<HTMLElement>('.diagram-viewport')?.focus();
      const change = pendingChange.current;
      pendingChange.current = null;
      if (change) changeSource(change.source, change.identity);
    }}><DialogTitle>{action === 'component' ? 'Add component' : action === 'connection' ? 'Add connection' : action === 'delete' ? component ? 'Delete component' : 'Delete connection' : connection ? 'Connection details' : 'Component details'}</DialogTitle><DialogDescription>{action === 'delete' ? component ? `Remove ${component.name}, its ${result.graph.connections.filter(c => c.sourceId === selected || c.targetId === selected).length} connections, and its controller details? You can undo this change.` : `Remove “${connection?.label}” from ${connection?.source.name} to ${connection?.target.name}? You can undo this change.` : action === 'edit' ? <>{component?.name ?? connection?.label} <code className="control-reference">{component?.id ?? connection?.id}</code></> : 'Updates the written structure and live preview together.'}</DialogDescription>
      <form className={editingController ? 'controller-edit-form' : 'control-form'} onSubmit={event => { event.preventDefault(); apply(); }}>
        <div className={editingController ? 'control-edit-properties' : 'control-form'}>
        {editingConnection && <><label>From<NativeSelect aria-label="From component" value={from} onChange={e => setFrom(e.target.value)}>{result.graph.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></label><label>To<NativeSelect aria-label="To component" value={to} onChange={e => setTo(e.target.value)}>{result.graph.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></label><label>Kind<NativeSelect aria-label="Connection kind" value={relationship} onChange={e => setRelationship(e.target.value as RelationshipType)}>{[...RELATIONSHIPS, ...(action === 'edit' ? ['observation'] : [])].map(r => <option key={r}>{r}</option>)}</NativeSelect></label></>}
        {action !== 'delete' && <label>{editingConnection ? 'Label' : 'Name'}<Input aria-label={editingConnection ? 'Connection label' : 'Component name'} autoFocus disabled={editingConnection && relationship === 'observation'} value={editingConnection && relationship === 'observation' ? 'Observes' : name} onChange={e => setName(e.target.value)} /></label>}
        {(action === 'component' || (action === 'edit' && component)) && <label>Role<NativeSelect aria-label="Component role" value={role} onChange={e => setRole(e.target.value as ComponentType)}>{TYPES.map(t => <option key={t}>{t}</option>)}</NativeSelect></label>}
        </div>
        {editingController && controllerDraft && <div className="controller-edit-columns">{controllerDraft.sections.map(section => <section className="controller-edit-section" key={section.kind} aria-label={section.kind === 'process_model' ? 'Process model' : 'Control algorithm'}>
          <header><div><h3>{section.kind === 'process_model' ? 'Process model' : 'Control algorithm'}</h3><code className="control-reference">{section.id ?? 'No entries yet'}</code></div><Button type="button" variant="ghost" onClick={() => addControllerItem(section.kind)}><Plus aria-hidden="true" />{section.kind === 'process_model' ? 'Add entry' : 'Add rule'}</Button></header>
          <div className="controller-edit-rows">{section.items.length === 0 && <p className="controller-edit-empty">{section.kind === 'process_model' ? 'No entries yet.' : 'No rules yet.'}</p>}{section.items.map(item => <div className="controller-edit-row" key={item.id} data-edit-item-id={item.id}>
            <code className="controller-item-id">{item.id}</code>
            {editingItem?.id === item.id ? <Textarea autoFocus id={`controller-edit-${item.id}`} aria-label={`${section.kind === 'process_model' ? 'Process model entry' : 'Algorithm rule'} ${item.id}`} value={item.text} placeholder="Enter text…" onChange={event => updateControllerItem(section.kind, item.id, event.target.value)} onBlur={() => setEditingItem(current => current?.id === item.id ? null : current)} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); updateControllerItem(section.kind, item.id, editingItem.original); setEditingItem(null); }
              else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setEditingItem(null); }
            }} /> : <button className="controller-item-text" type="button" aria-label={`Edit ${item.id}`} onMouseDown={event => { /* Keep the active row from collapsing before the click reaches this row. */ event.preventDefault(); }} onClick={() => setEditingItem({ id: item.id, original: item.text })}>{item.text || 'Enter text…'}</button>}
            <EditorIconButton className="controller-item-remove destructive-action" label={`Remove ${item.id}`} onClick={() => setItemToRemove({ kind: section.kind, id: item.id, text: item.text })}><Trash2 aria-hidden="true" /></EditorIconButton>
          </div>)}</div>
        </section>)}</div>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className={editingController ? 'controller-edit-footer' : undefined}>{action === 'edit' && <><span className="control-copy-status" role="status">{copyMessage}</span><EditorIconButton label="Copy details" hint={copyMessage === 'Copied' ? 'Copied' : 'Copy details'} onClick={copyDetails}>{copyMessage === 'Copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</EditorIconButton></>}<Button type="button" variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button type="submit" variant={action === 'delete' ? 'destructive' : 'default'}>{action === 'delete' ? 'Delete' : 'Apply'}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    <Dialog open={!!itemToRemove} onOpenChange={open => { if (!open) setItemToRemove(null); }}><DialogContent>
      <DialogTitle>{itemToRemove?.kind === 'process_model' ? 'Delete process-model entry?' : 'Delete algorithm rule?'}</DialogTitle>
      <DialogDescription>Remove {itemToRemove?.text ? `“${itemToRemove.text}”` : 'this empty entry'}? The removal takes effect when you apply the component changes.</DialogDescription>
      <DialogFooter><Button variant="ghost" autoFocus onClick={() => setItemToRemove(null)}>Cancel</Button><Button variant="destructive" onClick={() => {
        if (!itemToRemove) return;
        setControllerDraft(draft => draft && ({ ...draft, sections: draft.sections.map(section => section.kind === itemToRemove.kind ? { ...section, items: section.items.filter(item => item.id !== itemToRemove.id) } : section) }));
        if (editingItem?.id === itemToRemove.id) setEditingItem(null);
        setItemToRemove(null);
      }}>Delete</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={confirmRoleChange} onOpenChange={setConfirmRoleChange}><DialogContent><DialogTitle>Change component type?</DialogTitle><DialogDescription>Changing this controller to a {role} will remove its process model and control algorithm. Continue? You can undo this change.</DialogDescription><DialogFooter><Button variant="ghost" autoFocus onClick={() => setConfirmRoleChange(false)}>Cancel</Button><Button variant="destructive" onClick={() => apply(true)}>Change type</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent><DialogTitle>M45 control structure syntax</DialogTitle><DialogDescription>Use the same simple text as the M45 editor. A component name refers to the same component throughout the document.</DialogDescription><pre className="control-help">{CONTROL_EXAMPLE}</pre><p>Roles: controller, process, sensor, actuator. Arrows default to control; add [feedback], [information], or [effect]. Use “Sensor measures Process” for observations. Quote names or labels containing reserved punctuation. Indent controller details with two spaces. Use # headings to organize the source.</p><p>Visual shows the diagram; Source shows the simple M45 text. Click a box or arrow, or activate it with Enter or Space, to open its menu. Show details opens the item’s properties and controller details together; fields can be edited in the same dialog. Controller dialogs can be resized. Each belief and decision rule has a persistent reference ID. IDs appear beside the items and in the source margin; select and copy them when discussing a controller. Drag boxes to arrange them, drag the background to pan, and scroll to zoom. Layout is saved with the file. Auto-arrange resets manual positions. Use the selected item’s Show details action to make changes, or the toolbar to delete it. Undo also restores deleted items and layout changes.</p></DialogContent></Dialog>
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
