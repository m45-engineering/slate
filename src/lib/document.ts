export { isMarkdown, isTextFile, fileLabel } from '../../electron/file-types.cjs';

export type SlateDocument = { id: string; path: string | null; name: string; content: string; unsaved?: boolean };
export type WorkspaceDocuments = { documents: SlateDocument[]; activeId: string; replaceId?: string };
export type FileResult = { document?: SlateDocument; canceled?: boolean; conflict?: boolean; error?: string };
export type LocalFolder = { path: string; name: string };
export type FolderEntry = { path: string; name: string; kind: 'directory' | 'file' | 'link'; editable: boolean };
export type FolderListing = { entries?: FolderEntry[]; truncated?: boolean; error?: string };
export type FolderSearch = FolderListing & { total?: number };

export interface DesktopBridge {
  platform: string;
  ready(): Promise<WorkspaceDocuments>;
  open(): Promise<FileResult>;
  newDocument(draft?: { name: string; content: string }): Promise<FileResult>;
  save(content: string, saveAs: boolean, options?: { id?: string; path: string | null; confirmationId?: number }): Promise<FileResult>;
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
  openFolder(): Promise<{ folder?: LocalFolder; canceled?: boolean; error?: string }>;
  listFolder(relativePath: string): Promise<FolderListing>;
  searchFolder(query: string, refresh: boolean): Promise<FolderSearch>;
  openFile(relativePath: string): Promise<FileResult>;
  createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<{ changed?: boolean; path?: string; error?: string; canceled?: boolean }>;
  renameEntry(path: string, name: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  moveEntry(path: string, destination?: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  trashEntry(path: string): Promise<{ changed?: boolean; canceled?: boolean; error?: string }>;
  onFolder(callback: (folder: LocalFolder) => void): () => void;
}

declare global { interface Window { slate?: DesktopBridge } }

export const EMPTY_DOCUMENT: SlateDocument = { id: 'initial', path: null, name: 'Untitled.md', content: '' };

// Keep constructs outside this version's visual editing vocabulary in source mode.
// In particular, HTML comments and front matter must never silently disappear.
export function sourceOnlyReason(markdown: string): string | null {
  if (/^(?:\ufeff)?---\s*\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/.test(markdown)) return 'YAML front matter';
  if (/^(?:\ufeff)?\+\+\+\s*\n/.test(markdown)) return 'TOML front matter';
  let fence: { char: string; length: number } | null = null;
  const prose = markdown.split('\n').filter(line => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  }).join('\n');
  if (/<!--|<\/?[a-z][^>]*>/i.test(prose)) return 'HTML';
  if (/!\[[^\]]*\]/.test(prose)) return 'images';
  if (/^\s{0,3}\[[^\]]+\]:/m.test(prose)) return 'reference definitions or footnotes';
  if (/^\s*\$\$|\$[^\n$]+\$/m.test(prose)) return 'math notation';
  return null;
}
