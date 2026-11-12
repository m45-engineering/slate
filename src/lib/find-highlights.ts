import { Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Match } from './find';

export const findHighlightsKey = new PluginKey<DecorationSet>('findHighlights');

export const FindHighlights = Extension.create({
  name: 'findHighlights',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findHighlightsKey,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, previous) {
          const search = transaction.getMeta(findHighlightsKey) as { matches: Match[]; active: number } | undefined;
          if (!search) return previous.map(transaction.mapping, transaction.doc);
          return DecorationSet.create(transaction.doc, search.matches.map((match, index) => Decoration.inline(match.from, match.to, {
            class: `find-match${index === search.active ? ' find-match-active' : ''}`,
          })));
        },
      },
      props: { decorations: state => findHighlightsKey.getState(state) },
    })];
  },
});
