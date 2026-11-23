import { parseAuthoringSource } from './control-structure/syntax.ts';
import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import latex from 'highlight.js/lib/languages/latex';
import asciidoc from 'highlight.js/lib/languages/asciidoc';
import { syntaxLanguage } from '../../electron/file-types.cjs';

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('protobuf', protobuf);
hljs.registerLanguage('latex', latex);
hljs.registerLanguage('asciidoc', asciidoc);

export const MAX_HIGHLIGHT_CHARACTERS = 200_000;

// Highlighting is a display layer only; it never changes the document text.
export function highlightCode(source: string, language: string): string | null {
  language = language.trim().toLowerCase();
  if (!language || !hljs.getLanguage(language) || source.length > MAX_HIGHLIGHT_CHARACTERS) return null;
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

export function highlightSource(source: string, filename: string): string | null {
  if (filename === 'M45 source' && source.length <= MAX_HIGHLIGHT_CHARACTERS) {
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const classes: Record<string, string> = { type: 'hljs-type', keyword: 'hljs-keyword', arrow: 'hljs-keyword', relationship: 'hljs-type', heading: 'hljs-section', comment: 'hljs-comment', label: 'hljs-string' };
    let end = 0, html = '';
    for (const token of parseAuthoringSource(source).tokens) {
      if (token.from < end) continue;
      html += escape(source.slice(end, token.from));
      const content = escape(source.slice(token.from, token.to));
      html += classes[token.kind] ? `<span class="${classes[token.kind]}">${content}</span>` : content;
      end = token.to;
    }
    return html + escape(source.slice(end));
  }
  const language = syntaxLanguage(filename);
  return language ? highlightCode(source, language) : null;
}
