export { isMarkdown, isTextFile, fileLabel } from '../../electron/file-types.cjs';

export type SlateDocument = { id: string; path: string | null; name: string; content: string; unsaved?: boolean };
export type WorkspaceDocuments = { documents: SlateDocument[]; activeId: string; replaceId?: string };
export type FileResult = { document?: SlateDocument; openedExternally?: boolean; canceled?: boolean; conflict?: boolean; error?: string };
export type LocalFolder = { path: string; name: string };
export type FolderEntry = { path: string; name: string; kind: 'directory' | 'file' | 'link'; editable: boolean };
export type FolderListing = { entries?: FolderEntry[]; truncated?: boolean; error?: string };
export type FolderSearch = { entries?: (FolderEntry & { match?: { line: number; preview: string; start: number; length: number } })[]; total?: number; skippedFiles?: number; usedGitIgnore?: boolean; unreadableFolders?: number; error?: string };
export type GitRevision = { hash: string; date: string; author: string; subject: string };
export type GitFileChange = { path: string; status: string; previous: string | null };
export type GitChangesMode = 'local' | 'branch';
export type GitChangesSnapshot = {
  root: string; folder: string; mode: GitChangesMode; branch: string | null; head: string | null;
  base: string | null; mergeBase: string | null; commits: number; files: GitFileChange[];
};
export type GitChangePreview = { before: string; after: string; beforeExists: boolean; afterExists: boolean };
export type GitSnapshot = {
  root: string; branch: string | null; head: string | null; relative: string; history: GitRevision[];
  baseline: { content: string; exists: boolean; revision: string | null };
  base: string | null; ahead: number | null; behind: number | null;
};

export interface DesktopBridge {
  platform: string;
  workspaceId: string;
  ready(): Promise<WorkspaceDocuments>;
  open(): Promise<FileResult>;
  openLink(href: string, id: string): Promise<FileResult & { fragment?: string }>;
  openDefault(id: string): Promise<{ openedExternally?: boolean; error?: string }>;
  revealDocument(id: string): Promise<{ canceled?: boolean; error?: string }>;
  newDocument(draft?: { name: string; content: string }): Promise<FileResult>;
  save(content: string, saveAs: boolean, options?: { id?: string; path: string | null; confirmationId?: number }): Promise<FileResult>;
  exportPdf(content: string, id: string): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  gitDocument(id: string, revision?: string | null): Promise<{ snapshot?: GitSnapshot; error?: string }>;
  copyText(text: string): Promise<void>;
  copyImage(png: Uint8Array): Promise<void>;
  activateTab(id: string): Promise<void>;
  closeTab(id: string): Promise<{ canceled?: boolean }>;
  closeTabs(ids: string[], keepId?: string): Promise<{ canceled?: boolean } | void>;
  reorderTabs(ids: string[]): Promise<void>;
  reload(): Promise<FileResult>;
  setDirty(id: string, dirty: boolean): void;
  onDocument(callback: (documents: WorkspaceDocuments) => void): () => void;
  onCommand(callback: (command: string) => void): () => void;
  onDiskChange(callback: (change: { id: string; changed: boolean }) => void): () => void;
  onConfirmChanges(callback: (request: { id: number }) => void): () => void;
  confirmChanges(id: number, accepted: boolean): Promise<void>;
  onError(callback: (message: string) => void): () => void;
  folderReady(): Promise<LocalFolder | null>;
  gitChanges(mode?: GitChangesMode): Promise<{ snapshot?: GitChangesSnapshot; error?: string }>;
  gitChange(mode: GitChangesMode, path: string, expected: { head: string | null; base: string | null }): Promise<{ preview?: GitChangePreview; error?: string }>;
  openFolder(): Promise<{ folder?: LocalFolder; canceled?: boolean; error?: string }>;
  listFolder(relativePath: string): Promise<FolderListing>;
  searchContents(query: string, matchCase: boolean): Promise<FolderSearch>;
  cancelContentSearch(): Promise<void>;
  searchFolder(query: string, refresh: boolean): Promise<FolderSearch>;
  openFile(relativePath: string): Promise<FileResult>;
  revealEntry(relativePath: string): Promise<{ canceled?: boolean; error?: string }>;
  createEntry(parent: string, name: string, kind: 'file' | 'directory', content?: string): Promise<{ changed?: boolean; path?: string; error?: string; canceled?: boolean }>;
  renameEntry(path: string, name: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  moveEntry(path: string, destination?: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  moveFiles(paths: string[], destination?: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string; paths?: string[] }>;
  importFiles(files: File[], destination: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  trashEntry(path: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  onFolder(callback: (folder: LocalFolder) => void): () => void;
}

declare global { interface Window {
  slate?: DesktopBridge;
  slatePdf?: { document(): Promise<{ name: string; content: string }>; ready(error?: string): void };
} }

export const EMPTY_DOCUMENT: SlateDocument = { id: 'initial', path: null, name: 'Untitled.md', content: '' };

export function revealLabel(platform?: string): string {
  return platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Reveal in File Explorer' : 'Reveal in File Manager';
}

// Keep constructs outside this version's visual editing vocabulary in source mode.
// In particular, HTML comments and front matter must never silently disappear.
export function sourceOnlyReason(markdown: string): string | null {
  if (/^(?:\ufeff)?---\s*\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/.test(markdown)) return 'YAML front matter';
  if (/^(?:\ufeff)?\+\+\+\s*\n/.test(markdown)) return 'TOML front matter';
  let fence: { char: string; length: number } | null = null;
  // Fenced and inline code are literal: shell variables and example markup are not math or HTML.
  const prose = markdown.split('\n').filter(line => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  }).join('\n').replace(/(?<![\\`])(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, span => span.replace(/[^\n]/g, ' '));
  // A tag name must end before attributes or the closing bracket. Angle-wrapped
  // Markdown destinations and autolinks (<https://…>, <name@example.com>) aren't tags.
  if (/<!--|<\/?[a-z][a-z0-9-]*(?=[\s/>])[^>]*>/i.test(prose)) return 'HTML';
  if (/!\[[^\]]*\]/.test(prose)) return 'images';
  if (/^\s{0,3}\[[^\]]+\]:/m.test(prose)) return 'reference definitions or footnotes';
  return null;
}
