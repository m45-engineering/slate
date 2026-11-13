'use client';

import { useEffect, useId, useRef, useState } from 'react';
import CodeBlock from '@tiptap/extension-code-block';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Input } from './ui/input';
import { DiagramViewer } from './diagram-viewer';

const diagramTheme = { theme: 'base', look: 'classic' } as const;

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
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
        const { default: mermaid } = await import('mermaid');
        await document.fonts.ready;
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          ...diagramTheme, fontFamily: getComputedStyle(editor.view.dom).fontFamily,
          htmlLabels: true,
          // These diagram types have theme defaults independent of Mermaid's global theme.
          flowchart: { ...diagramTheme, curve: 'rounded', diagramPadding: 16, padding: 24, nodeSpacing: 40, rankSpacing: 48 },
          agentflow: diagramTheme, swimlane: diagramTheme, sequence: diagramTheme,
          class: diagramTheme, state: diagramTheme, er: diagramTheme, requirement: diagramTheme,
          usecase: diagramTheme, venn: diagramTheme,
          themeVariables: {
            primaryColor: '#f4f4f4', primaryTextColor: '#444444', primaryBorderColor: '#dedede',
            secondaryColor: '#f4f4f4', secondaryTextColor: '#444444', secondaryBorderColor: '#dedede',
            tertiaryColor: '#fafafa', tertiaryTextColor: '#444444', tertiaryBorderColor: '#dedede',
            lineColor: '#909090', textColor: '#444444', edgeLabelBackground: '#ffffff', fontSize: '14px',
          },
          // Embed the styles in the SVG so previews and exported PDFs share the same appearance.
          themeCSS: `
            .node rect, rect.actor { rx: 16px; ry: 16px; }
            .node .label, .edgeLabel, text.actor { font-weight: 550; }
            .text-inner-tspan[font-weight="normal"] { font-weight: inherit; }
            .node rect, .node polygon, .node circle, .node path { filter: none; }
            .flowchart-link { stroke-width: 1px; }
            .edgeLabel .labelBkg { background: #fff; border: 1px solid #dedede; border-radius: 999px; padding: 3px 12px; }
            .edgeLabel rect { rx: 14px; ry: 14px; opacity: 1; stroke: #dedede !important; stroke-width: 1px; }
            marker[id$="-pointEnd"] path, marker[id$="-pointStart"] path { fill: none !important; stroke: #909090 !important; stroke-width: 1.2px !important; }
          `,
        });
        // Mermaid removes existing DOM elements with the render ID. Keep the visible SVG intact.
        const result = await mermaid.render(`diagram${id}-${++renderSequence.current}`, node.textContent);
        const diagram = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
        // Keep arrowhead geometry self-contained in both editor and print SVGs.
        for (const path of diagram.querySelectorAll('marker[id$="-pointEnd"] path')) path.setAttribute('d', 'M 1 1 L 9 5 L 1 9');
        for (const path of diagram.querySelectorAll('marker[id$="-pointStart"] path')) path.setAttribute('d', 'M 9 1 L 1 5 L 9 9');
        for (const label of diagram.querySelectorAll('g.edgeLabel rect.background')) {
          label.setAttribute('x', String(Number(label.getAttribute('x')) - 10));
          label.setAttribute('width', String(Number(label.getAttribute('width')) + 20));
        }
        if (!canceled) { setSvg(new XMLSerializer().serializeToString(diagram.documentElement)); setError(''); setRenderedSource(node.textContent); }
      } catch {
        if (!canceled) { setError('The Mermaid source is incomplete or invalid.'); setRenderedSource(node.textContent); }
      }
    }, 300);
    return () => { canceled = true; clearTimeout(timer); };
  }, [editor, id, isMermaid, node.textContent]);

  return <NodeViewWrapper className={`code-block ${isMermaid ? 'mermaid-block' : ''}`} data-mermaid-status={isMermaid ? renderedSource === node.textContent ? error ? 'error' : 'ready' : 'pending' : undefined}>
    <div className="code-header" contentEditable={false}>
      {isMermaid ? <span className="code-label">Mermaid diagram</span> : <Input
        aria-label="Code language" placeholder="plain text" value={node.attrs.language || ''}
        onChange={event => updateAttributes({ language: event.target.value.trim() })}
        spellCheck={false} disabled={!editor.isEditable}
      />}
      {isMermaid && editor.isEditable && <span>Edit in Markdown view</span>}
      {!isMermaid && <span>Code</span>}
    </div>
    <pre className={isMermaid ? 'code-hidden' : ''}><NodeViewContent<'code'> as="code" spellCheck={false} /></pre>
    {isMermaid && <div className="diagram-preview" contentEditable={false}>
      {svg ? editor.isEditable ? <DiagramViewer svg={svg} /> : <div role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : !error && <p className="diagram-loading">Drawing your diagram…</p>}
      {error && <p className="diagram-error" role="status">{error} Edit the source in Markdown view to update the preview.</p>}
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
