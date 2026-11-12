'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorState } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import { Markdown } from '@tiptap/markdown';
import { EMPTY_DOCUMENT, isMarkdown, isTextFile, fileLabel, sourceOnlyReason, type SlateDocument, type WorkspaceDocuments, type LocalFolder } from '@/lib/document';
import { Icon, type IconName } from './icon';
import { SlateCodeBlock } from './code-block';
import { SlateTaskItem } from './task-item';
import { DocumentTabs } from './document-tabs';
import { FolderSidebar } from './folder-sidebar';
import { SidebarProvider } from './ui/sidebar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SourceEditor } from './source-editor';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { TooltipHint } from './ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import type { PanelImperativeHandle } from 'react-resizable-panels';

const RECOVERY_KEY = 'slate-unsaved-drafts-v2';
const LEGACY_RECOVERY_KEY = 'slate-unsaved-draft-v1';
const ZOOM_LEVELS = [75, 90, 100, 110, 125, 150, 175, 200];
type Mode = 'visual' | 'source';
type TabDraft = { source: string; savedSource: string; mode: Mode; diskChanged: boolean; visualState: EditorState | null; scrollTop: number; selection: [number, number] | null };
type Heading = { text: string; level: number; index: number };
type Confirmation = { title: string; description: string; action: string; allowSave?: boolean; requestId?: number };

function Tool({ label, icon, active, disabled, onClick }: { label: string; icon: IconName; active?: boolean; disabled?: boolean; onClick(): void }) {
  return <TooltipHint content={label}><Button variant="ghost" size="icon" type="button" className={`tool ${active ? 'active' : ''}`} aria-label={label} aria-pressed={active === undefined ? undefined : active} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={onClick}><Icon name={icon} /></Button></TooltipHint>;
}

