'use client';

import { useEffect, useId, useRef, useState } from 'react';
import CodeBlock from '@tiptap/extension-code-block';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Input } from './ui/input';
import { ControlStructurePreview } from './control-structure-preview';
import { DiagramViewer } from './diagram-viewer';
import { codeHighlightPlugin } from '@/lib/code-highlights';

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const isControl = ['control-structure', 'm45-control-structure'].includes(node.attrs.language);
  const isMermaid = node.attrs.language === 'mermaid';
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [renderedSource, setRenderedSource] = useState<string | null>(null);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const renderSequence = useRef(0);

  useEffect(() => {
    if (!isMermaid) return;
    let canceled = false;
    const timer = setTimeout(async () => {
      try {
        const { renderDiagram } = await import('@/lib/render-diagram');
        const rendered = await renderDiagram(node.textContent, `diagram${id}-${++renderSequence.current}`, getComputedStyle(editor.view.dom).fontFamily);
        if (!canceled) { setSvg(rendered); setError(''); setRenderedSource(node.textContent); }
      } catch {
        if (!canceled) { setError('The Mermaid source is incomplete or invalid.'); setRenderedSource(node.textContent); }
      }
    }, 300);
    return () => { canceled = true; clearTimeout(timer); };
  }, [editor, id, isMermaid, node.textContent]);

  return <NodeViewWrapper className={`code-block ${isMermaid ? 'mermaid-block' : isControl ? 'control-block' : ''}`} data-mermaid-status={isMermaid ? renderedSource === node.textContent ? error ? 'error' : 'ready' : 'pending' : undefined}>
    <div className="code-header" contentEditable={false}>
      {isMermaid || isControl ? <span className="code-label">{isControl ? 'Control structure' : 'Mermaid diagram'}</span> : <Input
        aria-label="Code language" placeholder="plain text" value={node.attrs.language || ''}
        onChange={event => updateAttributes({ language: event.target.value.trim() })}
        spellCheck={false} disabled={!editor.isEditable}
      />}
      {(isMermaid || isControl) && editor.isEditable && <span>Edit in Markdown view</span>}
      {!isMermaid && !isControl && <span>Code</span>}
    </div>
    <pre className={isMermaid || isControl ? 'code-hidden' : ''}><NodeViewContent<'code'> as="code" spellCheck={false} /></pre>
    {isControl && <div className="diagram-preview" contentEditable={false}><ControlStructurePreview source={node.textContent} readOnly={!editor.isEditable} /></div>}
    {isMermaid && <div className="diagram-preview" contentEditable={false}>
      {svg ? editor.isEditable ? <DiagramViewer svg={svg} /> : <div role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : !error && <p className="diagram-loading">Drawing your diagram…</p>}
      {error && <p className="diagram-error" role="status">{error} Edit the source in Markdown view to update the preview.</p>}
    </div>}
  </NodeViewWrapper>;
}

export const SlateCodeBlock = CodeBlock.extend({
  addProseMirrorPlugins() { return [...(this.parent?.() || []), codeHighlightPlugin()]; },
  // A longer fence preserves code containing triple backticks (including Markdown examples).
  renderMarkdown(node, helpers) {
    const text = node.content ? helpers.renderChildren(node.content) : '';
    const runs = text.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `${fence}${node.attrs?.language || ''}\n${text}\n${fence}`;
  },
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView, { contentDOMElementTag: 'code' }); },
}).configure({ enableTabIndentation: true, tabSize: 2 });
