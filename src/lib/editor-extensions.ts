import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import { Markdown } from '@tiptap/markdown';
import { SlateCodeBlock } from '@/components/code-block';
import { SlateTaskItem } from '@/components/task-item';

export function documentExtensions() {
  return [
    StarterKit.configure({ codeBlock: false, underline: false, link: { openOnClick: true, autolink: false } }),
    SlateCodeBlock, TableKit.configure({ table: { resizable: false } }),
    TaskList, SlateTaskItem, Markdown,
  ];
}
