const paths = {
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
  open: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2 M3 10h18l-3 10H3z',
  plus: 'M12 5v14 M5 12h14',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8',
  chevron: 'm7 10 5 5 5-5',
  bold: 'M6 4h7a4 4 0 0 1 0 8H6z M6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9 M14 20H5 M15 4 9 20',
  strike: 'M16 5a6 6 0 0 0-10 3c0 2 2 3 6 4s6 2 6 4a6 6 0 0 1-10 3 M3 12h18',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  list: 'M9 6h12 M9 12h12 M9 18h12 M3 6h.01 M3 12h.01 M3 18h.01',
  ordered: 'M10 6h11 M10 12h11 M10 18h11 M3 4h1v5 M3 14c3-3 4 1 0 5h3',
  check: 'm5 12 4 4L19 6',
  checkbox: 'M9 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V10 M9 10l4 4L22 4',
  quote: 'M3 5h7v7H5c0 4 3 5 3 5 M14 5h7v7h-5c0 4 3 5 3 5',
  code: 'm8 6-6 6 6 6 M16 6l6 6-6 6',
  formula: 'M20 4H5l7 8-7 8h15',
  table: 'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18 M15 3v18',
  diagram: 'M8 3h8v5H8z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4',
  undo: 'M3 10h11a7 7 0 0 1 0 14 M3 10l5-5 M3 10l5 5',
  redo: 'M21 10H10a7 7 0 0 0 0 14 M21 10l-5-5 M21 10l-5 5',
  panel: 'M3 3h18v18H3z M9 3v18 M5 7h2 M5 11h2 M5 15h2',
  close: 'm6 6 12 12 M18 6 6 18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
