'use client';

import { useEffect, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent, type DragEvent } from 'react';
import { ChevronRight, File, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw, Search, X } from 'lucide-react';
import type { FolderEntry, FolderListing, FolderSearch, LocalFolder } from '@/lib/document';
import { revealLabel } from '@/lib/document';
import { isExternalFile } from '../../electron/file-types.cjs';
import { Button } from '@/components/ui/button';
import { createControlFile } from '@/lib/control-structure/file';
import { NativeSelect } from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { TooltipHint } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type OpenEntryMenu = (entry: FolderEntry, point: { x: number; y: number }) => void;
type FileSelection = { paths: Set<string>; click(entry: FolderEntry, event: MouseEvent<HTMLButtonElement>): void; clear(): void };
function entryMenuProps(entry: FolderEntry, onMenu: OpenEntryMenu) {
  return {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      if (entry.kind === 'link') return;
      event.preventDefault(); onMenu(entry, { x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (entry.kind !== 'link' && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onMenu(entry, { x: rect.left, y: rect.bottom });
      }
    },
  };
}

type EntryDrag = {
  paths: Set<string>; target: string | null;
  start(entry: FolderEntry, event: DragEvent<HTMLElement>): void;
  end(): void;
  canDrop(destination: string): boolean;
  over(destination: string, event: DragEvent<HTMLElement>): void;
  leave(destination: string, event: DragEvent<HTMLElement>): void;
  drop(destination: string, event: DragEvent<HTMLElement>): void;
};

function dropProps(destination: string, drag: EntryDrag) {
  return {
    'data-drop-target': drag.target === destination,
    onDragOver: (event: DragEvent<HTMLElement>) => drag.over(destination, event),
    onDragLeave: (event: DragEvent<HTMLElement>) => drag.leave(destination, event),
    onDrop: (event: DragEvent<HTMLElement>) => drag.drop(destination, event),
  };
}

function entryDragProps(entry: FolderEntry, drag: EntryDrag) {
  return {
    draggable: entry.kind !== 'link',
    'data-dragging': drag.paths.has(entry.path),
    onDragStart: (event: DragEvent<HTMLElement>) => drag.start(entry, event),
    onDragEnd: () => drag.end(),
    ...(entry.kind === 'directory' ? dropProps(entry.path, drag) : {}),
  };
}

function Directory({ relativePath, depth, currentPath, refreshKey, revealPath, onMenu, drag, selection }: {
  relativePath: string; depth: number; currentPath: string | null; refreshKey: number; revealPath: string | null;
  onMenu: OpenEntryMenu; drag: EntryDrag; selection: FileSelection;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  useEffect(() => {
    let canceled = false;
    // Keep rows mounted during refresh so scrolling and expanded folders stay intact.
    void window.slate?.listFolder(relativePath).then(result => { if (!canceled) setListing(result); }).catch(error => {
      if (!canceled) setListing({ error: String(error) });
    });
    return () => { canceled = true; };
  }, [relativePath, refreshKey]);

  if (!listing) return <p className="tree-hint" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</p>;
  if (listing.error) return <p className="tree-hint" role="status">{listing.error}</p>;
  return <SidebarMenu className="file-tree-list">
    {listing.entries?.map(entry => <Entry key={entry.path} entry={entry} depth={depth} currentPath={currentPath} refreshKey={refreshKey} revealPath={revealPath} onMenu={onMenu} drag={drag} selection={selection} />)}
    {!listing.entries?.length && <p className="tree-hint" style={{ paddingLeft: 12 + depth * 14 }}>Empty folder</p>}
    {listing.truncated && <p className="tree-hint">Showing the first 1,500 items. Open a smaller folder to see the rest.</p>}
  </SidebarMenu>;
}

function Entry({ entry, depth, currentPath, refreshKey, revealPath, onMenu, drag, selection }: {
  entry: FolderEntry; depth: number; currentPath: string | null; refreshKey: number; revealPath: string | null;
  onMenu: OpenEntryMenu; drag: EntryDrag; selection: FileSelection;
}) {
  const isAncestor = Boolean(currentPath?.startsWith(entry.path + '/'));
  const [expanded, setExpanded] = useState(isAncestor);
  useEffect(() => { if (isAncestor || revealPath === entry.path || revealPath?.startsWith(entry.path + '/')) setExpanded(true); }, [isAncestor, revealPath, entry.path]);
  useEffect(() => {
    if (entry.kind !== 'directory' || expanded || drag.target !== entry.path) return;
    const timer = setTimeout(() => setExpanded(true), 500);
    return () => clearTimeout(timer);
  }, [entry.kind, entry.path, expanded, drag.target]);
  if (entry.kind === 'directory') return <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
    <SidebarMenuItem>
      <TooltipHint content={entry.path} side="right"><CollapsibleTrigger asChild><SidebarMenuButton {...entryMenuProps(entry, onMenu)} {...entryDragProps(entry, drag)} onClick={selection.clear} className="file-tree-item" style={{ paddingLeft: 12 + depth * 14 }}>
        <ChevronRight className={expanded ? 'tree-chevron expanded' : 'tree-chevron'} />
        {expanded ? <FolderOpen /> : <Folder />}<span>{entry.name}</span>
      </SidebarMenuButton></CollapsibleTrigger></TooltipHint>
      <CollapsibleContent><Directory relativePath={entry.path} depth={depth + 1} currentPath={currentPath} refreshKey={refreshKey} revealPath={revealPath} onMenu={onMenu} drag={drag} selection={selection} /></CollapsibleContent>
    </SidebarMenuItem>
  </Collapsible>;
  return <SidebarMenuItem><TooltipHint content={entry.editable ? `${entry.path}${isExternalFile(entry.name) ? ' · Opens in default app' : ''}` : `${entry.path} · ${entry.kind === 'link' ? 'symbolic link' : 'binary or unsupported file type'}`} side="right"><SidebarMenuButton
    {...entryMenuProps(entry, onMenu)}
    {...entryDragProps(entry, drag)}
    className={`file-tree-item ${entry.editable ? '' : 'context-file'}`}
    style={{ paddingLeft: 30 + depth * 14 }}
    isActive={currentPath === entry.path}
    aria-current={currentPath === entry.path ? 'page' : undefined}
    aria-disabled={!entry.editable}
    data-file-path={entry.kind === 'file' ? entry.path : undefined}
    data-selected={selection.paths.has(entry.path)}
    aria-pressed={entry.kind === 'file' ? selection.paths.has(entry.path) : undefined}
    onClick={event => { if (entry.kind === 'file') selection.click(entry, event); }}
  >{entry.editable ? <FileText /> : <File />}<span>{entry.name}</span></SidebarMenuButton></TooltipHint></SidebarMenuItem>;
}

export function FolderSidebar({ folder, documentPath, onOpenFolder, onError, outline, onControlStructureCreated }: {
  folder: LocalFolder | null; documentPath: string | null; onOpenFolder(): void; onError(message: string): void; outline: ReactNode; onControlStructureCreated(): void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState('files');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FolderSearch | null>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const selectionAnchor = useRef<string | null>(null);
  const searchRefresh = useRef(-1);
  const [menu, setMenu] = useState<{ entry: FolderEntry; paths: string[]; x: number; y: number } | null>(null);
  const [action, setAction] = useState<{ type: 'rename' | 'delete' | 'new-file' | 'new-folder'; entry: FolderEntry } | null>(null);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'empty' | 'control'>('empty');
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const dragSourceRef = useRef<FolderEntry | null>(null);
  const dragPathsRef = useRef<string[]>([]);
  const [dragPaths, setDragPaths] = useState(new Set<string>());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  function clearSelection() { setSelected(new Set()); selectionAnchor.current = null; }
  const selection: FileSelection = {
    paths: selected, clear: clearSelection,
    click(entry, event) {
      const additive = event.metaKey || event.ctrlKey;
      if (event.shiftKey || additive) event.preventDefault();
      const next = additive ? new Set(selected) : new Set<string>();
      if (event.shiftKey && selectionAnchor.current) {
        const visible = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
          .filter(item => item.offsetParent !== null).map(item => item.dataset.filePath!);
        const start = visible.indexOf(selectionAnchor.current);
        const end = visible.indexOf(entry.path);
        if (start >= 0 && end >= 0) for (const path of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(path);
        else next.add(entry.path);
      } else {
        if (additive && next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        selectionAnchor.current = entry.path;
      }
      setSelected(next);
      if (!event.shiftKey && !additive && entry.editable) void openFile(entry.path);
    },
  };
  const openMenu: OpenEntryMenu = (entry, point) => {
    const paths = entry.kind === 'file' && selected.has(entry.path) ? [...selected] : [entry.path];
    if (entry.kind === 'file' && !selected.has(entry.path)) setSelected(new Set(paths));
    else if (entry.kind !== 'file') clearSelection();
    setMenu({ entry, paths, ...point });
  };
  const beginAction = (type: 'rename' | 'delete', entry: FolderEntry) => { setAction({ type, entry }); setName(entry.name); setActionError(''); };

  const beginCreate = (type: 'new-file' | 'new-folder', parent?: FolderEntry, initialTemplate: 'empty' | 'control' = 'empty') => {
    if (!folder) return;
    setAction({ type, entry: parent ?? { path: '', name: folder.name, kind: 'directory', editable: false } });
    setTemplate(initialTemplate);
    setName(type === 'new-file' ? initialTemplate === 'control' ? 'Untitled.yaml' : 'Untitled.md' : ''); setActionError('');
  };

  async function move(entry: FolderEntry, destination?: string) {
    try {
      const result = await window.slate?.moveEntry(entry.path, destination);
      if (result?.error) onError(result.error);
      if (result?.changed) {
        clearSelection();
        setRefreshKey(value => value + 1);
        if (destination !== undefined) {
          setQuery('');
          setRevealPath([destination, entry.name].filter(Boolean).join('/'));
        }
      }
    } catch (error) { onError(error instanceof Error ? error.message : 'The item could not be moved.'); }
  }

  async function moveFiles(paths: string[], destination?: string) {
    try {
      const result = await window.slate?.moveFiles(paths, destination);
      if (result?.error) onError(result.error);
      if (result?.changed) {
        setSelected(new Set(result.paths));
        selectionAnchor.current = result.paths?.[0] ?? null;
        setQuery(''); setRevealPath(result.paths?.[0] ?? null);
        setRefreshKey(value => value + 1);
      }
    } catch (error) { onError(error instanceof Error ? error.message : 'The files could not be moved.'); }
  }

  async function importFiles(files: File[], destination: string) {
    try {
      const result = await window.slate?.importFiles(files, destination);
      if (result?.error) onError(result.error);
      if (result?.changed) {
        setQuery('');
        setRevealPath([destination, files[0].name].filter(Boolean).join('/'));
      }
    } catch (error) { onError(error instanceof Error ? error.message : 'The files could not be copied.'); }
    finally { setRefreshKey(value => value + 1); }
  }

  function canDrop(destination: string) {
    const source = dragSourceRef.current;
    if (!source || source.kind === 'link') return false;
    const paths = dragPathsRef.current;
    return paths.some(path => destination !== (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''))
      && paths.every(path => destination !== path && !destination.startsWith(path + '/'));
  }

  function endDrag() {
    dragSourceRef.current = null;
    dragPathsRef.current = [];
    setDragPaths(new Set());
    setDropTarget(null);
  }

  const drag: EntryDrag = {
    paths: dragPaths, target: dropTarget, canDrop,
    start(entry, event) {
      event.stopPropagation();
      if (entry.kind === 'link') { event.preventDefault(); return; }
      dragSourceRef.current = entry;
      const paths = entry.kind === 'file' && selected.has(entry.path) ? [...selected] : [entry.path];
      if (entry.kind === 'file') setSelected(new Set(paths));
      else clearSelection();
      dragPathsRef.current = paths;
      setDragPaths(new Set(paths));
      setMenu(null);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-slate-workspace-entry', entry.path);
    },
    end: endDrag,
    over(destination, event) {
      event.stopPropagation();
      const externalFiles = !dragSourceRef.current && event.dataTransfer.types.includes('Files');
      if (externalFiles || canDrop(destination)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = externalFiles ? 'copy' : 'move';
        setDropTarget(destination);
      } else {
        event.dataTransfer.dropEffect = 'none';
        setDropTarget(null);
      }
    },
    leave(destination, event) {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setDropTarget(current => current === destination ? null : current);
    },
    drop(destination, event) {
      event.preventDefault(); event.stopPropagation();
      const source = dragSourceRef.current;
      const paths = dragPathsRef.current;
      const allowed = canDrop(destination);
      const files = Array.from(event.dataTransfer.files);
      endDrag();
      if (source && allowed) {
        if (paths.length > 1) void moveFiles(paths, destination);
        else void move(source, destination);
      }
      else if (!source && files.length) void importFiles(files, destination);
    },
  };

  async function submitAction() {
    if (!action || working) return;
    const current = action;
    if (current.type === 'new-file' && template === 'control' && !/\.(?:ya?ml|json)$/i.test(name)) { setActionError('Use a .yaml, .yml, or .json filename for an M45 control structure.'); return; }
    setWorking(true); setActionError('');
    // Close the Trash confirmation before any unsaved-tab prompts are shown.
    if (current.type === 'delete') setAction(null);
    try {
      const result = current.type === 'rename'
        ? await window.slate?.renameEntry(current.entry.path, name)
        : current.type === 'delete'
          ? await window.slate?.trashEntry(current.entry.path)
          : await window.slate?.createEntry(current.entry.path, name, current.type === 'new-file' ? 'file' : 'directory', current.type === 'new-file' && template === 'control' ? createControlFile(name.replace(/\.[^.]+$/, ''), /\.json$/i.test(name) ? 'json' : 'yaml') : '');
      if (result?.error) {
        if (current.type !== 'delete') setActionError(result.error);
        else onError(result.error);
      } else {
        setAction(null);
        if (result?.changed) {
          setRefreshKey(value => value + 1);
          if (current.type === 'new-file' && template === 'control') onControlStructureCreated();
          if (current.type === 'new-file' || current.type === 'new-folder') {
            setQuery('');
            setRevealPath('path' in result && typeof result.path === 'string' ? result.path : current.entry.path);
          }
        }
      }
    } finally { setWorking(false); }
  }
  useEffect(() => {
    endDrag();
    clearSelection();
    setTab('files'); setQuery(''); setRevealPath(null); setRefreshKey(value => value + 1);
  }, [folder?.path]);
  useEffect(() => {
    const refresh = () => setRefreshKey(value => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  useEffect(() => {
    if (!query.trim() || !folder) { setResults(null); return; }
    let canceled = false;
    setResults(null);
    const timer = setTimeout(() => {
      const refresh = searchRefresh.current !== refreshKey;
      searchRefresh.current = refreshKey;
      void window.slate?.searchFolder(query, refresh).then(value => { if (!canceled) setResults(value); }).catch(error => {
        if (!canceled) setResults({ error: String(error) });
      });
    }, 150);
    return () => { canceled = true; clearTimeout(timer); };
  }, [query, folder, refreshKey]);

  const normalizedRoot = folder?.path.replace(/\\/g, '/');
  const normalizedFile = documentPath?.replace(/\\/g, '/');
  const currentPath = normalizedRoot && normalizedFile?.startsWith(normalizedRoot + '/') ? normalizedFile.slice(normalizedRoot.length + 1) : null;

  async function openFile(relativePath: string) {
    const result = await window.slate?.openFile(relativePath);
    if (result?.error) onError(result.error);
  }

  const actionTitle = action?.type === 'new-file' ? 'New File' : action?.type === 'new-folder' ? 'New Folder' : action?.type === 'rename' ? 'Rename' : 'Move to Trash?';
  const creating = action?.type === 'new-file' || action?.type === 'new-folder';

  return <Sidebar ref={sidebar} collapsible="none" className="folder-sidebar" aria-label="Workspace sidebar" onKeyDown={event => { if (event.key === 'Escape') clearSelection(); }}>
    <Tabs value={tab} onValueChange={setTab} className="sidebar-tabs">
      <SidebarHeader className="folder-sidebar-header"><TabsList className="sidebar-tab-list"><TabsTrigger value="files">Files</TabsTrigger><TabsTrigger value="outline">Outline</TabsTrigger></TabsList></SidebarHeader>
      <SidebarContent className="folder-sidebar-content">
        <TabsContent value="files" className="folder-tab">
          {folder ? <>
            <div className="folder-controls">
              <div className="folder-heading" {...entryMenuProps({ path: '', name: folder.name, kind: 'directory', editable: false }, openMenu)} {...dropProps('', drag)} aria-label="Workspace folder"><TooltipHint content={folder.path} side="right"><span>{folder.name}</span></TooltipHint><div className="folder-heading-actions">
                <TooltipHint content="New file" side="right"><Button variant="ghost" size="icon" className="small-icon-button" aria-label="New file" onClick={() => beginCreate('new-file')}><FilePlus /></Button></TooltipHint>
                <TooltipHint content="New folder" side="right"><Button variant="ghost" size="icon" className="small-icon-button" aria-label="New folder" onClick={() => beginCreate('new-folder')}><FolderPlus /></Button></TooltipHint>
                <TooltipHint content="Refresh folder" side="right"><Button variant="ghost" size="icon" className="small-icon-button" aria-label="Refresh folder" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw /></Button></TooltipHint>
              </div></div>
              <div className="file-search"><Search size={14} /><Input aria-label="Find file by name" placeholder="Find a file…" value={query} maxLength={200} onChange={event => { clearSelection(); setQuery(event.target.value); }} />{query && <Button variant="ghost" size="icon" className="clear-search" aria-label="Clear file search" onClick={() => { clearSelection(); setQuery(''); }}><X size={13} /></Button>}</div>
              {selected.size > 1 && <div className="file-selection"><span role="status">{selected.size} files selected</span><Button variant="ghost" size="sm" aria-label="Move selected files" onClick={() => void moveFiles([...selected])}>Move…</Button></div>}
            </div>
            {query.trim() ? <div aria-live="polite" className="file-search-results">
              {!results ? <p className="tree-hint">Searching…</p> : results.error ? <p className="tree-hint">{results.error}</p> : <>
                <p className="tree-hint search-count">{results.total ? `${results.total} ${results.total === 1 ? 'file' : 'files'}${results.total > 100 ? ' · showing first 100' : ''}` : 'No matching files'}</p>
                <SidebarMenu>{results.entries?.map(entry => <SidebarMenuItem key={entry.path}><TooltipHint content={entry.path} side="right"><SidebarMenuButton {...entryMenuProps(entry, openMenu)} {...entryDragProps(entry, drag)} data-file-path={entry.path} data-selected={selected.has(entry.path)} aria-pressed={selected.has(entry.path)} className="file-search-result" isActive={currentPath === entry.path} onClick={event => selection.click(entry, event)}><FileText /><span><span>{entry.name}</span><small>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : folder.name}</small></span></SidebarMenuButton></TooltipHint></SidebarMenuItem>)}</SidebarMenu>
                {Boolean(results.unreadableFolders) && <p className="tree-hint">Some folders could not be read and were skipped.</p>}
              </>}
            </div> : <Directory key={folder.path} relativePath="" depth={0} currentPath={currentPath} refreshKey={refreshKey} revealPath={revealPath} onMenu={openMenu} drag={drag} selection={selection} />}
          </> : <div className="folder-empty"><FolderOpen size={24} strokeWidth={1.3} /><p>Your files, in context.</p><span>Open a local folder to browse its Markdown, text, and code files.</span><Button variant="secondary" onClick={onOpenFolder}>Open folder</Button></div>}
        </TabsContent>
        <TabsContent value="outline" className="outline-tab">{outline}</TabsContent>
      </SidebarContent>
    </Tabs>
    <DropdownMenu open={Boolean(menu)} onOpenChange={open => { if (!open) setMenu(null); }}>
      <DropdownMenuTrigger asChild><Button tabIndex={-1} aria-hidden="true" className="tab-menu-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={event => event.preventDefault()}>
        <DropdownMenuItem onSelect={() => { if (menu) void window.slate?.revealEntry(menu.entry.path).then(result => { if (result.error) onError(result.error); }).catch(error => onError(String(error))); }}>{revealLabel(typeof window === 'undefined' ? undefined : window.slate?.platform)}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {menu?.entry.kind === 'directory' && <>
          <DropdownMenuItem onSelect={() => beginCreate('new-file', menu.entry)}>New File…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => beginCreate('new-file', menu.entry, 'control')}>New control structure…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => beginCreate('new-folder', menu.entry)}>New Folder…</DropdownMenuItem>
          {menu.entry.path && <DropdownMenuSeparator />}
        </>}
        {menu?.entry.path && (menu.paths.length > 1 ? <DropdownMenuItem onSelect={() => void moveFiles(menu.paths)}>Move {menu.paths.length} files…</DropdownMenuItem> : <>
          <DropdownMenuItem onSelect={() => { if (menu) beginAction('rename', menu.entry); }}>Rename…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { if (menu) void move(menu.entry); }}>Move…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { if (menu) beginAction('delete', menu.entry); }}>Delete…</DropdownMenuItem>
        </>)}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={Boolean(action)} onOpenChange={open => { if (!open && !working) setAction(null); }}>
      <DialogContent>
        <DialogTitle>{actionTitle}</DialogTitle>
        <DialogDescription>{creating ? `Create ${action?.type === 'new-file' ? 'a file' : 'a folder'} in ${action.entry.path || action.entry.name}.` : action?.type === 'rename' ? `Choose a new name for ${action.entry.name}.` : `${action?.entry.name} will be moved to your system Trash. Open tabs for this item will close.`}</DialogDescription>
        <form onSubmit={event => { event.preventDefault(); void submitAction(); }}>
          {action && action.type !== 'delete' && <Input className="mt-4" aria-label={action.type === 'new-file' ? 'File name' : action.type === 'new-folder' ? 'Folder name' : 'New name'} autoFocus value={name} onChange={event => setName(event.target.value)} onFocus={event => event.currentTarget.select()} />}
          {action?.type === 'new-file' && <label className="new-file-template">Template<NativeSelect aria-label="File template" value={template} onChange={event => {
            const next = event.target.value as typeof template;
            setTemplate(next);
            if (next === 'control') setName(value => value.replace(/\.[^.]+$/, '') + '.yaml');
          }}><option value="empty">Empty file</option><option value="control">Control structure (M45)</option></NativeSelect></label>}
          {actionError && <p role="alert" className="mt-3 text-sm">{actionError}</p>}
          <DialogFooter><Button type="button" variant="secondary" disabled={working} onClick={() => setAction(null)}>Cancel</Button><Button type="submit" disabled={working || (action?.type !== 'delete' && !name.trim())}>{working ? 'Working…' : creating ? 'Create' : action?.type === 'rename' ? 'Rename' : 'Move to Trash'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <SidebarFooter className="folder-sidebar-footer"><Button variant="ghost" className="open-folder-button" onClick={onOpenFolder}><FolderOpen />{folder ? 'Change folder' : 'Open folder'}</Button>{folder && <TooltipHint content={folder.path} side="right"><span>{folder.path}</span></TooltipHint>}</SidebarFooter>
  </Sidebar>;
}
