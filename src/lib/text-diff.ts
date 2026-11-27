export type DiffPart = { kind: 'equal' | 'added' | 'removed'; text: string };

// Bounded Myers diff: unrelated or unusually large edits fall back to an exact,
// coarser replacement rather than blocking the editor with quadratic work.
export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'equal', text: before }] : [];
  const a = before.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const b = after.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const left = a.slice(start, a.length - end), right = b.slice(start, b.length - end);
  const fallback: DiffPart[] = [{ kind: 'removed', text: left.join('') }, { kind: 'added', text: right.join('') }];
  let middle = fallback;
  const trace: Map<number, number>[] = [];
  const frontier = new Map<number, number>([[1, 0]]);
  let work = 0;
  search: for (let distance = 0; distance <= Math.min(left.length + right.length, 512); distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
        ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; work++; }
      frontier.set(diagonal, x);
      if (++work > 1_000_000) break search;
      if (x >= left.length && y >= right.length) {
        const reversed: DiffPart[] = [];
        for (let depth = distance; depth >= 0; depth--) {
          const previous = trace[depth], k = x - y;
          const prevK = k === -depth || (k !== depth && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1;
          const prevX = previous.get(prevK) ?? 0, prevY = prevX - prevK;
          while (x > prevX && y > prevY) { reversed.push({ kind: 'equal', text: left[--x] }); y--; }
          if (depth) {
            if (x === prevX) reversed.push({ kind: 'added', text: right[--y] });
            else reversed.push({ kind: 'removed', text: left[--x] });
          }
        }
        middle = reversed.reverse();
        break search;
      }
    }
  }
  const parts: DiffPart[] = [];
  for (const part of [{ kind: 'equal' as const, text: a.slice(0, start).join('') }, ...middle, { kind: 'equal' as const, text: end ? a.slice(-end).join('') : '' }]) {
    if (!part.text) continue;
    if (parts.at(-1)?.kind === part.kind) parts[parts.length - 1].text += part.text;
    else parts.push({ ...part });
  }
  return parts;
}
