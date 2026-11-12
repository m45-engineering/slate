# Changelog

## 0.1.1 - 2026-11-12

- Add local PDF export for Markdown, including Mermaid diagrams, tables, task lists, page numbers, and clickable web links. Wide diagrams can use landscape pages, and table headers repeat across pages.
- Export unsaved edits without changing the Markdown file or its current editor view. Invalid diagrams and unsupported Markdown constructs stop export with an explanation.
- Open web links in the default browser and distinguish them with blue, underlined text.
- Make heading levels more distinct through size, weight, and spacing. Widen Visual view and use 15px body text.
- Remove the conflicting Visual/Markdown keyboard shortcut; the tabs and View menu remain available.

PDF export supports the same Markdown subset as Visual view. Images, embedded HTML, front matter, reference definitions, footnotes, and math are not yet supported. The macOS installer is ad-hoc signed without notarization; the Windows installer is unsigned.
