const diagramTheme = { theme: 'base', look: 'classic' } as const;

export async function renderDiagram(source: string, id: string, fontFamily: string, appearance: 'default' | 'block' = 'default') {
  const block = appearance === 'block';
  const { default: mermaid } = await import('mermaid');
  await document.fonts.ready;
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    ...diagramTheme, fontFamily,
    htmlLabels: true,
    // These diagram types have theme defaults independent of Mermaid's global theme.
    flowchart: { ...diagramTheme, curve: block ? 'step' : 'rounded', diagramPadding: 16, padding: 24, nodeSpacing: 40, rankSpacing: block ? 64 : 48 },
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
      .control-node-label { display: block; text-align: left; }
      .control-node-role { display: inline-block; border: 1px solid currentColor; border-radius: 2px; padding: 2px 6px; font-family: monospace; font-size: 11px; font-weight: 400; letter-spacing: 0.08em; line-height: 1.2; opacity: 0.7; }
      .control-node-name { display: block; margin-top: 8px; font-size: 15px; font-weight: 600; line-height: 1.35; }
      .control-node-info { font-size: 11px; }
      .node .label, .edgeLabel, text.actor { font-weight: 550; }
      .text-inner-tspan[font-weight="normal"] { font-weight: inherit; }
      .node rect, .node polygon, .node circle, .node path { filter: none; }
      .flowchart-link { stroke-width: 1px; }
      .edgeLabel .labelBkg { background: #fff; border: 1px solid #dedede; border-radius: 999px; padding: 3px 12px; }
      .edgeLabel rect { rx: 14px; ry: 14px; opacity: 1; stroke: #dedede !important; stroke-width: 1px; }
      marker[id$="-pointEnd"] path, marker[id$="-pointStart"] path { fill: none !important; stroke: #909090 !important; stroke-width: 1.2px !important; }
      ${block ? `
      .node rect { rx: 0; ry: 0; }
      .control-node-label { min-width: 152px; text-align: center; }
      .control-node-role { border: 0; padding: 0; font-size: 10px; }
      .control-node-name { margin-top: 6px; }
      .flowchart-link { stroke-width: 1.5px; }
      .edgeLabel .labelBkg { border: 0; border-radius: 0; padding: 2px 4px; }
      .edgeLabel rect { rx: 0; ry: 0; stroke: none !important; }
      marker[id$="-pointEnd"] path, marker[id$="-pointStart"] path { fill: #555 !important; stroke: #555 !important; }
      ` : ''}
    `,
  });
  // Mermaid removes existing DOM elements with the render ID. Keep the visible SVG intact.
  const result = await mermaid.render(id, source);
  const diagram = new DOMParser().parseFromString(result.svg, 'text/html');
  const svg = diagram.querySelector('svg');
  if (!svg) throw new Error('The diagram renderer did not return an SVG.');
  if (block) {
    // ELK rounds its orthogonal routes regardless of flowchart.curve. Its quadratic
    // control point is the original corner; restore that corner without moving the route.
    for (const path of diagram.querySelectorAll('path.flowchart-link')) {
      path.setAttribute('d', path.getAttribute('d')!.replace(/Q([-\d.e+,]+)\s+([-\d.e+,]+)/g, 'L$1L$2'));
    }
  }
  // Keep arrowhead geometry self-contained in both editor and print SVGs.
  for (const path of diagram.querySelectorAll('marker[id$="-pointEnd"] path')) path.setAttribute('d', `M 1 1 L 9 5 L 1 9${block ? ' Z' : ''}`);
  for (const path of diagram.querySelectorAll('marker[id$="-pointStart"] path')) path.setAttribute('d', `M 9 1 L 1 5 L 9 9${block ? ' Z' : ''}`);
  for (const label of diagram.querySelectorAll('g.edgeLabel rect.background')) {
    label.setAttribute('x', String(Number(label.getAttribute('x')) - 10));
    label.setAttribute('width', String(Number(label.getAttribute('width')) + 20));
  }
  return new XMLSerializer().serializeToString(svg);
}
