'use client';

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { documentExtensions } from '@/lib/editor-extensions';
import { sourceOnlyReason } from '@/lib/document';

export function PdfDocument() {
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState('');
  const output = useRef<HTMLDivElement>(null);
  const editor = useEditor({
    immediatelyRender: false, editable: false, extensions: documentExtensions(),
    editorProps: { attributes: { class: 'document-editor' } },
  });

  useEffect(() => {
    if (!editor || !window.slatePdf) return;
    let canceled = false;
    void window.slatePdf.document().then(document => {
      if (canceled) return;
      const reason = sourceOnlyReason(document.content);
      if (reason) throw new Error(`PDF export cannot yet render ${reason}.`);
      setTitle(document.name.replace(/\.(md|markdown)$/i, ''));
      editor.commands.setContent(document.content, { contentType: 'markdown', emitUpdate: false });
      setLoaded(true);
    }).catch(error => {
      if (!canceled) window.slatePdf?.ready(error instanceof Error ? error.message : 'Could not render the document.');
    });
    return () => { canceled = true; };
  }, [editor]);

  useEffect(() => {
    if (!editor || !loaded) return;
    let canceled = false;
    let finishing = false;
    let expectedDiagrams = 0;
    editor.state.doc.descendants(node => {
      if (node.type.name === 'codeBlock' && node.attrs.language === 'mermaid') expectedDiagrams++;
    });
    const check = async () => {
      if (canceled || finishing) return;
      if (editor.view.dom.querySelector('.inline-math-error, .block-math-error')) {
        finishing = true;
        window.slatePdf?.ready('A formula is invalid. Fix its LaTeX before exporting.');
        return;
      }
      const diagrams = [...editor.view.dom.querySelectorAll<HTMLElement>('.mermaid-block')];
      if (diagrams.some(element => element.dataset.mermaidStatus === 'error')) {
        finishing = true;
        window.slatePdf?.ready('A Mermaid diagram is invalid. Fix its source before exporting.');
        return;
      }
      if (diagrams.length !== expectedDiagrams || diagrams.some(element => element.dataset.mermaidStatus !== 'ready')) return;
      finishing = true;
      // Paginate a static copy so print-only grouping never changes the editor's document.
      const printable = editor.view.dom.cloneNode(true) as HTMLElement;
      // Hidden source SVGs remain mounted; duplicate marker IDs would hide the printed arrowheads.
      for (const marker of printable.querySelectorAll<SVGMarkerElement>('marker[id]')) {
        const originalId = marker.id;
        marker.id = `pdf-${originalId}`;
        for (const edge of printable.querySelectorAll('[marker-start], [marker-mid], [marker-end]')) {
          for (const attribute of ['marker-start', 'marker-mid', 'marker-end']) {
            if (edge.getAttribute(attribute) === `url(#${originalId})`) edge.setAttribute(attribute, `url(#${marker.id})`);
          }
        }
      }
      for (const table of printable.querySelectorAll('table')) {
        const header = table.rows[0];
        if (header && [...header.cells].every(cell => cell.tagName === 'TH')) table.createTHead().append(header);
      }
      const oversized: { section: HTMLElement; name: string; width: number }[] = [];
      const mmPerPixel = 25.4 / 96;
      for (const diagram of printable.querySelectorAll('.mermaid-block')) {
        let block = diagram;
        while (block.parentElement && block.parentElement !== printable) block = block.parentElement;
        const headings: Element[] = [];
        let heading = block.previousElementSibling;
        while (heading?.matches('h1, h2, h3, h4, h5, h6')) {
          headings.unshift(heading);
          heading = heading.previousElementSibling;
        }
        const section = document.createElement('section');
        section.className = 'pdf-figure';
        block.before(section);
        section.append(...headings);
        section.append(block);
        const svg = diagram.querySelector('svg');
        const box = svg?.viewBox.baseVal;
        if (svg && box?.width && box.height) {
          const width = box.width * mmPerPixel;
          const height = box.height * mmPerPixel;
          const portraitScale = Math.min(1, 174 / width, 235 / height);
          const landscapeScale = Math.min(1, 261 / width, 160 / height);
          let scale = portraitScale;
          // Keep small diagrams on A4, but never shrink a large diagram into illegible text.
          if (Math.max(portraitScale, landscapeScale) < 0.8) {
            const name = `diagram-large-${oversized.length}`;
            const pageWidth = Math.max(210, Math.ceil(width + 36));
            section.style.page = name;
            section.style.width = `${pageWidth - 36}mm`;
            oversized.push({ section, name, width: pageWidth });
            scale = 1;
          } else if (landscapeScale > portraitScale * 1.15) {
            section.classList.add('pdf-landscape');
            scale = landscapeScale;
          }
          svg.style.width = `${width * scale}mm`;
          svg.style.height = `${height * scale}mm`;
          svg.style.maxWidth = 'none';
          svg.style.maxHeight = 'none';
        }
      }
      output.current?.replaceChildren(printable);
      await document.fonts.ready;
      if (oversized.length) {
        const styles = document.createElement('style');
        styles.textContent = oversized.map(({ section, name, width }) => {
          // Measure the final heading, diagram, and margins at the page's actual content width.
          const height = Math.max(297, Math.ceil(section.getBoundingClientRect().height * mmPerPixel + 37));
          return `@page ${name} { size: ${width}mm ${height}mm; margin: 18mm; }`;
        }).join('\n');
        output.current?.append(styles);
      }
      // Let React and the browser finish laying out the final SVGs before printing.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!canceled) { document.title = title; window.slatePdf?.ready(); }
      }));
    };
    const observer = new MutationObserver(() => void check());
    observer.observe(editor.view.dom, { childList: true, subtree: true, attributes: true });
    void check();
    return () => { canceled = true; observer.disconnect(); };
  }, [editor, loaded, title]);

  return <main className="pdf-document"><div className="pdf-render-source"><EditorContent editor={editor} /></div><div className="pdf-output" ref={output} /></main>;
}
