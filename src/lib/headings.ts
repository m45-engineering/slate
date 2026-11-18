// Match the familiar Markdown heading anchors, including repeated headings.
export function headingAnchors(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map(title => {
    const base = title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let anchor = base;
    let suffix = 0;
    while (used.has(anchor)) anchor = `${base}-${++suffix}`;
    used.add(anchor);
    return anchor;
  });
}

export function headingIndex(titles: string[], fragment: string): number {
  return headingAnchors(titles).indexOf(decodeURIComponent(fragment.replace(/^#/, '')).toLowerCase());
}
