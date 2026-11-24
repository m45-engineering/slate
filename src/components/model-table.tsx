import type { SavedDiagram } from '@/lib/mbse/diagrams';
import type { AllocationMatrix, ModelPackage } from '@/lib/mbse/model';
import { tableCell } from '@/lib/mbse/presentation';

export function ModelTable({ diagram, bundle, matrix, onSelect }: { diagram: SavedDiagram; bundle: ModelPackage; matrix?: AllocationMatrix; onSelect: (id: string) => void }) {
  const elements = new Map(bundle.model.elements.map(e => [e.id, e]));
  const name = (id: string) => elements.get(id)?.name || id;
  const link = (id: string) => <button onClick={() => onSelect(id)}>{name(id)}</button>;
  if (matrix) return <div className="model-table-scroll">
    <p className="model-note">Reconstructed from saved scopes and explicit relationships. Arrows show relationship direction between row and column.</p>
    {matrix.diagnostics.map(note => <p className="model-note" key={note}>{note}</p>)}
    <table className="model-table model-matrix" aria-label={diagram.name}><caption>{matrix.rowIds.length} rows × {matrix.columnIds.length} columns · {matrix.cells.length} populated cells</caption><thead><tr><th scope="col">Row / Column</th>{matrix.columnIds.map(id => <th scope="col" key={id}>{link(id)}</th>)}</tr></thead><tbody>{matrix.rowIds.map(rowId => <tr key={rowId}><th scope="row">{link(rowId)}</th>{matrix.columnIds.map(columnId => {
      const cells = matrix.cells.filter(c => c.rowId === rowId && c.columnId === columnId);
      return <td key={columnId}>{cells.flatMap(c => c.relationshipIds.map(id => <button key={`${id}:${c.direction}`} aria-label={`${name(rowId)} ${c.direction === 'forward' ? 'to' : 'from'} ${name(columnId)}: ${elements.get(id)?.stereotypes.map(s => s.type.localName).join(', ') || 'relationship'}`} title={elements.get(id)?.stereotypes.map(s => s.type.localName).join(', ')} onClick={() => onSelect(id)}>{c.direction === 'forward' ? '→' : '←'}</button>))}</td>;
    })}</tr>)}</tbody></table>
  </div>;
  if (!diagram.table) return null;
  return <div className="model-table-scroll"><table className="model-table" aria-label={diagram.name}><caption>{diagram.table.rowIds.length} rows · Saved columns and row order</caption><thead><tr>{diagram.table.columns.map(c => <th key={c.id} scope="col" style={{minWidth:c.width}}>{c.id === '_NUMBER_' ? '#' : c.id.replace('QPROP:Element:', '').replace('APPLIED_STEREOTYPES', 'Stereotypes')}</th>)}</tr></thead><tbody>{diagram.table.rowIds.map((id, index) => {
    const element = elements.get(id);
    return <tr key={id}>{diagram.table!.columns.map(c => <td key={c.id}>{c.id === '_NUMBER_' ? index + 1 : !element ? `Unresolved element: ${id}` : tableCell(c.id, element, bundle).map((v, i) => <div key={i}>{v.elementId ? <button onClick={() => onSelect(v.elementId!)}>{v.text}</button> : v.text}</div>)}</td>)}</tr>;
  })}</tbody></table></div>;
}
