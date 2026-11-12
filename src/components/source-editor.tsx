'use client';

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Textarea } from './ui/textarea';
import type { highlightSource } from '@/lib/syntax-highlight';
import type { Match } from '@/lib/find';

export const SourceEditor = forwardRef<HTMLTextAreaElement, {
  value: string; filename: string; label: string; onChange(value: string): void; matches?: Match[]; activeMatch?: number;
}>(function SourceEditor({ value, filename, label, onChange, matches = [], activeMatch = -1 }, ref) {
  const [highlighter, setHighlighter] = useState<typeof highlightSource | null>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const searchMirror = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    let canceled = false;
    void import('@/lib/syntax-highlight').then(module => {
      if (!canceled) setHighlighter(() => module.highlightSource);
    }).catch(() => { /* Plain text editing remains available if the display layer cannot load. */ });
    return () => { canceled = true; };
  }, []);
  const html = useMemo(() => highlighter?.(value, filename) ?? null, [highlighter, value, filename]);
  const lines = value.split('\n');

  function syncScroll() {
    if (mirror.current && input.current) mirror.current.style.transform = `translate(${-input.current.scrollLeft}px, ${-input.current.scrollTop}px)`;
    if (searchMirror.current && input.current) searchMirror.current.style.transform = `translate(${-input.current.scrollLeft}px, ${-input.current.scrollTop}px)`;
  }

  useEffect(syncScroll, [html, matches, activeMatch]);

  return <div className="source-editor">
    <div className="line-numbers" aria-hidden="true">{lines.map((_, index) => <div key={index}>{index + 1}</div>)}</div>
    <div className="source-input" style={{ height: `${Math.max(20, lines.length + 3) * 26}px` }}>
      {matches.length > 0 && <div className="syntax-viewport" aria-hidden="true"><pre ref={searchMirror} className="search-highlights">{matches.map((match, index) => <span key={match.from}>{value.slice(index ? matches[index - 1].to : 0, match.from)}<mark className={`find-match${index === activeMatch ? ' find-match-active' : ''}`}>{value.slice(match.from, match.to)}</mark></span>)}{value.slice(matches[matches.length - 1].to)}</pre></div>}
      {html !== null && <div className="syntax-viewport" aria-hidden="true"><pre ref={mirror} className="syntax-highlight"><code dangerouslySetInnerHTML={{ __html: html }} /></pre></div>}
      <Textarea ref={element => {
        input.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
      }} aria-label={label} className={html !== null ? 'has-highlighting' : undefined} value={value} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={event => onChange(event.target.value)} onScroll={syncScroll} onKeyDown={event => {
        if (event.key === 'Tab') {
          event.preventDefault();
          const element = event.currentTarget;
          const { selectionStart: start, selectionEnd: end } = element;
          onChange(value.slice(0, start) + '  ' + value.slice(end));
          requestAnimationFrame(() => element.setSelectionRange(start + 2, start + 2));
        }
      }} />
    </div>
  </div>;
});
