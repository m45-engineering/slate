import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { highlightCode } from './syntax-highlight';

function codeHighlights(doc: ProseMirrorNode) {
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== 'codeBlock') return;
    const language = node.attrs.language || '';
    const html = language === 'mermaid' ? null : highlightCode(node.textContent, language);
    if (html === null) return false;

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    let offset = position + 1;
    function visit(element: ChildNode) {
      const start = offset;
      if (element.nodeType === 3) offset += element.textContent?.length || 0;
      else {
        element.childNodes.forEach(visit);
        if (element instanceof Element && element.className && offset > start) {
          decorations.push(Decoration.inline(start, offset, { class: element.className }));
        }
      }
    }
    parsed.body.childNodes.forEach(visit);
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function codeHighlightPlugin() {
  return new Plugin<DecorationSet>({
    state: {
      init: (_, state) => codeHighlights(state.doc),
      apply: (transaction, previous) => transaction.docChanged ? codeHighlights(transaction.doc) : previous,
    },
    props: { decorations(state) { return this.getState(state); } },
  });
}
