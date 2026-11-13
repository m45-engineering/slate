# Slate

A quiet place to write. A local Markdown, text, and code editor for macOS and Windows, built with Electron, Next.js, and Tiptap.

Your document is a `.md` file. Slate adds a familiar editing surface; it does not add a database, an account, or a proprietary document format.

## Install Slate

The desktop installers are self-contained. You do **not** need Node.js, pnpm, or this repository to use them.

### macOS

1. Download `Slate-0.1.4-mac-arm64.dmg` from the [v0.1.4 release](https://github.com/m45-engineering/slate/releases/tag/v0.1.4). This build supports Apple Silicon Macs; an Intel build is not yet available.
2. Open the `.dmg` and drag **Slate** to **Applications**.
3. Launch **Slate** from Applications or press **⌘Space** and type **Slate**.

Quit Slate before installing an update. Your remembered workspace and recovery drafts are stored separately from the app and are preserved when replacing it.

The Apple Silicon installer is ad-hoc signed, without Apple notarization. If macOS blocks a build you trust, use **System Settings → Privacy & Security → Open Anyway** after trying to open it. A Developer ID signature and notarization are still pending.

### Windows

1. Download `Slate-0.1.4-win-x64.exe` from the [v0.1.4 release](https://github.com/m45-engineering/slate/releases/tag/v0.1.4) for a standard Intel/AMD PC.
2. Run the `.exe` and follow the installation wizard. Installation is per-user; you can choose the destination folder.
3. Open **Slate** from the Start menu.

Quit Slate before installing an update. The Windows build is not yet signed with a trusted certificate, so Windows may show a publisher warning. Run it only if you trust its source.

Download both installers from the [v0.1.4 release](https://github.com/m45-engineering/slate/releases/tag/v0.1.4). They contain the code from that release, not later changes on `main`. The [Build Slate workflow](https://github.com/m45-engineering/slate/actions/workflows/build.yml) builds and tests newer changes on Windows and macOS. To try a newer successful build, download its matching artifact (`slate-windows-latest` or `slate-macos-latest`) and extract the ZIP. Downloading workflow artifacts requires GitHub sign-in; while the repository is private, downloads also require repository access.

## Features

- Visual editing and raw Markdown, with a document outline.
- Find and replace in the current document, with highlighted matches, next/previous navigation, match-case, and Replace All. Use ⌘F / Ctrl+F to find; ⌥⌘F on macOS or Ctrl+H on Windows to replace. Enter / Shift+Enter steps through matches; Escape closes the bar. Visual replacements preserve surrounding formatting; Markdown and source mode search the exact file text.
- A resizable shadcn folder sidebar with lazy directory browsing, live filename search, current-file highlighting, and an Outline tab. Markdown opens in the visual editor; text and code open in the source editor. Binary files remain visible for context.
- Source editing with line numbers, Geist Mono, document zoom, and the same explicit Save and conflict protection. Supports TypeScript/JavaScript, Python, C/C++, SQL, JSON/JSONL, YAML, XML/XMI/ReqIF, HTML/SVG source, CSS, CSV, shell scripts, patches, plain text, and common extensionless files such as Dockerfile and Makefile.
- Create files and folders directly from the sidebar: use the icons beside the workspace name for the root, or right-click a folder for New File / New Folder. New files open in a tab; existing files are never replaced.
- Drag files or folders onto another folder in the sidebar to move them. Hovering expands a folder; drop onto the workspace heading to move back to the root. Open tabs keep their drafts and follow the move. Moves refuse existing destination names.
- Drop files from Finder or another file manager onto a sidebar folder or the workspace heading to copy them there. The originals stay in place; existing destination files are never replaced.
- Right-click files or folders in the sidebar (including search results) to rename, move, or delete them. Move uses the native folder picker within the open workspace; Delete confirms before sending the item to the system Trash. Open tabs follow renamed or moved files, including unsaved edits.
- Multiple document tabs with a blue dot for unsaved changes, individual close buttons, drag reordering, and a right-click menu for Close / Close Others / Close All. Switching tabs keeps each draft in memory.
- Reopens the last folder and saved-file tabs in their previous order on restart, reading each file's latest contents from disk.
- Opens centered at 90% of the current display's available width and height, leaving the menu bar and Dock or taskbar clear.
- A single compact toolbar, high-contrast monochrome controls, and a blank document at startup.
- A wider visual document area and document zoom from 75% to 200%, without scaling the application controls.
- Headings, bold, italic, strikethrough, links, lists, checkboxes, and quotes.
- Editable Markdown tables and fenced code blocks. Mermaid diagrams use a rounded, shadow-free neutral style. Scroll over a diagram to zoom, drag to move it, and choose **Fit** to reset the view. Add or edit their fenced source in Markdown view.
- Inline and display LaTeX formulas, rendered locally with KaTeX and preserved in Markdown and PDF exports.
- Local PDF export for Markdown, including Mermaid diagrams, tables, task lists, clickable web links, and page numbers.
- Native Open, Save, Save As, keyboard shortcuts, and `.md` / `.markdown` file associations.
- Explicit Save only: edits do not change the file on disk until Save or ⌘S / Ctrl+S. Save is active only while changes are pending; new documents need an initial Save to choose a filename. Closing a dirty tab, reloading, closing the window, or quitting offers Save / Discard / Cancel. Quitting and bulk close actions check each dirty tab separately; Cancel stops the remaining closes.
- Detection of changes made by other editors, with Reload and Save a copy actions.
- Bundled Geist Sans and Geist Mono; no font downloads or server at runtime.
- A local recovery draft for unsaved edits. This is a convenience, not a backup system.

## Run with pnpm

Development requires Node.js 24 and pnpm 10.33.0. People installing the packaged app do not need either.

```sh
git clone https://github.com/m45-engineering/slate.git
cd slate
pnpm install --frozen-lockfile
pnpm dev
```

Run these commands in a terminal such as Ghostty on macOS or PowerShell on Windows. `pnpm dev` launches the desktop app with live updates. The local UI server uses `127.0.0.1:3210`.

To open a repository during development, use `pnpm dev -- /absolute/path/to/repository`, or `pnpm dev -- C:\work\repository` on Windows. To restart development, quit Slate, stop the command with **Ctrl+C** if it is still running, and run `pnpm dev` again.

After the first session, `pnpm dev` resumes the last open folder, saved-file tabs, their order, and the active saved file. Passing the same folder also resumes its last file; explicitly passing another file or folder takes precedence. Missing paths are skipped with a notice. Slate stores only the remembered paths in `workspace.json` in its application settings directory, outside your repository. Unsaved new documents continue to use the separate draft-recovery flow.

To build and run the production desktop app from source:

```sh
pnpm build
pnpm start
```

After changing the code, quit Slate and repeat `pnpm build` followed by `pnpm start` to load the new version. Avoid running the installed app and the development app at the same time; they use the same workspace settings.

`pnpm dev:web` starts a browser preview. The preview opens files with the browser's file picker and downloads changes. Native saves and external-change detection are desktop features.

## Open from other tools

After installing Slate on macOS:

```sh
open -a Slate /absolute/path/to/document.md
open -a Slate /absolute/path/to/repository
```

On Windows, pass the file to the installed executable in PowerShell:

```powershell
& "C:\path\to\your\Slate\Slate.exe" "C:\work\document.md"
```

Replace the example executable path with your installation directory. These commands also work from the VS Code terminal or an agent's shell. Alternatively use **Open With → Slate** in Finder or Explorer. There is no editor extension to install.

For development, after `pnpm build`:

```sh
pnpm start -- /absolute/path/to/document.md
```

The application reuses its existing window. Opening another document adds a tab, or focuses its existing tab. Closing a tab, closing the window, or quitting offers Save / Discard / Cancel when there are unsaved changes. Open a folder from the Open menu or the sidebar. Expanding a folder reads its immediate children, so opening a repository does not scan every file. The tree refreshes when you return to Slate or click Refresh; `.git`, `node_modules`, `.next`, `.venv`, and `__pycache__` are hidden. Symbolic links are shown but cannot be opened from the tree. Opening a file directly shows its containing folder when no folder is already open.

| Action | macOS | Windows |
| --- | --- | --- |
| New | ⌘N | Ctrl+N |
| Open | ⌘O | Ctrl+O |
| Open folder | ⌘⇧O | Ctrl+Shift+O |
| Save | ⌘S | Ctrl+S |
| Save As | ⌘⇧S | Ctrl+Shift+S |
| Close tab | ⌘W | Ctrl+W |
| Find | ⌘F | Ctrl+F |
| Find and replace | ⌥⌘F | Ctrl+H |
| Next / previous match | ⌘G / ⌘⇧G | Ctrl+G / Ctrl+Shift+G |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Bold / italic | ⌘B / ⌘I | Ctrl+B / Ctrl+I |

## Build installers

```sh
pnpm package:mac   # run on macOS: DMG for the current architecture
pnpm package:win   # run on Windows: NSIS installer for the current architecture
```

First run `pnpm install --frozen-lockfile`. Each packaging command regenerates the icons, builds the UI, and bundles Electron with the runtime assets. Outputs are generated in `release/` and are not tracked. Build on the target operating system with a matching Node.js architecture. This first version has no cross-compilation setup.

[The build workflow](.github/workflows/build.yml) runs for pull requests and pushes to `main`, avoiding duplicate runs for PR branches. Each platform reuses a previous successful validation when every tracked file except `README.md` and `CHANGELOG.md` is unchanged. These documentation-only updates keep the existing checks successful without reinstalling dependencies, rerunning tests, or rebuilding installers. A missing or expired validation cache causes a full run. Maintainers can force fresh tests and installers with **Actions → Build Slate → Run workflow**. Full runs upload installers as build artifacts; they do not publish releases.

**Release status:** macOS packaging uses `identity: "-"`, `hardenedRuntime: false`, and `notarize: false` for a locally signed build without selecting a Keychain certificate. Build on the target architecture with its matching Electron installation. To avoid unverified-developer warnings, macOS builds need a Developer ID signature and notarization, and Windows builds need a trusted signing certificate. There is no automatic updater.

`pnpm icons` regenerates the app icon, startup mark, and installer background. `pnpm dev` and `pnpm start` use a cached, branded macOS launcher so development windows also appear as Slate. The original Electron dependency is left untouched.

## Text and code files

Open supported files from the sidebar, filename search, native file picker, or command line. Files must contain UTF-8 text, contain no NUL bytes, and be no larger than 10 MB. Binary formats such as PDF, PNG, and XLSX are not editable.

Text and code use a source editor with line numbers and locally bundled syntax highlighting. The high-contrast colors preserve the white background and Geist Mono typography. They are never converted through Markdown, formatted automatically, or executed. HTML, SVG, and MDX remain source text. Highlighting follows the filename for common programming, configuration, and markup languages. Plain text, unknown languages, and files over 200,000 characters use readable plain text to keep editing responsive. Code completion and language tooling are not included in this version. The shared supported-extension list is in [electron/file-types.cjs](electron/file-types.cjs).

## Markdown fidelity

Opening, switching views, and saving without edits preserve the original file bytes and modification time. Editing in raw Markdown saves that source. Visual edits serialize the document through Tiptap and can normalize Markdown formatting (for example, table spacing and emphasis markers). UTF-8 BOM and CRLF line endings are retained for existing files.

This version deliberately keeps YAML/TOML front matter, HTML, images, reference definitions, and footnotes in source mode. It does not claim lossless visual editing for every Markdown dialect. The source-mode guard covers these known unsupported forms; other custom Markdown extensions may also require source editing. Tiptap's Markdown extension is currently beta.

Mermaid uses strict rendering. Code is displayed, never executed. Web links are blue and open in the default browser when clicked. Remote images and embedded HTML are not rendered. File operations are restricted to the document selected through the OS or native file dialog.

### Formulas

Write inline LaTeX as `$E=mc^2$` and display LaTeX between `$$` delimiters on separate lines. Formulas render in Visual view and PDF exports. Use **Insert formula** in the formatting toolbar, or click a rendered formula to edit its LaTeX. KaTeX and its fonts are bundled locally; only its supported LaTeX commands are available. Invalid formulas show their source, and PDF export stops with an explanation until they are corrected. Shell variables inside code and ordinary dollar prices remain literal text.

### Export a PDF

Choose **Export PDF** in the toolbar or **File → Export PDF…**, then choose where to save it. Export uses the current document, including unsaved edits, without saving or changing the Markdown file. It works from either Visual or Markdown view.

PDFs are rendered entirely on your computer using Slate's bundled Chromium and fonts. They include A4 pages, page numbers, selectable text, clickable web links, and rendered Mermaid diagrams. Wide diagrams receive a landscape page when that improves readability; oversized diagrams get one larger page to keep their text readable. Diagram layout matches Visual view, independent of canvas zoom or position. Editor controls and source-editing fields are omitted. An invalid diagram stops export instead of silently producing a missing or outdated figure.

Export supports the same Markdown content as Visual view. The source-only constructs listed above are rejected explicitly so they cannot silently disappear. Custom headers, a generated table of contents, and Word export are not included.

Saving compares the file with the version Slate opened. If another tool changed or deleted it, Slate refuses to overwrite it. Writes use a temporary sibling file and rename; this reduces partial-write risk. This is not a distributed lock: a write by another process in the tiny interval between the final comparison and rename can still race. Use Git for version history and coordinated review.

Save checks for external changes and preserves unsaved text if a write fails. Choosing Save in the confirmation dialog continues only after the file is successfully saved; canceling Save As, a conflict, or a write error leaves the document open. Reload the external version, save a copy, or retry Save as appropriate.

Draft recovery still runs automatically in local application storage, separately from your files. After an interrupted session, recover each draft as a new unsaved tab. Recovery covers all dirty tabs, including inactive ones. Saving or explicitly discarding a draft removes only its own recovery copy. Recovery never writes edits into the original repository file.

## Validation

```sh
pnpm check       # TypeScript and file-preservation/conflict tests
pnpm build       # static production export
pnpm test:e2e    # launch Electron; requires a desktop session
```

[Desktop tests](tests/desktop.spec.ts) exercise the actual exported app, including native file loading, Markdown round trips, source editing and explicit saving, Save / Discard / Cancel, draft recovery, session restore, table editing, Mermaid rendering, PDF export, web links, and external changes. [File tests](tests/file-store.test.cjs) cover byte preservation, line endings, conflicts, and invalid files.

## License

Slate's original code is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

Use, modification, and redistribution are free for the license's permitted noncommercial purposes. The standard license also expressly permits use by charitable organizations, educational institutions, public research organizations, public safety or health organizations, environmental protection organizations, and government institutions. See the full terms for the precise scope.

Commercial use outside those permitted purposes requires a separate license from [M45 Engineering](https://m45.engineering/). No commercial license is granted by this repository.

This is source-available software with a noncommercial restriction, rather than an OSI-approved open-source license. The license applies to Slate's software; it does not place your documents under that license. Third-party components retain their own licenses. Redistributed copies must include the license terms (or their URL) and the [required notice](NOTICE).

## Repository access and contributions

Slate is maintained by [Florian Wolf (@florian-zeev)](https://github.com/florian-zeev) under [M45 Engineering](https://github.com/m45-engineering/slate). External pull requests are not accepted. Repository write access is reserved for the maintainer, subject to organization owners' administrative access.

GitHub is configured with **Pull requests → Collaborators only**, with `florian-zeev` as the only account with write/admin access and no repository teams or deploy keys. Making the repository public should retain that restriction. GitHub organization owners retain administrative authority over organization repositories, so review access again if the organization's ownership or base permissions change. A public repository can still be read and forked; these settings control changes to the official repository, not copies made by other people. See [GitHub's pull request settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/disabling-pull-requests).

Before making the repository public, review the repository history and distribution/signing setup. Private customer meeting notes and local build artifacts are not included in the source tree. This local licensing change does not alter previously published release assets.

## Implementation

The Next.js UI is exported into `out/` and loaded by Electron through a local `slate-app://` protocol. The installed application runs without a Next.js server. The sandboxed renderer accesses native file operations through a small preload bridge. Document content remains local.

- `src/components/slate-editor.tsx`: document UI and the two editor views.
- `src/components/code-block.tsx`: fenced code and Mermaid previews.
- `electron/main.cjs`: windows, menus, native dialogs, and file watching.
- `electron/file-store.cjs`: UTF-8 file I/O, conflict checks, and replacement writes.
- `electron/folder-store.cjs`: directory listings and access restricted to the selected folder.
- `src/components/folder-sidebar.tsx`: the shadcn folder navigator and Outline tab.

The monochrome design follows M45's white space, neutral palette, and Geist typography. The shadcn components in `src/components/ui/` use the standard Radix primitives. The sidebar's default bold shortcut was changed to preserve the editor's ⌘/Ctrl+B behavior.

All visible application controls use these shared components: buttons, text inputs, source textareas, mode tabs, menus, tooltips, task checkboxes, and confirmation dialogs. Native operating-system menus and file pickers handle application commands and file selection. The browser fallback uses one hidden file input to launch its system picker.

Keep M45 colors and typography in `src/app/globals.css`: near-black text, readable secondary text, white surfaces, restrained hover backgrounds, and explicit keyboard focus. Avoid native `title` tooltips, browser confirmation dialogs, decorative borders, and per-control gray overrides. Heading previews share the document's type-size tokens. The desktop tests check component usage, minimum 4.5:1 text contrast for enabled buttons, keyboard focus, and confirmation behavior.

Current scope is a focused local editor. Collaboration, Git operations, Word export, plugins, and cloud sync are not part of this version.
