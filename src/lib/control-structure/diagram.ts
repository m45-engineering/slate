import type { AuthoringResult } from './schema.ts';

// Encode every user-provided character so labels cannot become Mermaid syntax or HTML.
const label = (text: string) => text.replace(/[&<>"#\r\n]/g, char => `#${char.codePointAt(0)};`);
export function controlStructureDiagram(result: AuthoringResult) {
  const nodes = new Map(result.graph.components.map((component, index) => [component.id, `cs${index}`]));
  const lines = ['flowchart TB'];
  for (const component of result.graph.components) {
    const detail = result.graph.details.some(item => item.ownerId === component.id && item.body);
    const role = (component.type ?? 'Unclassified').toUpperCase();
    // Separate the role from the name as M45 does; rendering styles are embedded in the SVG.
    const badge = `<span class='control-node-role'>${role}</span>`;
    const name = `<span class='control-node-name'>${label(component.name)}</span>`;
    lines.push(`${nodes.get(component.id)}["<span class='control-node-label'>${badge}${detail ? " <span class='control-node-info'>ⓘ</span>" : ''}${name}</span>"]:::${component.type ?? 'unclassified'}`);
  }
  result.graph.connections.forEach((connection, index) => {
    const arrow = connection.relationship === 'feedback' || connection.relationship === 'information' ? '-.->' : '-->';
    lines.push(`${nodes.get(connection.sourceId)} ${arrow}|"${label(connection.label)}"| ${nodes.get(connection.targetId)}`);
    const color = { control: '#333333', feedback: '#0d6ea5', information: '#737373', effect: '#a15c12', observation: '#56806a' }[connection.relationship];
    lines.push(`linkStyle ${index} stroke:${color},color:${color}`);
  });
  lines.push('classDef controller fill:#fff,stroke:#333,stroke-width:2px,color:#222',
    'classDef process fill:#f2f8fc,stroke:#0d6ea5,stroke-width:2px,color:#222',
    'classDef sensor fill:#fff,stroke:#6fa2e8,stroke-width:2px,color:#222',
    'classDef actuator fill:#fff,stroke:#6fa2e8,stroke-width:2px,color:#222',
    'classDef unclassified fill:#fafafa,stroke:#aaa,stroke-dasharray:5 4,color:#444');
  return lines.join('\n');
}
