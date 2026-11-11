'use client';

import { useRef, useState } from 'react';
import { Icon } from './icon';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { TooltipHint } from './ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

type DocumentTab = { id: string; name: string; path: string | null; dirty: boolean };

export function DocumentTabs({ tabs, activeId, onSelect, onClose, onCloseOthers, onCloseAll, onReorder }: {
  tabs: DocumentTab[]; activeId: string;
  onSelect(id: string): void; onClose(id: string): void;
  onCloseOthers(id: string): void; onCloseAll(): void; onReorder(ids: string[]): void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());

  return <>
    <Tabs value={activeId} onValueChange={onSelect} className="document-tabs">
      <TabsList aria-label="Open documents" className="document-tab-list">
        {tabs.map(tab => <div key={tab.id} className="document-tab" data-active={tab.id === activeId}
          data-drop={dropTarget?.id === tab.id ? dropTarget.after ? 'after' : 'before' : undefined}
          draggable onDragStart={event => { dragging.current = tab.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.id); }}
          onDragEnd={() => { dragging.current = null; setDropTarget(null); }}
          onDragOver={event => { if (!dragging.current) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: tab.id, after: event.clientX > rect.left + rect.width / 2 }); }}
          onDrop={event => {
            event.preventDefault();
            const from = dragging.current;
            if (from && from !== tab.id) {
              const ids = tabs.map(item => item.id).filter(id => id !== from);
              const rect = event.currentTarget.getBoundingClientRect();
              ids.splice(ids.indexOf(tab.id) + (event.clientX > rect.left + rect.width / 2 ? 1 : 0), 0, from);
              onReorder(ids);
            }
            dragging.current = null; setDropTarget(null);
          }}
          onContextMenu={event => { event.preventDefault(); setMenu({ id: tab.id, x: event.clientX, y: event.clientY }); }}
          onKeyDown={event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ id: tab.id, x: rect.left, y: rect.bottom });
            }
          }}>
          <TooltipHint content={tab.path || tab.name}><TabsTrigger ref={element => { if (element) triggers.current.set(tab.id, element); else triggers.current.delete(tab.id); }} value={tab.id} aria-label={`${tab.name}${tab.dirty ? ', unsaved changes' : ''}`}><span>{tab.name}</span>{tab.dirty && <span className="unsaved-dot" aria-hidden="true" />}</TabsTrigger></TooltipHint>
          <TooltipHint content={`Close ${tab.name}`}><Button variant="ghost" size="icon" className="close-tab" aria-label={`Close ${tab.name}`} onClick={() => onClose(tab.id)}><Icon name="close" size={13} /></Button></TooltipHint>
        </div>)}
      </TabsList>
    </Tabs>
    <DropdownMenu open={Boolean(menu)} onOpenChange={open => { if (!open) setMenu(null); }}>
      <DropdownMenuTrigger asChild><Button tabIndex={-1} aria-hidden="true" className="tab-menu-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={event => { event.preventDefault(); triggers.current.get(menu?.id ?? activeId)?.focus(); }}>
        <DropdownMenuItem onSelect={() => { if (menu) onClose(menu.id); }}>Close</DropdownMenuItem>
        <DropdownMenuItem disabled={tabs.length < 2} onSelect={() => { if (menu) onCloseOthers(menu.id); }}>Close Others</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCloseAll}>Close All</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}
