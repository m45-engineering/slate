import { Extension } from '@tiptap/react';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffText } from './text-diff.ts';

export const gitHighlightsKey = new PluginKey<DecorationSet>('gitHighlights');
export const GitHighlights = Extension.create({
  name: 'gitHighlights',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: gitHighlightsKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, previous) => transaction.getMeta(gitHighlightsKey) ?? previous.map(transaction.mapping, transaction.doc),
      },
      props: { decorations: state => gitHighlightsKey.getState(state) },
    })];
  },
});

function visibleText(doc: Node) {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    if (node.type.name === 'codeBlock' && ['mermaid', 'control-structure', 'm45-control-structure'].includes(node.attrs.language)) return false;
    if (text) { text += '\n\n'; positions.push(position + 1, position + 1); }
    node.forEach((child, offset) => {
      if (child.isText) {
        text += child.text;
        for (let index = 0; index < child.nodeSize; index++) positions.push(position + 1 + offset + index);
      } else { text += '\uFFFC'; positions.push(position + 1 + offset); }
    });
    return false;
  });
  positions.push(Math.max(1, doc.content.size - 1));
  return { text, positions };
}

export function gitDecorations(before: Node, after: Node): DecorationSet {
  const previous = visibleText(before), current = visibleText(after);
  const decorations: Decoration[] = [];
  let offset = 0;
  for (const part of diffText(previous.text, current.text)) {
    if (part.kind === 'removed') {
      const removed = part.text.replaceAll('\uFFFC', '');
      if (removed) decorations.push(Decoration.widget(current.positions[offset] ?? after.content.size - 1, () => {
        const node = document.createElement('del');
        node.className = 'git-removed'; node.textContent = removed;
        node.setAttribute('aria-label', `Removed: ${removed}`);
        return node;
      }, { side: -1 }));
    } else {
      if (part.kind === 'added') {
        let from = -1, to = -1;
        const flush = () => { if (from >= 0) decorations.push(Decoration.inline(from, to, { class: 'git-added', nodeName: 'ins' })); from = -1; };
        for (let index = offset; index < offset + part.text.length; index++) {
          const pos = current.positions[index];
          // Structural separators are represented in the diff but aren't text positions.
          if (after.textBetween(pos, Math.min(pos + 1, after.content.size)) !== current.text[index]) { flush(); continue; }
          if (from < 0) { from = pos; to = pos + 1; }
          else if (pos === to) to++;
          else { flush(); from = pos; to = pos + 1; }
        }
        flush();
      }
      offset += part.text.length;
    }
  }
  return DecorationSet.create(after, decorations);
}
