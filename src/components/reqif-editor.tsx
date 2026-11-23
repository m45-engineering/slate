'use client';

import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Pencil, Redo2, Undo2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { EditorIconButton } from './editor-icon-button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { updateReqifField, type ReqifDocument, type ReqifField, type ReqifObject } from '@/lib/reqif/document';

// Render a small inert vocabulary: imported markup cannot run code or fetch resources.
const richTags = new Set(['div', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'pre', 'code', 'blockquote', 'span', 'h1', 'h2', 'h3', 'h4', 'hr']);
function requirementPreview(object: ReqifObject): string {
  // ReqIF names the text attribute by convention; do not guess from prose or length.
  const field = ['reqif.text', 'requirement text', 'requirement_text', 'text', 'description']
    .map(name => object.fields.find(field => ['string', 'xhtml'].includes(field.kind) && field.name.trim().toLowerCase() === name))
    .find(Boolean) ?? object.fields.find(field => field.kind === 'xhtml');
  if (!field) return '';
  if (field.kind !== 'xhtml') return field.value.replace(/\s+/g, ' ').trim();
  const value = Array.from(field.displayNode?.children ?? []).find(child => child.localName === 'THE-VALUE');
  function text(node: Node): string {
    if (node.nodeType === 3 || node.nodeType === 4) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const name = (node as Element).localName.toLowerCase();
    if (['script', 'style', 'iframe', 'object', 'embed'].includes(name)) return '';
    const content = Array.from(node.childNodes).map(text).join('');
    return ['div', 'p', 'br', 'li', 'tr', 'td', 'th'].includes(name) ? `${content} ` : content;
  }
  return value ? text(value).replace(/\s+/g, ' ').trim() : '';
}

function richText(field: ReqifField): ReactNode {
  const value = field.displayNode ? Array.from(field.displayNode.children).find(child => child.localName === 'THE-VALUE') : null;
  if (!value) return field.value ? <span>{field.value}</span> : <span className="reqif-muted">Not set</span>;
  function render(node: Node, key: number): ReactNode {
    if (node.nodeType === 3 || node.nodeType === 4) return node.textContent;
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (['script', 'style', 'iframe'].includes(tag)) return null;
    if (['img', 'object', 'embed'].includes(tag)) return <span key={key} className="reqif-muted">[{element.getAttribute('alt') || 'Embedded attachment; see Source'}]</span>;
    const content = Array.from(element.childNodes).map(render);
    return createElement(richTags.has(tag) ? tag : 'span', { key }, ...content);
  }
  return Array.from(value.childNodes).map(render);
}

