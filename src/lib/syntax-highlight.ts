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

// Highlighting is a display layer only. The textarea remains the source of truth.
export function highlightSource(source: string, filename: string): string | null {
  const language = syntaxLanguage(filename);
  if (!language || source.length > MAX_HIGHLIGHT_CHARACTERS) return null;
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
