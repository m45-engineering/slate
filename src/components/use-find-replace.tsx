'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { closeHistory } from '@tiptap/pm/history';
import { findInDocument, findText } from '@/lib/find';
import { findHighlightsKey } from '@/lib/find-highlights';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Icon } from './icon';

export function useFindReplace({ editor, source, mode, documentId, sourceInput, onSourceChange }: {
  editor: Editor | null; source: string; mode: 'visual' | 'source'; documentId: string;
  sourceInput: RefObject<HTMLTextAreaElement | null>; onSourceChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [anchor, setAnchor] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const doc = editor?.state.doc;
  const matches = useMemo(() => !open ? [] : mode === 'visual' && doc
    ? findInDocument(doc, query, matchCase) : findText(source, query, matchCase), [open, mode, doc, source, query, matchCase]);
  const active = matches.length ? Math.max(0, matches.findIndex(match => match.from >= anchor)) : -1;
  const current = matches[active];

  useEffect(() => { setAnchor(0); }, [documentId, mode]);

  useLayoutEffect(() => {
    if (!open) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [open, focusRequest]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(findHighlightsKey, { matches: mode === 'visual' ? matches : [], active }).setMeta('addToHistory', false));
  }, [editor, mode, matches, active]);

  useEffect(() => {
    if (!open || !current) return;
    if (mode === 'visual') {
      editor?.view.dom.querySelector('.find-match-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      const input = sourceInput.current;
      const mark = input?.parentElement?.querySelector<HTMLElement>('.find-match-active');
      const scroll = input?.closest('.document-scroll');
      if (!input || !mark || !scroll) return;
      input.setSelectionRange(current.from, current.to);
      if (mark.offsetLeft < input.scrollLeft) input.scrollLeft = mark.offsetLeft;
      else if (mark.offsetLeft + mark.offsetWidth > input.scrollLeft + input.clientWidth) {
        input.scrollLeft = mark.offsetLeft + mark.offsetWidth - input.clientWidth;
      }
      const matchBounds = mark.getBoundingClientRect();
      const viewBounds = scroll.getBoundingClientRect();
      if (matchBounds.top < viewBounds.top) scroll.scrollBy(0, matchBounds.top - viewBounds.top);
      else if (matchBounds.bottom > viewBounds.bottom) scroll.scrollBy(0, matchBounds.bottom - viewBounds.bottom);
    }
  }, [open, current, editor, mode, sourceInput]);

  const openFind = useCallback((replace = false) => {
    const input = sourceInput.current;
    const selection = mode === 'visual' && editor
      ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')
      : input ? source.slice(input.selectionStart, input.selectionEnd) : '';
    if (selection && !selection.includes('\n')) { setQuery(selection); setAnchor(0); }
    setOpen(true);
    setReplaceOpen(replace);
    setFocusRequest(value => value + 1);
  }, [editor, mode, source, sourceInput]);

  const close = () => {
    setOpen(false);
    if (mode === 'visual') {
      if (current) editor?.commands.setTextSelection(current);
      editor?.commands.focus();
    }
    else sourceInput.current?.focus({ preventScroll: true });
  };

  const navigate = useCallback((direction: number) => {
    if (!open) { openFind(); return; }
    if (matches.length) setAnchor(matches[(active + direction + matches.length) % matches.length].from);
  }, [open, openFind, matches, active]);

  const replace = (all: boolean) => {
    if (!current) return;
    const targets = all ? matches : [current];
    if (mode === 'visual' && editor) {
      const transaction = closeHistory(editor.state.tr);
      for (const match of [...targets].reverse()) transaction.insertText(replacement, match.from, match.to);
      editor.view.dispatch(transaction);
      editor.view.dispatch(closeHistory(editor.state.tr));
    } else if (sourceInput.current) {
      const input = sourceInput.current;
      const parts: string[] = [];
      let offset = 0;
      for (const match of targets) {
        parts.push(source.slice(offset, match.from), replacement);
        offset = match.to;
      }
      parts.push(source.slice(offset));
      const next = parts.join('');
      input.focus({ preventScroll: true });
      input.setSelectionRange(all ? 0 : current.from, all ? source.length : current.to);
      // Native insertion keeps replacements in the textarea's undo history.
      if (!document.execCommand('insertText', false, all ? next : replacement)) onSourceChange(next);
      findInput.current?.focus({ preventScroll: true });
    }
    setAnchor(all ? 0 : current.from + replacement.length);
  };

  const bar = open && <div className="find-bar" role="search" aria-label="Find in document" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      if (event.target === findInput.current) navigate(event.shiftKey ? -1 : 1);
      else replace(false);
    }
  }}>
    <div className="find-row">
      <Button variant="ghost" size="sm" aria-label={replaceOpen ? 'Hide replace' : 'Show replace'} aria-expanded={replaceOpen} onClick={() => setReplaceOpen(!replaceOpen)}>{replaceOpen ? '−' : '+'}</Button>
      <Input ref={findInput} aria-label="Find text" placeholder="Find in document" value={query} onChange={event => { setQuery(event.target.value); setAnchor(0); }} spellCheck={false} />
      <span className="find-count" role="status" aria-live="polite">{query ? matches.length ? `${active + 1} of ${matches.length}` : 'No matches' : 'Type to find'}</span>
      <Button variant={matchCase ? 'secondary' : 'ghost'} size="sm" aria-label="Match case" aria-pressed={matchCase} onClick={() => { setMatchCase(!matchCase); setAnchor(0); }}>Aa</Button>
      <Button variant="ghost" size="sm" aria-label="Previous match" disabled={!matches.length} onClick={() => navigate(-1)}>↑</Button>
      <Button variant="ghost" size="sm" aria-label="Next match" disabled={!matches.length} onClick={() => navigate(1)}>↓</Button>
      <Button variant="ghost" size="sm" aria-label="Close find" onClick={close}><Icon name="close" size={14} /></Button>
    </div>
    {replaceOpen && <div className="find-row replace-row">
      <Input aria-label="Replace with" placeholder="Replace with" value={replacement} onChange={event => setReplacement(event.target.value)} spellCheck={false} />
      <Button variant="secondary" size="sm" disabled={!matches.length} onClick={() => replace(false)}>Replace</Button>
      <Button variant="secondary" size="sm" disabled={!matches.length} onClick={() => replace(true)}>Replace all</Button>
    </div>}
  </div>;

  return { bar, openFind, navigate, sourceMatches: mode === 'source' ? matches : [], activeMatch: active };
}
