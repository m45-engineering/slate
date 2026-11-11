'use client';

import TaskItem from '@tiptap/extension-task-item';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Checkbox } from './ui/checkbox';

function TaskItemView({ node, updateAttributes, editor }: NodeViewProps) {
  return <NodeViewWrapper className="task-item">
    <span contentEditable={false} className="task-checkbox"><Checkbox aria-label={`Complete task: ${node.textContent || 'Untitled task'}`} checked={Boolean(node.attrs.checked)} disabled={!editor.isEditable} onCheckedChange={checked => updateAttributes({ checked: checked === true })} /></span>
    <NodeViewContent className="task-content" />
  </NodeViewWrapper>;
}

export const SlateTaskItem = TaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskItemView, { as: 'li', attrs: ({ node }) => ({ 'data-type': 'taskItem', 'data-checked': String(Boolean(node.attrs.checked)) }) });
  },
}).configure({ nested: true });
