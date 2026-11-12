import type { Node } from '@tiptap/pm/model';

export type Match = { from: number; to: number };

export function findText(text: string, query: string, matchCase = false): Match[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
  return Array.from(text.matchAll(pattern), match => ({ from: match.index, to: match.index + match[0].length }));
}

// Adjacent text nodes can have different formatting. Atoms and block boundaries
// are not text, so a match must never consume a formula, break, or table boundary.
export function findInDocument(doc: Node, query: string, matchCase = false): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    if (node.type.name === 'codeBlock' && node.attrs.language === 'mermaid') return false;
    let text = '';
    let start = pos + 1;
    const flush = () => {
      for (const match of findText(text, query, matchCase)) matches.push({ from: start + match.from, to: start + match.to });
      text = '';
    };
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) start = pos + 1 + offset;
        text += child.text;
      } else flush();
    });
    flush();
    return false;
  });
  return matches;
}