export function SlateEditor() {
  const [tabs, setTabs] = useState<SlateDocument[]>([EMPTY_DOCUMENT]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tabDrafts = useRef(new Map<string, TabDraft>());
  const diskChanges = useRef(new Map<string, boolean>());
  const [doc, setDoc] = useState<SlateDocument>(EMPTY_DOCUMENT);
  const [source, setSource] = useState(EMPTY_DOCUMENT.content);
  const [savedSource, setSavedSource] = useState(EMPTY_DOCUMENT.content);
  const [mode, setMode] = useState<Mode>('visual');
  const [documentZoom, setDocumentZoom] = useState(100);
  const zoomDocument = useCallback((direction: 'in' | 'out' | 'reset') => {
    setDocumentZoom(current => direction === 'reset' ? 100 : ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, ZOOM_LEVELS.indexOf(current) + (direction === 'in' ? 1 : -1)))]);
  }, []);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const sidebarPanel = useRef<PanelImperativeHandle | null>(null);
  const currentSidebarWidth = useRef(250);
  useEffect(() => {
    let width = 250;
    try {
      const saved = Number(localStorage.getItem('slate-sidebar-width'));
      if (saved >= 180 && saved <= 520) width = saved;
    } catch { /* Resizing still works without local storage. */ }
    setSidebarWidth(width);
    const frame = requestAnimationFrame(() => sidebarPanel.current?.resize(width));
    return () => cancelAnimationFrame(frame);
  }, []);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const documentVersion = useRef(0);
  const docRef = useRef(doc);
  docRef.current = doc;
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationResolve = useRef<((accepted: boolean) => void) | null>(null);
  const requestConfirmation = useCallback((options: Confirmation) => new Promise<boolean>(resolve => {
    confirmationResolve.current?.(false);
    confirmationResolve.current = resolve;
    setNotice('');
    setConfirmation(options);
  }), []);
  const finishConfirmation = useCallback((accepted: boolean) => {
    const resolve = confirmationResolve.current;
    confirmationResolve.current = null;
    setConfirmation(null);
    resolve?.(accepted);
  }, []);
  useEffect(() => () => { confirmationResolve.current?.(false); }, []);
  const [desktop, setDesktop] = useState(false);
  const [starting, setStarting] = useState(true);
  const [folder, setFolder] = useState<LocalFolder | null>(null);
  const [isMac, setIsMac] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [recoveries, setRecoveries] = useState<SlateDocument[]>([]);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const recovery = recoveries[0];
  const clearRecovery = useCallback((id: string) => {
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = null;
    try {
      const stored: SlateDocument[] = JSON.parse(localStorage.getItem(RECOVERY_KEY) || '[]');
      const remaining = stored.filter(draft => draft.id !== id);
      if (remaining.length) localStorage.setItem(RECOVERY_KEY, JSON.stringify(remaining));
      else localStorage.removeItem(RECOVERY_KEY);
    } catch { /* Optional recovery storage. */ }
    setRecoveries(items => items.filter(draft => draft.id !== id));
  }, []);
  const [revision, setRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<{ id: string; scrollTop: number; selection: [number, number] | null } | null>(null);
  const sourceRef = useRef(source);
  const dirty = source !== savedSource;
  const markdownDocument = isMarkdown(doc.name);
  const language = fileLabel(doc.name);
  const unsupported = markdownDocument ? sourceOnlyReason(source) : null;
  const dirtyRef = useRef(dirty);
  sourceRef.current = source;
  dirtyRef.current = dirty;
  const liveState = useRef({ source, savedSource, mode, diskChanged });
  liveState.current = { source, savedSource, mode, diskChanged };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ codeBlock: false, underline: false, link: { openOnClick: false, autolink: false } }),
      SlateCodeBlock, TableKit.configure({ table: { resizable: false } }),
      TaskList, SlateTaskItem,
      Placeholder.configure({ placeholder: 'Start writing. Make room for an idea…' }),
      Markdown,
    ],
    content: EMPTY_DOCUMENT.content,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'document-editor', 'aria-label': 'Document editor', spellcheck: 'true' } },
    onUpdate: ({ editor: current }) => { if (isMarkdown(docRef.current.name)) setSource(current.getMarkdown()); },
    onTransaction: () => setRevision(value => value + 1),
  });

  const cacheActive = useCallback(() => {
    tabDrafts.current.set(docRef.current.id, {
      ...liveState.current, source: sourceRef.current,
      visualState: liveState.current.mode === 'visual' ? editor?.state ?? null : null,
      scrollTop: scrollArea.current?.scrollTop ?? 0,
      selection: sourceInput.current ? [sourceInput.current.selectionStart, sourceInput.current.selectionEnd] : null,
    });
  }, [editor]);

  const loadWorkspace = useCallback((workspace: WorkspaceDocuments, preserveNotice = false) => {
    cacheActive();
    const next = workspace.documents.find(item => item.id === workspace.activeId);
    if (!next) return;
    const ids = new Set(workspace.documents.map(item => item.id));
    for (const id of tabDrafts.current.keys()) if (!ids.has(id) || id === workspace.replaceId) tabDrafts.current.delete(id);
    tabsRef.current = workspace.documents;
    setTabs(workspace.documents);
    const typeChanged = isMarkdown(next.name) !== isMarkdown(docRef.current.name);
    if (next.id === docRef.current.id && workspace.replaceId !== next.id && !typeChanged) {
      docRef.current = next;
      setDoc(next);
      return;
    }
    const draft = tabDrafts.current.get(next.id);
    let recovered: SlateDocument | undefined;
    if (!draft && next.unsaved) {
      try { recovered = (JSON.parse(localStorage.getItem(RECOVERY_KEY) || '[]') as SlateDocument[]).find(item => item.id === next.id); }
      catch { /* The native file remains available if recovery storage cannot be read. */ }
    }
    const nextSource = draft?.source ?? recovered?.content ?? next.content;
    const nextSaved = draft?.savedSource ?? (next.path ? next.content : next.unsaved ? '' : next.content);
    if (recovered) setRecoveries(items => items.filter(item => item.id !== next.id));
    const nextMode = !isMarkdown(next.name) ? 'source' : draft?.mode ?? (!sourceOnlyReason(nextSource) ? 'visual' : 'source');
    const changed = workspace.replaceId === next.id ? false : diskChanges.current.get(next.id) ?? draft?.diskChanged ?? false;
    if (workspace.replaceId === next.id) diskChanges.current.delete(next.id);
    documentVersion.current++;
    docRef.current = next;
    sourceRef.current = nextSource;
    dirtyRef.current = nextSource !== nextSaved;
    liveState.current = { source: nextSource, savedSource: nextSaved, mode: nextMode, diskChanged: changed };
    setDoc(next); setSource(nextSource); setSavedSource(nextSaved); setMode(nextMode);
    setDiskChanged(changed); if (!preserveNotice) setNotice(''); setLinkOpen(false);
    if (editor && nextMode === 'visual') {
      if (draft?.visualState) editor.view.updateState(draft.visualState);
      else {
        editor.commands.setContent(nextSource, { contentType: 'markdown', emitUpdate: false });
        editor.view.updateState(EditorState.create({ schema: editor.schema, doc: editor.state.doc, plugins: editor.state.plugins }));
      }
      setRevision(value => value + 1);
    }
    pendingRestore.current = { id: next.id, scrollTop: draft?.scrollTop ?? 0, selection: draft?.selection ?? null };
  }, [editor, cacheActive]);

  useLayoutEffect(() => {
    const restore = pendingRestore.current;
    if (!restore || restore.id !== doc.id) return;
    scrollArea.current?.scrollTo(0, restore.scrollTop);
    if (restore.selection && mode === 'source') sourceInput.current?.setSelectionRange(...restore.selection);
    pendingRestore.current = null;
  }, [doc.id, mode]);

  const loadDocument = useCallback((next: SlateDocument) => {
    loadWorkspace({ documents: [...tabsRef.current, next], activeId: next.id });
  }, [loadWorkspace]);

  const selectTab = useCallback(async (id: string) => {
    if (id === docRef.current.id || savingRef.current) return;
    if (window.slate) await window.slate.activateTab(id);
    else loadWorkspace({ documents: tabsRef.current, activeId: id });
  }, [loadWorkspace]);

  const switchMode = useCallback(() => {
    if (!markdownDocument) return;
    if (mode === 'visual') { setMode('source'); return; }
    if (unsupported) { setNotice(`Keep this document in Markdown to preserve its ${unsupported}.`); return; }
    if (editor) {
      editor.commands.setContent(sourceRef.current, { contentType: 'markdown', emitUpdate: false });
      editor.view.updateState(EditorState.create({ schema: editor.schema, doc: editor.state.doc, plugins: editor.state.plugins }));
    }
    setMode('visual');
  }, [editor, mode, unsupported, markdownDocument]);

  const save = useCallback(async (saveAs = false, confirmationId?: number): Promise<boolean> => {
    if (savingRef.current) return false;
    if (!saveAs && !dirtyRef.current) return true;
    const content = sourceRef.current;
    const currentDocument = docRef.current;
    const version = documentVersion.current;
    savingRef.current = true;
    setSaving(true);
    setNotice('');
    try {
      if (window.slate) {
        const result = await window.slate.save(content, saveAs, { id: currentDocument.id, path: currentDocument.path, confirmationId });
        if (version !== documentVersion.current) return false;
        if (result.conflict) {
          setDiskChanged(true);
          setNotice('This file changed outside Slate. Cancel to reload it or save a copy before continuing.');
          return false;
        }
        if (result.error) {
          setNotice(`Your changes are still unsaved. Press Save to retry. ${result.error}`);
          return false;
        }
        if (!result.document) return false;
        docRef.current = result.document;
        if (!isMarkdown(result.document.name)) setMode('source');
        setDoc(result.document); setSavedSource(content); setDiskChanged(false);
        liveState.current.savedSource = content;
        diskChanges.current.delete(currentDocument.id);
        setTabs(items => items.map(item => item.id === currentDocument.id ? result.document! : item));
        // Typing may have continued while the write or native Save As dialog was in progress.
        window.slate.setDirty(currentDocument.id, sourceRef.current !== content);
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = currentDocument.name; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setSavedSource(content);
        setNotice('File downloaded.');
      }
      if (sourceRef.current === content) {
        dirtyRef.current = false;
        clearRecovery(currentDocument.id);
        return true;
      }
      return false;
    } catch (error) {
      if (version === documentVersion.current) {
        setNotice(`Your changes are still unsaved. ${error instanceof Error ? error.message : 'The document could not be saved.'}`);
      }
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }, [clearRecovery]);

  const confirmUnsavedChanges = useCallback((requestId?: number) => requestConfirmation({
    title: 'Save changes?',
    description: `Save your changes to ${docRef.current.name} before continuing?`,
    action: 'Discard', allowSave: true, requestId,
  }), [requestConfirmation]);

  const saveBeforeContinuing = useCallback(async (saveAs = false) => {
    if (await save(saveAs, confirmation?.requestId)) finishConfirmation(true);
  }, [save, confirmation?.requestId, finishConfirmation]);

  const newDocument = useCallback(async () => {
    if (window.slate) { await window.slate.newDocument(); return; }
    loadDocument({ id: crypto.randomUUID(), path: null, name: 'Untitled.md', content: '' });
  }, [loadDocument]);

  const closeTab = useCallback(async (id: string) => {
    if (savingRef.current) return false;
    if (window.slate) { const result = await window.slate.closeTab(id); return !result.canceled; }
    const target = tabsRef.current.find(item => item.id === id);
    if (!target) return true;
    await selectTab(id);
    if (dirtyRef.current && !(await confirmUnsavedChanges())) return false;
    clearRecovery(id);
    const remaining = tabsRef.current.filter(item => item.id !== id);
    if (!remaining.length) remaining.push({ ...EMPTY_DOCUMENT, id: crypto.randomUUID() });
    loadWorkspace({ documents: remaining, activeId: remaining[Math.max(0, remaining.length - 1)].id });
    return true;
  }, [selectTab, confirmUnsavedChanges, clearRecovery, loadWorkspace]);

  const closeTabs = useCallback(async (ids: string[], keepId?: string) => {
    if (window.slate) { await window.slate.closeTabs(ids, keepId); return; }
    for (const id of ids) if (!(await closeTab(id))) return;
    if (keepId) await selectTab(keepId);
  }, [closeTab, selectTab]);

  const reorderTabs = useCallback(async (ids: string[]) => {
    if (window.slate) { await window.slate.reorderTabs(ids); return; }
    loadWorkspace({ documents: ids.map(id => tabsRef.current.find(tab => tab.id === id)!), activeId: docRef.current.id });
  }, [loadWorkspace]);

  const open = useCallback(async () => {
    if (window.slate) { await window.slate.open(); return; }
    fileInput.current?.click();
  }, []);

  const openFolder = useCallback(async () => {
    if (!window.slate) { setNotice('Open Slate on your desktop to browse a local folder.'); return; }
    const result = await window.slate.openFolder();
    if (result.error) setNotice(result.error);
    if (result.folder) { setFolder(result.folder); setOutlineOpen(true); }
  }, []);

  useEffect(() => {
    if (!editor) return;
    setDesktop(Boolean(window.slate));
    setIsMac(window.slate?.platform === 'darwin' || /Mac/.test(navigator.platform));
    try {
      const stored = localStorage.getItem(RECOVERY_KEY);
      const legacy = localStorage.getItem(LEGACY_RECOVERY_KEY);
      const candidates = stored ? JSON.parse(stored) : legacy ? [{ ...JSON.parse(legacy), id: crypto.randomUUID() }] : [];
      if (Array.isArray(candidates)) setRecoveries(candidates.filter(candidate => typeof candidate?.id === 'string' && typeof candidate?.name === 'string' && typeof candidate?.content === 'string'));
    } catch { /* Storage may be unavailable; file editing still works. */ }
    setRecoveryReady(true);
    const bridge = window.slate;
    if (!bridge) { setStarting(false); return; }
    const unsubscribeDoc = bridge.onDocument(loadWorkspace);
    const unsubscribeDisk = bridge.onDiskChange(({ id, changed }) => {
      diskChanges.current.set(id, changed);
      const cached = tabDrafts.current.get(id);
      if (cached) cached.diskChanged = changed;
      if (docRef.current.id === id) setDiskChanged(changed);
    });
    const unsubscribeFolder = bridge.onFolder(setFolder);
    // UI hot reload can precede the restart needed to update Electron's preload bridge.
    const unsubscribeError = bridge.onError?.(setNotice);
    const unsubscribeConfirm = bridge.onConfirmChanges?.(async ({ id }) => {
      const accepted = await confirmUnsavedChanges(id);
      await bridge.confirmChanges(id, accepted);
    });
    void bridge.folderReady().then(setFolder);
    void bridge.ready().then(next => loadWorkspace(next, true)).catch(error => setNotice(`Could not reopen the workspace: ${error instanceof Error ? error.message : String(error)}`)).finally(() => setStarting(false));
    return () => { unsubscribeDoc(); unsubscribeDisk(); unsubscribeFolder(); unsubscribeError?.(); unsubscribeConfirm?.(); };
  }, [editor, loadWorkspace, confirmUnsavedChanges]);

  useEffect(() => { window.slate?.setDirty(doc.id, dirty); }, [doc.id, dirty]);

  useEffect(() => {
    if (!recoveryReady) return;
    recoveryTimer.current = setTimeout(() => {
      const entries = new Map(recoveries.map(draft => [draft.id, draft]));
      for (const tab of tabs) {
        const draft = tab.id === doc.id ? { source, savedSource } : tabDrafts.current.get(tab.id);
        if (draft && draft.source !== draft.savedSource) entries.set(tab.id, { id: tab.id, path: null, name: tab.name, content: draft.source });
      }
      try {
        if (entries.size) localStorage.setItem(RECOVERY_KEY, JSON.stringify([...entries.values()]));
        else localStorage.removeItem(RECOVERY_KEY);
        localStorage.removeItem(LEGACY_RECOVERY_KEY);
      } catch { setNotice('Draft recovery is unavailable. Save your documents to keep your changes.'); }
    }, 250);
    return () => { if (recoveryTimer.current) clearTimeout(recoveryTimer.current); recoveryTimer.current = null; };
  }, [dirty, doc.id, source, savedSource, tabs, recoveries, recoveryReady]);

  useEffect(() => {
    const unsubscribe = window.slate?.onCommand(command => {
      if (command === 'save') {
        if (confirmation?.allowSave) void saveBeforeContinuing();
        else void save();
      }
      if (command === 'save-as') {
        if (confirmation?.allowSave) void saveBeforeContinuing(true);
        else void save(true);
      }
      if (command === 'close-tab') void closeTab(docRef.current.id);
      if (command === 'toggle-mode') switchMode();
      if (command === 'open-folder') void openFolder();
      if (command === 'zoom-in') zoomDocument('in');
      if (command === 'zoom-out') zoomDocument('out');
      if (command === 'zoom-reset') zoomDocument('reset');
    });
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (confirmation?.allowSave) void saveBeforeContinuing(event.shiftKey);
        else void save(event.shiftKey);
        return;
      }
      if (event.key.toLowerCase() === 'w') { event.preventDefault(); void closeTab(docRef.current.id); return; }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        const index = tabsRef.current.findIndex(tab => tab.id === docRef.current.id);
        const next = (index + (event.shiftKey ? -1 : 1) + tabsRef.current.length) % tabsRef.current.length;
        void selectTab(tabsRef.current[next].id);
        return;
      }
      if (window.slate) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void open(); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void newDocument(); }
      if (event.key.toLowerCase() === 'm' && event.shiftKey) { event.preventDefault(); switchMode(); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomDocument('in'); }
      if (event.key === '-') { event.preventDefault(); zoomDocument('out'); }
      if (event.key === '0') { event.preventDefault(); zoomDocument('reset'); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!window.slate && (dirtyRef.current || [...tabDrafts.current.values()].some(draft => draft.source !== draft.savedSource))) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', beforeUnload);
    return () => { unsubscribe?.(); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', beforeUnload); };
  }, [save, open, openFolder, newDocument, switchMode, zoomDocument, confirmation?.allowSave, saveBeforeContinuing, closeTab, selectTab]);

  const headings: Heading[] = [];
  if (mode === 'visual') {
    editor?.state.doc.descendants(node => {
      if (node.type.name === 'heading') headings.push({ text: node.textContent || 'Untitled section', level: node.attrs.level, index: headings.length });
    });
  } else if (markdownDocument) {
    let inFence = false;
    source.split('\n').forEach((line, index) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      const match = !inFence && line.match(/^(#{1,6})\s+(.+)/);
      if (match) headings.push({ text: match[2], level: match[1].length, index });
    });
  }
  const toolbarDisabled = mode !== 'visual' || !editor;
  const inTable = editor?.isActive('table') && !toolbarDisabled;
  void revision;

  function jumpToHeading(heading: Heading) {
    if (mode === 'visual') {
      scrollArea.current?.querySelectorAll('.document-editor h1, .document-editor h2, .document-editor h3, .document-editor h4, .document-editor h5, .document-editor h6')[heading.index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const offset = source.split('\n').slice(0, heading.index).join('\n').length + (heading.index ? 1 : 0);
      sourceInput.current?.focus(); sourceInput.current?.setSelectionRange(offset, offset);
      scrollArea.current?.scrollTo({ top: heading.index * 26, behavior: 'smooth' });
    }
  }

  if (starting) return <div className="slate-startup" role="status" aria-label="Starting Slate"><img src="/slate-mark.svg" width="48" height="48" alt="" /><span>Slate</span><p>Opening your workspace…</p></div>;

  return <div className={`slate-app ${desktop && isMac ? 'desktop-mac' : ''}`}>
    <header className="titlebar">
      <div className="brand"><Tool label="Toggle sidebar" icon="panel" active={outlineOpen} onClick={() => setOutlineOpen(!outlineOpen)} /><span>Slate</span></div>
      <Tabs value={mode} onValueChange={value => { if (value !== mode) switchMode(); }}><TabsList className="mode-switch" aria-label="Editor view">{markdownDocument && <TabsTrigger value="visual">Visual</TabsTrigger>}<TabsTrigger value="source">{markdownDocument ? <><span className="markdown-mark" aria-hidden="true">M↓</span>Markdown</> : 'Source'}</TabsTrigger></TabsList></Tabs>
      <div className="file-actions">
        <TooltipHint content={`New document (${isMac ? '⌘' : 'Ctrl+'}N)`}><Button variant="ghost" className="text-button" onClick={() => void newDocument()}><Icon name="plus" /><span>New</span></Button></TooltipHint>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="text-button"><Icon name="open" /><span>Open</span><Icon name="chevron" size={12} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void open()}>Open file…</DropdownMenuItem><DropdownMenuItem onSelect={() => void openFolder()}>Open folder…</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <Button className="save-button" onClick={() => void save()} disabled={saving || !dirty}><Icon name={saving ? 'more' : 'save'} size={15} /><span>{desktop ? 'Save' : 'Download'}</span></Button>
      </div>
    </header>

    <DocumentTabs tabs={tabs.map(tab => {
      const draft = tabDrafts.current.get(tab.id);
      return { ...tab, dirty: Boolean(tab.id === doc.id ? dirty : draft ? draft.source !== draft.savedSource : tab.unsaved) };
    })} activeId={doc.id} onSelect={id => void selectTab(id)} onClose={id => void closeTab(id)}
      onCloseOthers={id => void closeTabs(tabs.filter(tab => tab.id !== id).map(tab => tab.id), id)}
      onCloseAll={() => void closeTabs(tabs.map(tab => tab.id))} onReorder={ids => void reorderTabs(ids)} />
    {recovery && <div className="notice recovery" role="status"><span>An unsaved draft is available: {recovery.name}{recoveries.length > 1 ? ` (${recoveries.length} drafts)` : ''}</span><Button variant="ghost" size="sm" onClick={async () => {
      if (window.slate) await window.slate.newDocument({ name: recovery.name, content: recovery.content });
      else loadDocument({ ...recovery, id: crypto.randomUUID(), path: null, unsaved: true });
      clearRecovery(recovery.id);
    }}>Recover as new document</Button><Button variant="ghost" size="icon" aria-label="Dismiss recovery" onClick={() => clearRecovery(recovery.id)}><Icon name="close" size={14} /></Button></div>}
    {diskChanged && <div className="notice warning" role="alert"><span>This file changed outside Slate. Your edits are still here.</span><Button variant="ghost" size="sm" onClick={() => void window.slate?.reload()}>Reload file</Button><Button variant="ghost" size="sm" onClick={() => void save(true)}>Save a copy</Button></div>}
    {unsupported && mode === 'source' && <div className="notice" role="status"><span>This document contains {unsupported}. Use Markdown to preserve it.</span></div>}
    {notice && !confirmation && <div className="notice" role="status"><span>{notice}</span><Button variant="ghost" size="icon" aria-label="Dismiss message" onClick={() => setNotice('')}><Icon name="close" size={14} /></Button></div>}

    <SidebarProvider className="workspace" open={outlineOpen} onOpenChange={setOutlineOpen}>
      <ResizablePanelGroup orientation="horizontal" onLayoutChanged={(_layout, meta) => {
        if (!meta.isUserInteraction) return;
        const width = currentSidebarWidth.current;
        setSidebarWidth(width);
        try { localStorage.setItem('slate-sidebar-width', String(width)); } catch { /* Optional preference. */ }
      }}>
      {outlineOpen && <>
      <ResizablePanel id="files" panelRef={sidebarPanel} defaultSize={sidebarWidth} minSize={180} maxSize={520} groupResizeBehavior="preserve-pixel-size" onResize={size => { currentSidebarWidth.current = size.inPixels; }}>
      <FolderSidebar folder={folder} documentPath={doc.path} onOpenFolder={() => void openFolder()} onError={setNotice} outline={<nav className="outline" aria-label="Document outline">{headings.length ? headings.map((heading, index) => <Button variant="ghost" key={`${index}-${heading.index}`} className={`${heading.level === 1 ? 'outline-title' : ''}`} style={{ paddingLeft: `${Math.max(0, heading.level - 2) * 10 + 12}px` }} onClick={() => jumpToHeading(heading)}>{heading.text}</Button>) : <p className="outline-empty">{markdownDocument ? <>Your headings will<br />appear here.</> : <>Outline is available for<br />Markdown documents.</>}</p>}</nav>} />
      </ResizablePanel>
      <ResizableHandle aria-label="Resize sidebar" className="workspace-resize-handle" />
      </>}
      <ResizablePanel id="editor" minSize={300}>
      <main className="editor-main">
        <div className={`formatbar ${toolbarDisabled ? 'source-formatbar' : ''}`} aria-label="Formatting toolbar">
          {toolbarDisabled ? <span className="source-caption"><Icon name="code" />{markdownDocument ? 'Markdown source' : language} <span>Everything, exactly as written.</span></span> : <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" className="text-style-trigger" aria-label="Text style"><span>{editor?.isActive('heading') ? `Heading ${editor.getAttributes('heading').level}` : 'Normal text'}</span><Icon name="chevron" size={13} /></Button></DropdownMenuTrigger>
              <DropdownMenuContent className="text-style-menu" align="start">
                <DropdownMenuRadioGroup value={editor?.isActive('heading') ? `h${editor.getAttributes('heading').level}` : 'p'} onValueChange={value => {
                  if (value === 'p') editor?.chain().focus().setParagraph().run();
                  else editor?.chain().focus().setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
                }}>
                  <DropdownMenuRadioItem value="p" className="text-style-option"><span className="text-style-preview">Normal text</span></DropdownMenuRadioItem>
                  {[1, 2, 3, 4, 5, 6].map(level => <DropdownMenuRadioItem key={level} value={`h${level}`} className="text-style-option"><span className="text-style-preview" data-level={level}>Heading {level}</span></DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="separator" />
            <Tool label="Bold" icon="bold" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()} />
            <Tool label="Italic" icon="italic" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()} />
            <Tool label="Strikethrough" icon="strike" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()} />
            <Tool label="Add link" icon="link" active={editor?.isActive('link')} onClick={() => { setLinkUrl(editor?.getAttributes('link').href || ''); setLinkOpen(!linkOpen); }} />
            <span className="separator" />
            <Tool label="Bulleted list" icon="list" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
            <Tool label="Numbered list" icon="ordered" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
            <Tool label="Task list" icon="checkbox" active={editor?.isActive('taskList')} onClick={() => editor?.chain().focus().toggleTaskList().run()} />
            <Tool label="Blockquote" icon="quote" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
            <span className="separator" />
            <Tool label="Insert table" icon="table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
            <Tool label="Code block" icon="code" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()} />
            <Tool label="Insert Mermaid diagram" icon="diagram" onClick={() => editor?.chain().focus().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A[Start] --> B[An idea]' }] }).run()} />
            <div className="toolbar-spacer" /><Tool label="Undo" icon="undo" disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()} /><Tool label="Redo" icon="redo" disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()} />
          </>}
        </div>
        {linkOpen && mode === 'visual' && <form className="link-popover" onSubmit={event => {
          event.preventDefault();
          if (!linkUrl) editor?.chain().focus().extendMarkRange('link').unsetLink().run();
          else if (/^(https?:\/\/|mailto:|#|\.\.?\/)/i.test(linkUrl)) editor?.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run();
          else { setNotice('Use an https://, mailto:, relative, or #section link.'); return; }
          setLinkOpen(false);
        }}><Input autoFocus aria-label="Link URL" placeholder="https://…" value={linkUrl} onChange={e => setLinkUrl(e.target.value)} /><Button type="submit" size="sm">Apply</Button><Button variant="ghost" size="sm" onClick={() => setLinkOpen(false)}>Cancel</Button></form>}
        {inTable && <div className="table-actions" aria-label="Table actions"><span>Table</span><Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().addRowAfter().run()}>+ Row</Button><Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().addColumnAfter().run()}>+ Column</Button><Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().deleteRow().run()}>Delete row</Button><Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().deleteColumn().run()}>Delete column</Button><Button variant="ghost" size="sm" onClick={() => editor?.chain().focus().deleteTable().run()}>Delete table</Button></div>}
        <div className="document-scroll" ref={scrollArea}>
          <div className={`paper ${mode === 'source' ? 'source-paper' : ''}`} style={{ zoom: documentZoom / 100 }}>
            {/* Keep Tiptap mounted so its React plugins are not registered twice when switching views. */}
            <div hidden={mode !== 'visual'}><EditorContent editor={editor} /></div>{mode === 'source' && <SourceEditor key={doc.id} ref={sourceInput} value={source} filename={doc.name} label={markdownDocument ? 'Markdown source' : 'Source editor'} onChange={setSource} />}
          </div>
        </div>
      </main>
      </ResizablePanel>
      </ResizablePanelGroup>
    </SidebarProvider>
    <footer className="statusbar">
      <div className="footer-links">
        <Button asChild variant="ghost" className="footer-link"><a href="https://www.m45.engineering/" target="_blank" rel="noopener noreferrer">© 2026 by M45 Engineering Inc.</a></Button>
        <TooltipHint content="Slate on GitHub" side="top"><Button asChild variant="ghost" size="icon" className="footer-github"><a href="https://github.com/m45-engineering/slate" target="_blank" rel="noopener noreferrer" aria-label="Slate on GitHub"><img src="/github-mark.svg" width="16" height="16" alt="" /></a></Button></TooltipHint>
      </div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="zoom-control" aria-label="Document zoom">{documentZoom}%<Icon name="chevron" size={12} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={String(documentZoom)} onValueChange={value => setDocumentZoom(Number(value))}>{ZOOM_LEVELS.map(value => <DropdownMenuRadioItem key={value} value={String(value)}>{value}%</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
    </footer>
    <input ref={fileInput} type="file" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { setNotice('Slate supports documents up to 10 MB.'); return; }
      if (!isTextFile(file.name)) { setNotice('Choose a supported text or source-code file.'); return; }
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (content.includes('\0')) throw new Error('Binary data');
        loadDocument({ id: crypto.randomUUID(), path: null, name: file.name, content });
      } catch { setNotice('Please open a UTF-8 text file without binary data.'); }
    }} />
    <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open && !savingRef.current) finishConfirmation(false); }}>
      <DialogContent>
        <DialogTitle>{confirmation?.title}</DialogTitle>
        <DialogDescription>{confirmation?.description}</DialogDescription>
        {notice && confirmation?.allowSave && <p role="alert" className="mt-3 text-sm">{notice}</p>}
        <DialogFooter>
          <Button autoFocus variant="secondary" disabled={saving} onClick={() => finishConfirmation(false)}>Cancel</Button>
          <Button variant={confirmation?.allowSave ? 'secondary' : 'default'} disabled={saving} onClick={() => { if (confirmation?.allowSave) clearRecovery(docRef.current.id); finishConfirmation(true); }}>{confirmation?.action}</Button>
          {confirmation?.allowSave && <Button disabled={saving} onClick={() => void saveBeforeContinuing()}>{saving ? 'Saving…' : 'Save'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
