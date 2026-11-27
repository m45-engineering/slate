'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, FileText, Files, GitPullRequest, LockKeyhole, Minus, Plus, RefreshCw, Search, TriangleExclamationPoint, X } from 'lucide-react';
import { isTextFile, type GitChangePreview, type GitChangesMode, type GitChangesSnapshot, type GitFileChange, type SlateDocument } from '@/lib/document';
import { SourceDiff } from './git-changes';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { TooltipHint } from './ui/tooltip';

function changeKind(file: GitFileChange) {
  const code = file.status;
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'Needs attention';
  if (code === 'D?') return 'Edited';
  if (code.includes('D')) return 'Removed';
  if (code.includes('R')) return 'Renamed';
  if (code.includes('A') || code === '??' || code.includes('C')) return 'New';
  return 'Edited';
}

function localStage(file: GitFileChange) {
  if (file.status === '??') return 'Untracked';
  if (file.status === 'D?') return 'Staged deletion + untracked';
  if (changeKind(file) === 'Needs attention') return 'Unmerged';
  if (file.status[0] !== ' ' && file.status[1] !== ' ') return 'Staged + unstaged';
  return file.status[0] !== ' ' ? 'Staged' : 'Unstaged';
}

const changeKinds = ['Edited', 'New', 'Removed', 'Renamed', 'Needs attention'] as const;
type ChangeKind = ReturnType<typeof changeKind>;
const changeIcons = { New: Plus, Removed: Minus, Renamed: ArrowRight, 'Needs attention': TriangleExclamationPoint };

function ChangeIcon({ kind }: { kind: ReturnType<typeof changeKind> }) {
  if (kind === 'Edited') return null;
  const Icon = changeIcons[kind];
  return <span className={`git-change-icon git-kind-${kind.toLowerCase().replaceAll(' ', '-')}`} role="img" aria-label={kind}><Icon size={14} aria-hidden="true" /></span>;
}

type ChangeFolder = { path: string; name: string; folders: Map<string, ChangeFolder>; files: GitFileChange[] };

function changeTree(files: GitFileChange[]) {
  const root: ChangeFolder = { path: '', name: '', folders: new Map(), files: [] };
  for (const file of files) {
    let parent = root;
    for (const name of file.path.split('/').slice(0, -1)) {
      if (!parent.folders.has(name)) parent.folders.set(name, { path: parent.path ? `${parent.path}/${name}` : name, name, folders: new Map(), files: [] });
      parent = parent.folders.get(name)!;
    }
    parent.files.push(file);
  }
  return root;
}

