'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { GitBranch, History, RefreshCw, Diff, X } from 'lucide-react';
import { documentExtensions } from '@/lib/editor-extensions';
import { GitHighlights, gitDecorations, gitHighlightsKey } from '@/lib/git-highlights';
import { diffText } from '@/lib/text-diff';
import { sourceOnlyReason, type GitSnapshot, type SlateDocument } from '@/lib/document';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';

export function useGitDocument(doc: SlateDocument, savedSource: string) {
  const key = `${doc.id}:${doc.path}`;
  const [opened, setOpened] = useState('');
  const [selection, setSelection] = useState<{ key: string; revision: string | null }>({ key, revision: null });
  const revision = selection.key === key ? selection.revision : null;
  const requestKey = `${key}:${revision || 'HEAD'}`;
  const [result, setResult] = useState<{ key: string; snapshot?: GitSnapshot; error?: string }>({ key: '' });
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!window.slate || !doc.path) { setLoading(false); return; }
    setLoading(true);
    try {
      const response = await window.slate.gitDocument(doc.id, revision);
      if (request === sequence.current) setResult({ key: requestKey, ...response });
    } catch { if (request === sequence.current) setResult({ key: requestKey, error: 'Could not read Git history. Try refreshing.' }); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [doc.id, doc.path, requestKey, revision]);
  useEffect(() => { void refresh(); return () => { sequence.current++; }; }, [refresh, savedSource]);
  useEffect(() => {
    const focused = () => void refresh();
    window.addEventListener('focus', focused);
    const timer = opened === key ? setInterval(focused, 30_000) : null;
    return () => { window.removeEventListener('focus', focused); if (timer) clearInterval(timer); };
  }, [refresh, key, opened]);
  return {
    snapshot: result.key === requestKey ? result.snapshot : undefined,
    error: result.key === requestKey ? result.error : undefined,
    loading, open: opened === key, revision, refresh,
    toggle: () => { setOpened(opened === key ? '' : key); void refresh(); },
    showDocument: (document: SlateDocument) => {
      const target = `${document.id}:${document.path}`;
      setSelection({ key: target, revision: null });
      setOpened(target);
    },
    select: (value: string | null) => { setSelection({ key, revision: value }); setOpened(key); },
  };
}

type GitState = ReturnType<typeof useGitDocument>;
function HistoryMenu({ git, label = 'History' }: { git: GitState; label?: string }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="text-button" aria-label={label} disabled={git.loading || !git.snapshot}><History size={15} /><span className="git-control-label">{label}</span></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="git-history-menu">
      <DropdownMenuItem onSelect={() => git.select(null)}>Latest committed version</DropdownMenuItem>
      {git.snapshot?.history.map(item => <DropdownMenuItem key={item.hash} onSelect={() => git.select(item.hash)} className="git-history-item"><span>{item.subject}</span><small>{new Date(item.date).toLocaleDateString()} · {item.author} · {item.hash.slice(0, 8)}</small></DropdownMenuItem>)}
      {!git.snapshot?.history.length && <span className="git-history-empty">No recorded history for this path.</span>}
    </DropdownMenuContent></DropdownMenu>;
}

export function GitToolbar({ git }: { git: GitState }) {
  return <><HistoryMenu git={git} /><Button variant={git.open ? 'default' : 'ghost'} className="git-comparison-toggle" aria-label={git.open ? 'Exit comparison' : 'Changes'} aria-pressed={git.open} onClick={git.toggle}>{git.open ? <X size={15} /> : <Diff size={15} />}<span className={git.open ? 'git-exit-label' : 'git-control-label'}>{git.open ? 'Exit comparison' : 'Changes'}</span></Button></>;
}

export function GitStatus({ git }: { git: GitState }) {
  const [open, setOpen] = useState(false);
  if (!git.snapshot) return null;
  const { branch, head, root, base, ahead, behind } = git.snapshot;
  return <><Button variant="ghost" className="git-status" onClick={() => { setOpen(true); void git.refresh(); }}><GitBranch size={13} /><span>Git details</span></Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>Git details</DialogTitle><DialogDescription>Git inspection is read-only. Slate does not commit, push, switch branches, or merge.</DialogDescription>
      <p className="git-root">{root}</p><p>{branch || 'Detached HEAD'} · {head?.slice(0, 8) || 'No commits yet'}</p>
      {base && <p>{ahead} commits ahead and {behind} behind local {base}. Uncommitted edits are excluded.</p>}
      <p>Pull request status is not connected. Continue reviewing and merging in your Git host.</p>
      {git.error && <p role="alert">{git.error}</p>}
    </DialogContent></Dialog></>;
}

