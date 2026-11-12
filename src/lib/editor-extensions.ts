import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import { Markdown } from '@tiptap/markdown';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { SlateCodeBlock } from '@/components/code-block';
import { SlateTaskItem } from '@/components/task-item';

export type FormulaSelection = { kind: 'inline' | 'block'; latex: string; pos?: number };

const InlineFormula = InlineMath.extend({
  markdownTokenizer: {
    name: 'inlineMath', level: 'inline', start: source => source.indexOf('$'),
    tokenize: source => {
      const match = source.match(/^\$((?:\\[^\n]|[^$\\`\n])+?)\$(?![$\d])/);
      if (!match || /^\s|\s$/.test(match[1])) return undefined;
      return { type: 'inlineMath', raw: match[0], latex: match[1] };
    },
  },
});

const BlockFormula = BlockMath.extend({
  markdownTokenizer: {
    name: 'blockMath', level: 'block', start: source => source.match(/^\$\$/m)?.index ?? -1,
    tokenize: source => {
      const match = source.match(/^\$\$([\s\S]+?)\$\$(?=[ \t]*(?:\n|$))/);
      if (!match || !match[1].trim()) return undefined;
      return { type: 'blockMath', raw: match[0], latex: match[1].trim() };
    },
  },
});

export function documentExtensions(onEditFormula?: (formula: FormulaSelection) => void) {
  const katexOptions = { throwOnError: true, trust: false };
  return [
    StarterKit.configure({ codeBlock: false, underline: false, link: { openOnClick: true, autolink: false } }),
    SlateCodeBlock, TableKit.configure({ table: { resizable: false } }),
    TaskList, SlateTaskItem,
    InlineFormula.configure({ katexOptions: { ...katexOptions, displayMode: false }, onClick: onEditFormula ? (node, pos) => onEditFormula({ kind: 'inline', latex: node.attrs.latex, pos }) : undefined }),
    BlockFormula.configure({ katexOptions: { ...katexOptions, displayMode: true }, onClick: onEditFormula ? (node, pos) => onEditFormula({ kind: 'block', latex: node.attrs.latex, pos }) : undefined }),
    Markdown,
  ];
}
