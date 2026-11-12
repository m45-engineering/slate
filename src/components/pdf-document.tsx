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
      for (const table of printable.querySelectorAll('table')) {
        const header = table.rows[0];
        if (header && [...header.cells].every(cell => cell.tagName === 'TH')) table.createTHead().append(header);
      }
      for (const diagram of printable.querySelectorAll('.mermaid-block')) {
        let block = diagram;
        while (block.parentElement && block.parentElement !== printable) block = block.parentElement;
        const heading = block.previousElementSibling;
        const section = document.createElement('section');
        section.className = 'pdf-figure';
        block.before(section);
        if (heading?.matches('h1, h2, h3, h4, h5, h6')) section.append(heading);
        section.append(block);
        const box = diagram.querySelector('svg')?.viewBox.baseVal;
        // Wider-than-page diagrams get a landscape sheet only when it improves their scale.
        if (box && box.width > 174 * 96 / 25.4) {
          const portraitScale = Math.min(174 / box.width, 235 / box.height);
          const landscapeScale = Math.min(261 / box.width, 160 / box.height);
          if (landscapeScale > portraitScale * 1.15) {
            section.classList.add('pdf-landscape');
          }
        }
      }
      output.current?.replaceChildren(printable);
      await document.fonts.ready;
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
