'use client';

import { useEffect, useId, useState } from 'react';
import CodeBlock from '@tiptap/extension-code-block';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const isMermaid = node.attrs.language === 'mermaid';
  const [editing, setEditing] = useState(!node.textContent);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    if (!isMermaid) return;
    let canceled = false;
    const timer = setTimeout(async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          theme: 'base', fontFamily: 'Geist, sans-serif',
          themeVariables: { primaryColor: '#f7f7f7', primaryTextColor: '#181818', primaryBorderColor: '#d4d4d4', lineColor: '#858585', fontSize: '14px' },
        });
        const result = await mermaid.render(`diagram${id}`, node.textContent);
        if (!canceled) { setSvg(result.svg); setError(''); }
      } catch {
        if (!canceled) { setSvg(''); setError('This diagram needs a small correction. Edit the Mermaid source to continue.'); }
      }
    }, 300);
    return () => { canceled = true; clearTimeout(timer); };
  }, [id, isMermaid, node.textContent]);

  return <NodeViewWrapper className={`code-block ${isMermaid ? 'mermaid-block' : ''}`}>
    <div className="code-header" contentEditable={false}>
      {isMermaid ? <span className="code-label">Mermaid diagram</span> : <Input
        aria-label="Code language" placeholder="plain text" value={node.attrs.language || ''}
        onChange={event => updateAttributes({ language: event.target.value.trim() })}
        spellCheck={false} disabled={!editor.isEditable}
      />}
      {isMermaid && <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>{editing ? 'Hide source' : 'Edit diagram'}</Button>}
      {!isMermaid && <span>Code</span>}
    </div>
    <pre className={isMermaid ? 'code-hidden' : ''}><NodeViewContent<'code'> as="code" spellCheck={false} /></pre>
    {isMermaid && editing && <div contentEditable={false}><Textarea
      className="mermaid-source" aria-label="Mermaid source" autoFocus spellCheck={false}
      rows={Math.max(4, node.textContent.split('\n').length + 1)} value={node.textContent}
      onChange={event => {
        const position = getPos();
        const text = event.target.value;
        if (typeof position === 'number') editor.commands.command(({ tr }) => {
          tr.insertText(text, position + 1, position + node.nodeSize - 1);
          return true;
        });
      }}
    /></div>}
    {isMermaid && <div className="diagram-preview" contentEditable={false}>
      {error ? <p className="diagram-error" role="status">{error}</p> : svg ? <div role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="diagram-loading">Drawing your diagram…</p>}
    </div>}
  </NodeViewWrapper>;
}

export const SlateCodeBlock = CodeBlock.extend({
  // A longer fence preserves code containing triple backticks (including Markdown examples).
  renderMarkdown(node, helpers) {
    const text = node.content ? helpers.renderChildren(node.content) : '';
    const runs = text.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `${fence}${node.attrs?.language || ''}\n${text}\n${fence}`;
  },
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView, { contentDOMElementTag: 'code' }); },
}).configure({ enableTabIndentation: true, tabSize: 2 });
