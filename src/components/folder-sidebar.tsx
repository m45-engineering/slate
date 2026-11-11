'use client';

import { useEffect, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent, type DragEvent } from 'react';
import { ChevronRight, File, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw, Search, X } from 'lucide-react';
import type { FolderEntry, FolderListing, FolderSearch, LocalFolder } from '@/lib/document';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipHint } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type OpenEntryMenu = (entry: FolderEntry, point: { x: number; y: number }) => void;
function entryMenuProps(entry: FolderEntry, onMenu: OpenEntryMenu) {
  return {
    onContextMenu: (event: MouseEvent<HTMLButtonElement>) => {
      if (entry.kind === 'link') return;
      event.preventDefault(); onMenu(entry, { x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (entry.kind !== 'link' && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onMenu(entry, { x: rect.left, y: rect.bottom });
      }
    },
  };
}

type EntryDrag = {
  source: FolderEntry | null; target: string | null;
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
    'data-dragging': drag.source?.path === entry.path,
    onDragStart: (event: DragEvent<HTMLElement>) => drag.start(entry, event),
    onDragEnd: () => drag.end(),
    ...(entry.kind === 'directory' ? dropProps(entry.path, drag) : {}),
  };
}

function Directory({ relativePath, depth, currentPath, refreshKey, revealPath, onOpen, onMenu, drag }: {
  relativePath: string; depth: number; currentPath: string | null; refreshKey: number; revealPath: string | null;
  onOpen(path: string): void; onMenu: OpenEntryMenu; drag: EntryDrag;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  useEffect(() => {
    let canceled = false;
    setListing(null);
    void window.slate?.listFolder(relativePath).then(result => { if (!canceled) setListing(result); }).catch(error => {
      if (!canceled) setListing({ error: String(error) });
    });
    return () => { canceled = true; };
  }, [relativePath, refreshKey]);

  if (!listing) return <p className="tree-hint" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</p>;
  if (listing.error) return <p className="tree-hint" role="status">{listing.error}</p>;
  return <SidebarMenu className="file-tree-list">
    {listing.entries?.map(entry => <Entry key={entry.path} entry={entry} depth={depth} currentPath={currentPath} refreshKey={refreshKey} revealPath={revealPath} onOpen={onOpen} onMenu={onMenu} drag={drag} />)}
    {!listing.entries?.length && <p className="tree-hint" style={{ paddingLeft: 12 + depth * 14 }}>Empty folder</p>}
    {listing.truncated && <p className="tree-hint">Showing the first 1,500 items. Open a smaller folder to see the rest.</p>}
  </SidebarMenu>;
}

function Entry({ entry, depth, currentPath, refreshKey, revealPath, onOpen, onMenu, drag }: {
  entry: FolderEntry; depth: number; currentPath: string | null; refreshKey: number; revealPath: string | null;
  onOpen(path: string): void; onMenu: OpenEntryMenu; drag: EntryDrag;
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
      <TooltipHint content={entry.path} side="right"><CollapsibleTrigger asChild><SidebarMenuButton {...entryMenuProps(entry, onMenu)} {...entryDragProps(entry, drag)} className="file-tree-item" style={{ paddingLeft: 12 + depth * 14 }}>
        <ChevronRight className={expanded ? 'tree-chevron expanded' : 'tree-chevron'} />
        {expanded ? <FolderOpen /> : <Folder />}<span>{entry.name}</span>
      </SidebarMenuButton></CollapsibleTrigger></TooltipHint>
      <CollapsibleContent><Directory relativePath={entry.path} depth={depth + 1} currentPath={currentPath} refreshKey={refreshKey} revealPath={revealPath} onOpen={onOpen} onMenu={onMenu} drag={drag} /></CollapsibleContent>
    </SidebarMenuItem>
  </Collapsible>;
  return <SidebarMenuItem><TooltipHint content={entry.editable ? entry.path : `${entry.path} · ${entry.kind === 'link' ? 'symbolic link' : 'binary or unsupported file type'}`} side="right"><SidebarMenuButton
    {...entryMenuProps(entry, onMenu)}
    {...entryDragProps(entry, drag)}
    className={`file-tree-item ${entry.editable ? '' : 'context-file'}`}
    style={{ paddingLeft: 30 + depth * 14 }}
    isActive={currentPath === entry.path}
    aria-current={currentPath === entry.path ? 'page' : undefined}
    aria-disabled={!entry.editable}
    onClick={() => { if (entry.editable) onOpen(entry.path); }}
  >{entry.editable ? <FileText /> : <File />}<span>{entry.name}</span></SidebarMenuButton></TooltipHint></SidebarMenuItem>;
}

export function FolderSidebar({ folder, documentPath, onOpenFolder, onError, outline }: {
  folder: LocalFolder | null; documentPath: string | null; onOpenFolder(): void; onError(message: string): void; outline: ReactNode;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState('files');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FolderSearch | null>(null);
  const searchRefresh = useRef(-1);
  const [menu, setMenu] = useState<{ entry: FolderEntry; x: number; y: number } | null>(null);
  const [action, setAction] = useState<{ type: 'rename' | 'delete' | 'new-file' | 'new-folder'; entry: FolderEntry } | null>(null);
  const [name, setName] = useState('');
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [dragSource, setDragSource] = useState<FolderEntry | null>(null);
  const dragSourceRef = useRef<FolderEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const openMenu: OpenEntryMenu = (entry, point) => setMenu({ entry, ...point });
  const beginAction = (type: 'rename' | 'delete', entry: FolderEntry) => { setAction({ type, entry }); setName(entry.name); setActionError(''); };

  const beginCreate = (type: 'new-file' | 'new-folder', parent?: FolderEntry) => {
    if (!folder) return;
    setAction({ type, entry: parent ?? { path: '', name: folder.name, kind: 'directory', editable: false } });
    setName(type === 'new-file' ? 'Untitled.md' : ''); setActionError('');
  };

  async function move(entry: FolderEntry, destination?: string) {
    try {
      const result = await window.slate?.moveEntry(entry.path, destination);
      if (result?.error) onError(result.error);
      if (result?.changed) {
        setRefreshKey(value => value + 1);
        if (destination !== undefined) {
          setQuery('');
          setRevealPath([destination, entry.name].filter(Boolean).join('/'));
        }
      }
    } catch (error) { onError(error instanceof Error ? error.message : 'The item could not be moved.'); }
  }

  function canDrop(destination: string) {
    const source = dragSourceRef.current;
    if (!source || source.kind === 'link') return false;
    const parent = source.path.includes('/') ? source.path.slice(0, source.path.lastIndexOf('/')) : '';
    return destination !== parent && destination !== source.path && !destination.startsWith(source.path + '/');
  }

  function endDrag() {
    dragSourceRef.current = null;
    setDragSource(null); setDropTarget(null);
  }

  const drag: EntryDrag = {
    source: dragSource, target: dropTarget, canDrop,
    start(entry, event) {
      event.stopPropagation();
      if (entry.kind === 'link') { event.preventDefault(); return; }
      dragSourceRef.current = entry;
      setDragSource(entry); setMenu(null);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-slate-workspace-entry', entry.path);
    },
    end: endDrag,
    over(destination, event) {
      event.stopPropagation();
      if (canDrop(destination)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
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
      const allowed = canDrop(destination);
      endDrag();
      if (source && allowed) void move(source, destination);
    },
  };

  async function submitAction() {
    if (!action || working) return;
    const current = action;
    setWorking(true); setActionError('');
    // Close the Trash confirmation before any unsaved-tab prompts are shown.
    if (current.type === 'delete') setAction(null);
    try {
      const result = current.type === 'rename'
        ? await window.slate?.renameEntry(current.entry.path, name)
        : current.type === 'delete'
          ? await window.slate?.trashEntry(current.entry.path)
          : await window.slate?.createEntry(current.entry.path, name, current.type === 'new-file' ? 'file' : 'directory');
      if (result?.error) {
        if (current.type !== 'delete') setActionError(result.error);
        else onError(result.error);
      } else {
        setAction(null);
        if (result?.changed) {
          setRefreshKey(value => value + 1);
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

  return <Sidebar collapsible="none" className="folder-sidebar" aria-label="Workspace sidebar">
    <Tabs value={tab} onValueChange={setTab} className="sidebar-tabs">
      <SidebarHeader className="folder-sidebar-header"><TabsList className="sidebar-tab-list"><TabsTrigger value="files">Files</TabsTrigger><TabsTrigger value="outline">Outline</TabsTrigger></TabsList></SidebarHeader>
      <SidebarContent className="folder-sidebar-content">
        <TabsContent value="files" className="folder-tab">
          {folder ? <>
            <div className="folder-heading" {...dropProps('', drag)} aria-label="Workspace folder"><TooltipHint content={folder.path} side="right"><span>{folder.name}</span></TooltipHint><div className="folder-heading-actions">
              <TooltipHint content="New file" side="right"><Button variant="ghost" size="icon" className="small-icon-button" aria-label="New file" onClick={() => beginCreate('new-file')}><FilePlus /></Button></TooltipHint>
              <TooltipHint content="New folder" side="right"><Button variant="ghost" size="icon" className="small-icon-button" aria-label="New folder" onClick={() => beginCreate('new-folder')}><FolderPlus /></Button></TooltipHint>
              <TooltipHint content="Refresh folder" side="right"><Button variant="ghost" size="icon" className="small-icon-button" aria-label="Refresh folder" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw /></Button></TooltipHint>
            </div></div>
            <div className="file-search"><Search size={14} /><Input aria-label="Find file by name" placeholder="Find a file…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />{query && <Button variant="ghost" size="icon" className="clear-search" aria-label="Clear file search" onClick={() => setQuery('')}><X size={13} /></Button>}</div>
            {query.trim() ? <div aria-live="polite" className="file-search-results">
              {!results ? <p className="tree-hint">Searching…</p> : results.error ? <p className="tree-hint">{results.error}</p> : <>
                <p className="tree-hint search-count">{results.total ? `${results.total} ${results.total === 1 ? 'file' : 'files'}${results.total > 100 ? ' · showing first 100' : ''}` : 'No matching files'}</p>
                <SidebarMenu>{results.entries?.map(entry => <SidebarMenuItem key={entry.path}><TooltipHint content={entry.path} side="right"><SidebarMenuButton {...entryMenuProps(entry, openMenu)} {...entryDragProps(entry, drag)} className="file-search-result" isActive={currentPath === entry.path} onClick={() => void openFile(entry.path)}><FileText /><span><span>{entry.name}</span><small>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : folder.name}</small></span></SidebarMenuButton></TooltipHint></SidebarMenuItem>)}</SidebarMenu>
                {results.truncated && <p className="tree-hint">This folder is very large. Open a smaller folder to search all its files.</p>}
              </>}
            </div> : <Directory key={folder.path} relativePath="" depth={0} currentPath={currentPath} refreshKey={refreshKey} revealPath={revealPath} onOpen={path => void openFile(path)} onMenu={openMenu} drag={drag} />}
          </> : <div className="folder-empty"><FolderOpen size={24} strokeWidth={1.3} /><p>Your files, in context.</p><span>Open a local folder to browse its Markdown, text, and code files.</span><Button variant="secondary" onClick={onOpenFolder}>Open folder</Button></div>}
        </TabsContent>
        <TabsContent value="outline" className="outline-tab">{outline}</TabsContent>
      </SidebarContent>
    </Tabs>
    <DropdownMenu open={Boolean(menu)} onOpenChange={open => { if (!open) setMenu(null); }}>
      <DropdownMenuTrigger asChild><Button tabIndex={-1} aria-hidden="true" className="tab-menu-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={event => event.preventDefault()}>
        {menu?.entry.kind === 'directory' && <>
          <DropdownMenuItem onSelect={() => beginCreate('new-file', menu.entry)}>New File…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => beginCreate('new-folder', menu.entry)}>New Folder…</DropdownMenuItem>
          <DropdownMenuSeparator />
        </>}
        <DropdownMenuItem onSelect={() => { if (menu) beginAction('rename', menu.entry); }}>Rename…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { if (menu) void move(menu.entry); }}>Move…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { if (menu) beginAction('delete', menu.entry); }}>Delete…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={Boolean(action)} onOpenChange={open => { if (!open && !working) setAction(null); }}>
      <DialogContent>
        <DialogTitle>{actionTitle}</DialogTitle>
        <DialogDescription>{creating ? `Create ${action?.type === 'new-file' ? 'a file' : 'a folder'} in ${action.entry.path || action.entry.name}.` : action?.type === 'rename' ? `Choose a new name for ${action.entry.name}.` : `${action?.entry.name} will be moved to your system Trash. Open tabs for this item will close.`}</DialogDescription>
        <form onSubmit={event => { event.preventDefault(); void submitAction(); }}>
          {action && action.type !== 'delete' && <Input className="mt-4" aria-label={action.type === 'new-file' ? 'File name' : action.type === 'new-folder' ? 'Folder name' : 'New name'} autoFocus value={name} onChange={event => setName(event.target.value)} onFocus={event => event.currentTarget.select()} />}
          {actionError && <p role="alert" className="mt-3 text-sm">{actionError}</p>}
          <DialogFooter><Button type="button" variant="secondary" disabled={working} onClick={() => setAction(null)}>Cancel</Button><Button type="submit" disabled={working || (action?.type !== 'delete' && !name.trim())}>{working ? 'Working…' : creating ? 'Create' : action?.type === 'rename' ? 'Rename' : 'Move to Trash'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <SidebarFooter className="folder-sidebar-footer"><Button variant="ghost" className="open-folder-button" onClick={onOpenFolder}><FolderOpen />{folder ? 'Change folder' : 'Open folder'}</Button>{folder && <TooltipHint content={folder.path} side="right"><span>{folder.path}</span></TooltipHint>}</SidebarFooter>
  </Sidebar>;
}