export function SourceDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffText(before, after), [before, after]);
  return <pre className="git-source-diff" aria-label="Source comparison">{parts.map((part, index) => part.kind === 'added' ? <ins className="git-added" key={index}>{part.text}</ins> : part.kind === 'removed' ? <del className="git-removed" key={index}>{part.text}</del> : <span key={index}>{part.text}</span>)}</pre>;
}

function VisualDiff({ before, after, onError, onTextChanges }: { before: string; after: string; onError: (value: string) => void; onTextChanges: (value: boolean) => void }) {
  const editor = useEditor({
    immediatelyRender: false, editable: false,
    extensions: [...documentExtensions(), GitHighlights],
    editorProps: { attributes: { class: 'document-editor git-document', 'aria-label': 'Document changes', 'aria-readonly': 'true' } },
  });
  useEffect(() => {
    if (!editor?.markdown) return;
    try {
      editor.commands.setContent(after, { contentType: 'markdown', emitUpdate: false });
      const previous = editor.schema.nodeFromJSON(editor.markdown.parse(before));
      const decorations = gitDecorations(previous, editor.state.doc);
      editor.view.dispatch(editor.state.tr.setMeta(gitHighlightsKey, decorations));
      onTextChanges(decorations.find().length > 0);
    } catch { onError('This document cannot be compared visually. Its source comparison is shown below.'); }
  }, [editor, before, after, onError, onTextChanges]);
  return <EditorContent editor={editor} />;
}

export function GitComparison({ git, source, markdown, dirty }: { git: GitState; source: string; markdown: boolean; dirty: boolean }) {
  const [visualError, setVisualError] = useState('');
  const [hasTextChanges, setHasTextChanges] = useState(true);
  const before = git.snapshot?.baseline.content ?? '';
  useEffect(() => setVisualError(''), [before, source]);
  const tooLarge = source.length > 200_000 || before.length > 200_000;
  const reason = markdown ? sourceOnlyReason(source) || sourceOnlyReason(before) : 'source file';
  const selected = git.snapshot?.history.find(item => item.hash === git.revision);
  return <section className="git-comparison" aria-label="Git comparison">
    <div className="git-comparison-header"><span>{git.revision ? `Compared with ${selected ? new Date(selected.date).toLocaleDateString() : git.revision.slice(0, 8)}` : 'Compared with last commit'} · {dirty ? 'Includes unsaved edits' : 'Open document'} · Read-only</span><HistoryMenu git={git} /><Button variant="ghost" size="icon" aria-label="Refresh Git history" disabled={git.loading} onClick={() => void git.refresh()}><RefreshCw size={14} /></Button></div>
    {git.loading && <p className="git-notice" role="status">Refreshing Git history…</p>}
    {git.error ? <div className="git-notice" role="alert"><p>{git.error}</p>{git.revision && <Button variant="ghost" onClick={() => git.select(null)}>Compare with latest commit</Button>}</div> : !git.snapshot ? <p className="git-notice">Reading repository…</p> : tooLarge ? <p className="git-notice">This document is too large for inline comparison (200,000 characters). Editing and saving remain available.</p> : <>
      {!git.snapshot.baseline.exists && <p className="git-notice">No committed version exists at this path. The document is shown as added.</p>}
      {before === source && <p className="git-notice" role="status">No changes from this committed version.</p>}
      {reason || visualError ? <><p className="git-notice">{visualError || `Showing source changes to preserve ${reason}.`}</p><SourceDiff before={before} after={source} /></> : <>
        {!hasTextChanges && before !== source && <p className="git-notice">The source changed without changing the compared text. The source changes are expanded below.</p>}
        <VisualDiff before={before} after={source} onError={setVisualError} onTextChanges={setHasTextChanges} />
        <details className="git-source-details" open={!hasTextChanges && before !== source ? true : undefined}><summary>All source changes — including formatting, links, and diagrams</summary><SourceDiff before={before} after={source} /></details>
      </>}
    </>}
  </section>;
}