export function GitWorkspaceChanges({ onOpen, unsavedNames }: { onOpen: (document: SlateDocument) => void; unsavedNames: string[] }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const moved = position !== null;
  const [mode, setMode] = useState<GitChangesMode>('local');
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<GitChangesSnapshot>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<ChangeKind | 'All'>('All');
  const [selection, setSelection] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const treeId = useId();
  const [detail, setDetail] = useState<{ snapshot: GitChangesSnapshot; path: string; preview?: GitChangePreview; error?: string }>();
  const previewArea = useRef<HTMLDivElement>(null);
  const selectMode = (value: string) => { setMode(value as GitChangesMode); setKindFilter('All'); setQuery(''); setSelection(''); setCollapsed(new Set()); };

  const keepInView = (left: number, top: number) => {
    const bounds = dialogRef.current!.getBoundingClientRect();
    return { left: Math.max(12, Math.min(left, window.innerWidth - bounds.width - 12)), top: Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12)) };
  };

  useEffect(() => {
    if (!open || !moved || !dialogRef.current) return;
    const contain = () => setPosition(previous => {
      if (!previous) return previous;
      const next = keepInView(previous.left, previous.top);
      return next.left === previous.left && next.top === previous.top ? previous : next;
    });
    const observer = new ResizeObserver(contain);
    observer.observe(dialogRef.current);
    window.addEventListener('resize', contain);
    return () => { observer.disconnect(); window.removeEventListener('resize', contain); };
  }, [open, moved]);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setSnapshot(undefined); setError(''); setLoading(true);
    void window.slate!.gitChanges(mode).then(result => {
      if (!canceled) {
        setSnapshot(result.snapshot); setError(result.error || '');
        if (result.snapshot) setKindFilter(current => result.snapshot!.files.some(file => changeKind(file) === current) ? current : 'All');
      }
    }).catch(() => { if (!canceled) setError('Could not read the changes. Try refreshing.'); })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [open, mode, refresh]);

  const files = snapshot?.mode === mode ? snapshot.files : [];
  const counts = useMemo(() => {
    const result = new Map<ChangeKind, number>();
    for (const file of files) { const kind = changeKind(file); result.set(kind, (result.get(kind) || 0) + 1); }
    return result;
  }, [files]);
  // A refreshed snapshot can remove the last file in the selected category.
  const activeKind = counts.has(kindFilter as ChangeKind) ? kindFilter : 'All';
  const filtered = useMemo(() => files.filter(file => (activeKind === 'All' || changeKind(file) === activeKind) && `${file.path} ${file.previous || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.path.localeCompare(b.path)), [files, query, activeKind]);
  const selected = filtered.find(file => file.path === selection) || filtered[0];
  const selectedPath = selected?.path;
  const tree = useMemo(() => changeTree(filtered), [filtered]);

  useEffect(() => {
    if (!open || !snapshot || !selectedPath || snapshot.mode !== mode) return;
    let canceled = false;
    void window.slate!.gitChange(mode, selectedPath, { head: snapshot.head, base: snapshot.base }).then(result => {
      if (!canceled) setDetail({ snapshot, path: selectedPath, ...result });
    }).catch(() => { if (!canceled) setDetail({ snapshot, path: selectedPath, error: 'Could not load this preview. Try refreshing.' }); });
    return () => { canceled = true; };
  }, [open, snapshot, mode, selectedPath]);

  const currentDetail = detail?.snapshot === snapshot && detail?.path === selectedPath ? detail : undefined;
  const preview = currentDetail?.preview;
  useEffect(() => {
    const area = previewArea.current;
    const firstChange = area?.querySelector('ins, del');
    if (area && firstChange) area.scrollTop = Math.max(0, firstChange.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 32);
  }, [preview]);
  const openDocument = async () => {
    if (!selected) return;
    try {
      const result = await window.slate!.openFile(selected.path);
      if (result.error) setError(result.error);
      else if (result.document) { onOpen(result.document); setOpen(false); }
    } catch { setError('Could not open this document. Refresh to check whether it has moved.'); }
  };

  const renderTree = (parent: ChangeFolder, depth = 0) => <ul className="git-change-tree">
    {[...parent.folders.values()].map(entry => {
      // Keep single-child paths together without flattening branching folders.
      let folder = entry;
      const names = [folder.name];
      while (!folder.files.length && folder.folders.size === 1) {
        folder = folder.folders.values().next().value!;
        names.push(folder.name);
      }
      const path = folder.path;
      const expanded = !collapsed.has(path);
      const id = `${treeId}-${encodeURIComponent(path)}`;
      return <li key={entry.path}>
        <Button variant="ghost" className="git-folder-row" style={{ top: depth * 28, zIndex: 100 - depth }} aria-label={`Folder ${path}`} aria-expanded={expanded} aria-controls={id} title={path} onClick={() => setCollapsed(previous => {
          const next = new Set(previous);
          if (next.has(path)) next.delete(path); else next.add(path);
          return next;
        })}>
          <ChevronRight size={12} className="git-folder-chevron" />
          <span className="git-folder-name">{names.map((name, index) => <span key={index}>{index > 0 && <span className="git-path-divider"> / </span>}{name}</span>)}</span>
        </Button>
        <div id={id} hidden={!expanded}>{renderTree(folder, depth + 1)}</div>
      </li>;
    })}
    {parent.files.map(file => <li key={file.path}>
      <TooltipHint content={`${file.path} · ${changeKind(file)}`} side="right"><Button variant="ghost" className="git-file-row" aria-label={file.path} aria-description={changeKind(file)} aria-pressed={file.path === selectedPath} onClick={() => setSelection(file.path)}>
        <span className="git-file-name">{file.path.split('/').at(-1)}</span>{activeKind === 'All' && <ChangeIcon kind={changeKind(file)} />}
      </Button></TooltipHint>
    </li>)}
  </ul>;

  return <>
    <Button variant="ghost" className="git-status" onClick={() => { setPosition(null); setOpen(true); }}><Files size={14} />Workspace changes</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent ref={dialogRef} className="git-workspace-dialog" style={position ? { ...position, translate: 'none', transform: 'none' } : undefined}>
      <header className="git-overview-header" onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, [role="tablist"]')) return;
        const bounds = dialogRef.current!.getBoundingClientRect();
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
        setPosition({ left: bounds.left, top: bounds.top });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }} onPointerMove={event => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) setPosition(keepInView(start.left + event.clientX - start.x, start.top + event.clientY - start.y));
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
        <div className="git-overview-title"><DialogTitle>Changes</DialogTitle><span className="git-readonly"><LockKeyhole size={12} />View only</span></div>
        <DialogDescription className="sr-only">{mode === 'branch' ? 'Preview the recorded changes this work would contribute to main.' : 'See saved file edits that have not yet been recorded in history.'} Viewing changes won’t modify your files or history.</DialogDescription>
        <Tabs value={mode} onValueChange={selectMode}><TabsList aria-label="Comparison scope" className="git-scope-tabs">
          <TabsTrigger value="local"><Files size={15} />On this computer</TabsTrigger><TabsTrigger value="branch"><GitPullRequest size={15} />Review preview</TabsTrigger>
        </TabsList></Tabs>
        <Button variant="ghost" className="git-overview-refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} className={loading ? 'git-spinning' : ''} />Refresh</Button>
        <Button variant="ghost" size="icon" aria-label="Close workspace changes" onClick={() => setOpen(false)}><X size={18} /></Button>
      </header>
      {mode === 'local' && unsavedNames.length > 0 && <p className="git-draft-note">Unsaved in Slate: {unsavedNames.join(', ')}. Open the document to see those edits.</p>}
      <div className="git-overview-summary">
        <div className="git-kind-filters" role="group" aria-label="Filter by change type">
          {(['All', ...changeKinds] as const).filter(kind => kind === 'All' || counts.has(kind)).map(kind => <Button key={kind} variant="ghost" disabled={loading || !!error} aria-pressed={activeKind === kind} onClick={() => { setKindFilter(kind); setCollapsed(new Set()); }}>
            {kind}<span>{kind === 'All' ? files.length : counts.get(kind)}</span>
          </Button>)}
        </div>
        <span className="git-comparison-context">{mode === 'branch' ? 'Local copy of main · May differ from the online version' : 'Saved files · Unsaved edits excluded'}</span>
      </div>
      {error ? <div className="git-overview-empty" role="alert"><Files size={28} /><h3>Comparison unavailable</h3><p>{error}</p>{mode === 'branch' && <Button variant="secondary" onClick={() => selectMode('local')}>View local edits</Button>}</div>
        : loading ? <div className="git-overview-empty" role="status"><RefreshCw size={28} className="git-spinning" /><p>Reading changes…</p></div>
          : !files.length ? <div className="git-overview-empty"><span className="git-empty-icon"><Check size={28} /></span><h3>{mode === 'branch' ? 'No recorded changes to review' : 'Your saved files are unchanged'}</h3><p>{mode === 'branch' ? 'There are no recorded file changes for this review. Edits not yet recorded in history appear under On this computer.' : 'There are no saved changes in this folder. Files excluded from tracking and unsaved edits are not included.'}</p>{mode === 'branch' && <Button variant="secondary" onClick={() => selectMode('local')}>View local edits</Button>}</div>
            : <div className="git-overview-body">
              <aside className="git-changed-files" aria-label="Changed files">
                <div className="git-file-filter"><Search size={15} /><Input aria-label="Filter changed files" placeholder="Find a changed file…" value={query} onChange={event => { setQuery(event.target.value); setCollapsed(new Set()); }} /></div>
                <nav aria-label="Changed file navigation">{!filtered.length ? <p className="git-notice">No files match “{query}”{activeKind !== 'All' && ` in ${activeKind.toLowerCase()} files`}.</p> : renderTree(tree)}</nav>
              </aside>
              <section className="git-file-preview" aria-label="File change preview">
                {selected ? <><header><div><div className="git-preview-title"><h3>{selected.path.split('/').at(-1)}</h3><span className="git-selected-kind">{changeKind(selected)}</span></div><p>{selected.path}</p>{selected.previous && <p>Previously {selected.previous}</p>}</div>
                  {mode === 'local' && preview?.afterExists && isTextFile(selected.path) && <Button variant="ghost" className="git-open-document" onClick={() => void openDocument()}>Open document<ArrowUpRight size={14} /></Button>}</header>
                  {changeKind(selected) === 'Needs attention' && <p className="git-conflict-note" role="alert">Two versions of this file could not be combined automatically. Resolve the conflicting edits in your Git tool before submitting this work for review.</p>}
                  <div className="git-preview-content" ref={previewArea} key={`${mode}:${selected.path}`}>
                    {!currentDetail ? <p className="git-notice" role="status">Loading file changes…</p> : currentDetail.error ? <div className="git-preview-unavailable"><FileText size={28} /><h4>Preview unavailable</h4><p>{currentDetail.error}</p><p>The file remains listed in this comparison.</p></div> : preview && <>
                      {preview.before === preview.after && <p className="git-notice">The text matches the comparison version. See Git details for other file changes.</p>}
                      <SourceDiff before={preview.before} after={preview.after} />
                    </>}
                  </div>
                </> : <div className="git-overview-empty"><FileText size={28} /><p>Choose a file to inspect its changes.</p></div>}
              </section>
            </div>}
      {snapshot && <details className="git-overview-details" key={mode}><summary>Git details</summary><dl>
        <dt>Branch</dt><dd>{snapshot.branch || 'Detached HEAD'}</dd>
        <dt>HEAD</dt><dd>{snapshot.head || 'No commits yet'}</dd>
        {mode === 'branch' ? <><dt>Local main</dt><dd>{snapshot.base}</dd><dt>Merge base</dt><dd>{snapshot.mergeBase}</dd><dt>Branch commits</dt><dd>{snapshot.commits}</dd><dt>Comparison</dt><dd>Merge base → HEAD. Uncommitted changes excluded. No remote fetch.</dd></> : <><dt>Comparison</dt><dd>HEAD → working tree. Includes staged, unstaged, and untracked files. Ignored files excluded.</dd></>}
        {selected && <><dt>Selected file</dt><dd>{selected.path}{mode === 'local' ? ` · ${localStage(selected)}` : ''} · Git status: <code>{selected.status}</code></dd></>}
      </dl></details>}
    </DialogContent></Dialog>
  </>;
}
