import type { ModelElement } from '@/lib/mbse/model';

export function ModelInteraction({ contextId, elements, onSelect }: { contextId: string; elements: Map<string, ModelElement>; onSelect: (id: string) => void }) {
  const members = [...elements.values()].filter(e => e.ownerId === contextId);
  const lifelines = members.filter(e => e.type.localName === 'Lifeline');
  const messages = members.filter(e => e.type.localName === 'Message');
  const participant = (id: string) => {
    const e = elements.get(id);
    const represented = elements.get(e?.references.find(r=>r.role==='represents')?.targetId ?? '');
    const type = elements.get(represented?.references.find(r=>r.role==='type')?.targetId ?? '');
    return e?.name || (represented ? `${represented.name}${type ? ` : ${type.name}` : ''}` : id);
  };
  const endpoint = (message: ModelElement, role: 'sendEvent' | 'receiveEvent') => {
    const eventId = message.references.find(r=>r.role===role)?.targetId;
    const event = elements.get(eventId ?? '');
    const covered = event?.references.find(r=>r.role==='covered')?.targetId;
    return covered ? <button onClick={()=>onSelect(covered)}>{participant(covered)}</button> : eventId ? 'Unresolved event' : 'Outside interaction';
  };
  return <div className="model-interaction" aria-label="Linked interaction">
    <p>This saved canvas contains only a frame.</p>
    <details open><summary>Linked interaction: {elements.get(contextId)?.name || 'Unnamed'} · {lifelines.length} participants · {messages.length} messages</summary>
      <p>{lifelines.map((e,i)=><span key={e.id}>{i > 0 ? ' · ' : ''}<button onClick={()=>onSelect(e.id)}>{participant(e.id)}</button></span>)}</p>
      {messages.length > 0 && <table className="model-table"><caption>Messages in source order; this list does not imply execution order.</caption><thead><tr><th>Message</th><th>From</th><th>To</th><th>Kind</th></tr></thead><tbody>{messages.map(m=><tr key={m.id}><td><button onClick={()=>onSelect(m.id)}>{m.name || elements.get(m.properties.signature)?.name || 'Unnamed message'}</button></td><td>{endpoint(m,'sendEvent')}</td><td>{endpoint(m,'receiveEvent')}</td><td>{m.properties.messageSort || 'synchCall'}</td></tr>)}</tbody></table>}
    </details>
  </div>;
}
