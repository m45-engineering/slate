# Changelog

## 0.1.3 - Unreleased

- Use rounded, shadow-free Mermaid diagrams with a neutral palette, lighter connectors, and pill-shaped edge labels in the editor and PDF exports.
- Preserve Mermaid arrowheads in PDF exports by giving the printed copy its own marker IDs.
- Copy files from Finder or another file manager into sidebar folders or the workspace root. Preserve the originals and refuse existing destination names.
- Keep the file tree's scroll position and expanded folders when refreshing after file drops.
- Open Slate centered at 90% of the current display's available width and height.

## 0.1.2 - 2026-11-12

- Add find and replace in Visual, Markdown, and source views, with highlighted matches, next/previous navigation, match-case, Replace All, and undo.
- Make Mermaid diagrams preview-only in Visual view; edit their source in Markdown view.
- Strengthen source-code highlighting colors and remove the extra source-toolbar tagline.
- Keep file search and workspace controls visible while scrolling the sidebar.

## 0.1.1 - 2026-11-12

- Add local PDF export for Markdown, including Mermaid diagrams, tables, task lists, page numbers, and clickable web links. Wide diagrams can use landscape pages, and table headers repeat across pages.
- Export unsaved edits without changing the Markdown file or its current editor view. Invalid diagrams and unsupported Markdown constructs stop export with an explanation.
- Open web links in the default browser and distinguish them with blue, underlined text.
- Make heading levels more distinct through size, weight, and spacing. Widen Visual view and use 15px body text.
- Remove the conflicting Visual/Markdown keyboard shortcut; the tabs and View menu remain available.
- Keep shell variables and other inline code from being mistaken for math or unsupported Markdown.
- Render inline and display LaTeX formulas locally, with insertion and editing controls and PDF export support.
- Retry temporary Windows file locks during Save while preserving external-change checks and unsaved edits.

PDF export supports the same Markdown subset as Visual view. Images, embedded HTML, front matter, reference definitions, and footnotes are not yet supported. The macOS installer is ad-hoc signed without notarization; the Windows installer is unsigned.