export function ReqifEditor({ document, onChange }: { document: ReqifDocument; onChange(source: string): void }) {
  const navigationPanel = useRef<PanelImperativeHandle | null>(null);
  useEffect(() => {
    try {
      const width = Number(localStorage.getItem('slate-reqif-navigation-percent'));
      if (width > 0 && width <= 70) navigationPanel.current?.resize(`${width}%`);
    } catch { /* Resizing remains available without stored preferences. */ }
  }, []);
  const previews = useMemo(() => new Map([...document.objects.values()].map(object => [object.id, requirementPreview(object)])), [document]);
  const [selected, setSelected] = useState(() => document.objects.keys().next().value ?? '');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [editing, setEditing] = useState<{ object: ReqifObject; field: ReqifField } | null>(null);
  const [value, setValue] = useState<string | string[]>('');
  const [error, setError] = useState('');
  const history = useRef({ entries: [document.source], index: 0 });
  const current = history.current;
  if (current.entries[current.index] !== document.source) {
    current.entries.splice(current.index + 1);
    current.entries.push(document.source);
    current.index++;
  }
  const object = document.objects.get(selected);
  const search = query.trim().toLocaleLowerCase();
  const matching = new Set<string>();
  if (search) for (const row of document.rows) {
    const object = row.id ? document.objects.get(row.id) : null;
    if ([row.label, row.id, ...(object?.fields.map(field => field.kind === 'xhtml' ? field.displayNode?.textContent ?? field.value : field.value) ?? [])].some(text => text?.toLocaleLowerCase().includes(search))) {
      matching.add(row.key); row.ancestors.forEach(key => matching.add(key));
    }
  }
  const branches = new Set(document.rows.flatMap(row => row.ancestors));
  const rows = document.rows.filter(row => search ? matching.has(row.key) : !row.ancestors.some(key => collapsed.has(key)));
  const relations = document.relations.filter(relation => relation.source === selected || relation.target === selected);
  function moveHistory(direction: number) {
    const next = current.index + direction;
    if (next < 0 || next >= current.entries.length) return;
    current.index = next; onChange(current.entries[next]);
  }
  function apply() {
    if (!editing) return;
    try {
      onChange(updateReqifField(document, editing.object.id, editing.field.id, value));
      setEditing(null); setError('');
    } catch (error) { setError((error as Error).message); }
  }
  return <div className="reqif-editor" onKeyDown={event => {
    if (editing || !(event.metaKey || event.ctrlKey)) return;
    if (!['z', 'y'].includes(event.key.toLowerCase()) || event.target instanceof HTMLInputElement) return;
    event.preventDefault(); event.stopPropagation(); moveHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1);
  }}>
    <div className="reqif-toolbar"><div><strong>{document.title}</strong><span>{document.objects.size} objects · {document.relations.length} relations</span></div>
      <EditorIconButton label="Undo requirement edit" disabled={!current.index} onClick={() => moveHistory(-1)}><Undo2 /></EditorIconButton>
      <EditorIconButton label="Redo requirement edit" disabled={current.index === current.entries.length - 1} onClick={() => moveHistory(1)}><Redo2 /></EditorIconButton>
    </div>
    {document.warnings.length > 0 && <div className="reqif-warning" role="status">{document.warnings.join(' ')}</div>}
    <ResizablePanelGroup orientation="horizontal" className="reqif-workspace" onLayoutChanged={(layout, meta) => {
      if (!meta.isUserInteraction) return;
      const width = layout['reqif-navigation'];
      if (width) try { localStorage.setItem('slate-reqif-navigation-percent', String(width)); } catch { /* Optional preference. */ }
    }}>
      <ResizablePanel id="reqif-navigation" panelRef={navigationPanel} defaultSize="34%" minSize={160} maxSize="70%" groupResizeBehavior="preserve-pixel-size">
      <section className="reqif-tree" aria-label="Requirements hierarchy">
        <Input aria-label="Search requirements" placeholder="Search requirements…" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="reqif-rows">{rows.map(row => <div className={`reqif-row${row.id === selected ? ' selected' : ''}`} key={row.key} style={{ paddingLeft: `${8 + Math.min(row.depth, 12) * 16}px` }}>
          {branches.has(row.key) ? <button className="reqif-expander" aria-label={`${collapsed.has(row.key) ? 'Expand' : 'Collapse'} ${row.label}`} aria-expanded={search ? true : !collapsed.has(row.key)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })}>{collapsed.has(row.key) && !search ? <ChevronRight /> : <ChevronDown />}</button> : <span className="reqif-expander" />}
          {row.id ? <button className="reqif-row-label" aria-label={row.label} aria-current={row.id === selected ? 'true' : undefined} onClick={() => setSelected(row.id!)}><span>{row.label}</span>{previews.get(row.id) && <span className="reqif-row-preview">{previews.get(row.id)}</span>}</button> : <span className="reqif-row-label reqif-group">{row.label}</span>}
        </div>)}{!rows.length && <p className="reqif-empty">{search ? 'No matching requirements.' : 'This document has no requirements.'}</p>}</div>
      </section>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize requirements navigation" className="reqif-resize-handle workspace-resize-handle" />
      <ResizablePanel id="reqif-details" minSize={240}>
      <section className="reqif-details" aria-label="Requirement details">
        {object ? <><header><h1>{object.name}</h1><p>{object.id} · {object.type}</p></header>
          {object.fields.map((field, index) => <section className="reqif-field" key={`${field.id}-${index}`}><div className="reqif-field-heading"><h2>{field.name}</h2>{field.inherited && <span className="reqif-muted">Default</span>}{field.editable ? <Button variant="ghost" size="sm" aria-label={`Edit ${field.name}`} onClick={() => { setEditing({ object, field }); setValue(field.kind === 'enumeration' ? field.selected : field.value); setError(''); }}><Pencil size={13} />Edit</Button> : <span className="reqif-muted">Read-only</span>}</div>
            <div className={`reqif-value${field.kind === 'xhtml' ? ' reqif-rich-text' : ''}`}>{field.kind === 'xhtml' ? richText(field) : field.value || <span className="reqif-muted">Not set</span>}</div>
          </section>)}
          {!object.fields.length && <p className="reqif-muted">No attributes are defined for this object.</p>}
          <section className="reqif-relations"><h2>Relations</h2>{relations.length ? relations.map((relation, index) => {
            const target = relation.source === selected ? relation.target : relation.source;
            const other = document.objects.get(target);
            return <div key={`${relation.id}-${index}`}><span>{relation.source === selected ? '→' : '←'} {relation.name}</span>{other ? <button onClick={() => setSelected(target)}>{other.name}</button> : <span className="reqif-muted">Missing object: {target}</span>}</div>;
          }) : <p className="reqif-muted">No relations.</p>}</section>
        </> : <p className="reqif-empty">Select a requirement to view its attributes.</p>}
      </section>
      </ResizablePanel>
    </ResizablePanelGroup>
    <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null); }}><DialogContent className="reqif-edit-dialog"><DialogTitle>Edit {editing?.field.name}</DialogTitle><DialogDescription>Apply changes to this document, then use Save to write the file.</DialogDescription>
      <form onSubmit={event => { event.preventDefault(); apply(); }}>
        {editing?.field.kind === 'enumeration' ? <div className="reqif-enum-options">{editing.field.multi ? editing.field.options.map(option => <label key={option.id}><Checkbox checked={(value as string[]).includes(option.id)} onCheckedChange={checked => setValue(checked === true ? [...value as string[], option.id] : (value as string[]).filter(id => id !== option.id))} />{option.name}</label>) : <NativeSelect aria-label={editing.field.name} value={(value as string[])[0] ?? ''} onChange={event => setValue(event.target.value ? [event.target.value] : [])}><option value="">Not set</option>{editing.field.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</NativeSelect>}</div> : editing?.field.kind === 'boolean' ? <NativeSelect aria-label={editing.field.name} value={value as string} onChange={event => setValue(event.target.value)}><option value="" disabled>Choose a value</option><option value="true">True</option><option value="false">False</option></NativeSelect> : <Textarea autoFocus aria-label={editing?.field.name} value={value as string} onChange={event => setValue(event.target.value)} spellCheck={editing?.field.kind === 'string'} className={editing?.field.kind === 'xhtml' ? 'reqif-xhtml-input' : ''} />}
        {editing?.field.kind === 'xhtml' && <p className="reqif-muted">Edit the XHTML markup to preserve formatting. Keep the outer div and its namespace.</p>}
        {editing?.field.kind === 'date' && <p className="reqif-muted">ISO date and time with time zone, for example 2026-11-23T12:00:00Z.</p>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">Apply</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </div>;
}
