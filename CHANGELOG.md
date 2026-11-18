# Changelog

## 0.1.6 - 2026-11-18

- Preview link destinations in the footer. Open linked documents inside the current folder in Slate, and confirm the full URL before opening web links in the default browser.
- Follow heading links within a document or into another document, including repeated headings, Unicode titles, and targets open in Markdown view.
- Add independent windows through File → New Window (⌘⇧N / Ctrl+Shift+N), with separate folders, tabs, recovery drafts, and save prompts. Restore open workspaces on restart.
- Keep PDF exports isolated across windows and recheck unsaved edits made while another window's quit prompt is open.
- Select multiple files with ⌘/Ctrl-click or Shift-click, then drag them into a folder or use Move files. Check destination conflicts before moving and preserve open drafts at their new paths.
- Use slightly smaller 12px text for code files and open windows at 96% of the display's available width and height.

## 0.1.5 - 2026-11-15

- Expand Mermaid diagrams into a nearly full-window dialog with zoom, pan, and Fit. Resize the app to resize the canvas, and return to the same inline view without changing the document.
- Keep expanded diagrams below the native macOS title bar so the window buttons remain clear of the dialog.
- Put the expanded diagram's title, zoom controls, and Close button in one compact row to leave more room for the canvas.

## 0.1.4 - 2026-11-13

- Zoom Mermaid diagrams with the mouse wheel, drag to pan within the diagram canvas, and use Fit to restore the full view. Support zoom buttons and keyboard controls without changing the Markdown source.
- Preserve Mermaid label wrapping and layout in PDF exports. Give oversized diagrams one larger page, keep their headings together, and leave ordinary text on A4 pages.

## 0.1.3 - 2026-11-13

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
