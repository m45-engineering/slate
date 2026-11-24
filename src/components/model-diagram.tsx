import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SavedDiagram, DiagramShape } from '@/lib/mbse/diagrams';
import type { ModelElement } from '@/lib/mbse/model';
import { arrowAtStart, associationMarkers, frameShapeKinds, invisibleShapeKinds, savedCompartments, shapeLabel, textShapeKinds, visibleShapes } from '@/lib/mbse/presentation';
import { diagramLabel } from '@/lib/mbse/diagrams';

const dashedEdges = new Set(['Dependency', 'Realization', 'Abstraction', 'NoteAnchor', 'Extend', 'Include', 'ProfileApplication']);
const directedEdges = new Set(['Dependency', 'Realization', 'Abstraction', 'Extend', 'Include', 'ProfileApplication', 'ControlFlow', 'ObjectFlow', 'Transition', 'SeqMessage', 'SeqSelfMessage', 'LostMessage']);
const roundBoxes = new Set(['State', 'StateInvariant', 'CallBehaviorAction', 'OpaqueAction']);
const silentKinds = new Set(['Port', 'Pin', 'Activation', 'LifeLineLine', 'Bar', 'Decision', 'PseudoState', 'PseudoNode', 'Separator', 'Split', 'Tree', 'TimeConstraint']);
const abbreviations: Record<string, string> = { 'SysML Block Definition Diagram': 'bdd', 'SysML Internal Block Diagram': 'ibd', 'SysML Package Diagram': 'pkg', 'Requirement Diagram': 'req', 'SysML Use Case Diagram': 'uc', 'SysML Activity Diagram': 'act', 'SysML Sequence Diagram': 'sd', 'SysML Parametric Diagram': 'par', 'SysML State Machine Diagram': 'stm', 'Profile Diagram': 'profile' };

function ShapeSymbol({ shape: s, target, stroke, fill }: { shape: DiagramShape; target?: ModelElement; stroke: string; fill: string }) {
  const [x, y, w, h] = s.geometry, cx = x+w/2, cy = y+h/2;
  const base = { className: 'model-shape-box', stroke, fill, strokeWidth: 1 };
  const kind = target?.properties.kind || 'initial';
  if (s.kind === 'UseCase') return <ellipse {...base} cx={cx} cy={cy} rx={w/2} ry={h/2}/>;
  if (s.kind === 'Actor') return <g><circle {...base} cx={cx} cy={y+9} r={8}/><path className="model-shape-line" d={`M${cx},${y+17} v${h*.32} M${cx-w*.25},${y+h*.3} H${cx+w*.25} M${cx},${y+h*.5} L${cx-w*.23},${y+h*.76} M${cx},${y+h*.5} L${cx+w*.23},${y+h*.76}`} fill="none" stroke={stroke}/></g>;
  if (s.kind === 'Decision' || (s.kind === 'PseudoState' && ['choice', 'junction'].includes(kind))) return <polygon {...base} points={`${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}`}/>;
  if (s.kind === 'Bar') return <rect {...base} x={x} y={y} width={w} height={h} fill={stroke}/>;
  if (['PseudoNode', 'PseudoState'].includes(s.kind)) {
    const final = ['ActivityFinalNode', 'FinalState'].includes(target?.type.localName || '');
    if (target?.type.localName === 'FlowFinalNode' || kind === 'terminate') return <g><circle {...base} cx={cx} cy={cy} r={Math.min(w,h)/2}/><path d={`M${x+3},${y+3} L${x+w-3},${y+h-3} M${x+w-3},${y+3} L${x+3},${y+h-3}`} stroke={stroke}/></g>;
    if (['shallowHistory', 'deepHistory', 'entryPoint', 'exitPoint'].includes(kind)) return <g><circle {...base} cx={cx} cy={cy} r={Math.min(w,h)/2}/><text x={cx} y={cy+4} fontSize="11" textAnchor="middle">{kind === 'deepHistory' ? 'H*' : kind === 'shallowHistory' ? 'H' : kind === 'exitPoint' ? '×' : ''}</text></g>;
    return <g><circle {...base} cx={cx} cy={cy} r={Math.min(w,h)/2} fill={final ? fill : stroke}/>{final && <circle cx={cx} cy={cy} r={Math.max(1,Math.min(w,h)/2-4)} fill={stroke}/>}</g>;
  }
  if (s.kind === 'Package') return <path {...base} d={`M${x},${y+h} V${y} H${x+w*.4} V${y+12} H${x+w} V${y+h} Z M${x},${y+12} H${x+w*.4}`}/>;
  if (['Note','Comment'].includes(s.kind)) return <path {...base} d={`M${x},${y} H${x+w-10} L${x+w},${y+10} V${y+h} H${x} Z M${x+w-10},${y} V${y+10} H${x+w}`}/>;
  if (s.kind === 'SignalAction') {
    const sending = target?.type.localName === 'SendSignalAction';
    return <path {...base} d={sending ? `M${x},${y} H${x+w-12} L${x+w},${cy} L${x+w-12},${y+h} H${x} Z` : `M${x},${y} H${x+w} V${y+h} H${x} L${x+12},${cy} Z`}/>;
  }
  if (s.kind === 'LifeLineLine') return <line className="model-shape-line" x1={cx} y1={y} x2={cx} y2={y+h} stroke={stroke} strokeDasharray="5 4"/>;
  if (['Separator','Split','Tree','TimeConstraint','InteractionOperand','Region'].includes(s.kind)) return <line className="model-shape-line" x1={x} y1={y} x2={x+w} y2={y} stroke={stroke} strokeDasharray={s.kind === 'Tree' ? undefined : '5 3'}/>;
  return <>
    <rect {...base} x={x} y={y} width={w} height={h} rx={roundBoxes.has(s.kind) ? 9 : undefined} fill={frameShapeKinds.has(s.kind) ? 'none' : fill} strokeDasharray={s.kind === 'Region' ? '5 3' : undefined}/>
    {['CombinedFragment','InteractionUse'].includes(s.kind) && <path d={`M${x},${y+19} H${x+35} L${x+43},${y+11} V${y}`} fill="none" stroke={stroke}/>}
    {s.kind === 'Component' && <path d={`M${x+w-18},${y+5} h12 v18 h-12 Z M${x+w-22},${y+8} h8 v4 h-8 Z M${x+w-22},${y+15} h8 v4 h-8 Z`} fill={fill} stroke={stroke}/>}
  </>;
}

// Measure the actual font and wrapping; character counts miss long words and compartment headings.
function FittedLabel({ children, height, font, signature, className, style }: { children: ReactNode; height: number; font: number; signature: string; className: string; style: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let canceled = false;
    const fit = () => {
      if (canceled || !ref.current) return;
      const node = ref.current;
      let size = font;
      node.style.fontSize = `${size}px`;
      node.style.lineHeight = `${size + 2}px`;
      while (node.scrollHeight > height + .5 && size > 6) {
        size -= .25;
        node.style.fontSize = `${size}px`;
        node.style.lineHeight = `${size + 2}px`;
      }
    };
    fit();
    void document.fonts.ready.then(fit);
    return () => { canceled = true; };
  }, [font, height, signature]);
  return <div ref={ref} className={className} style={style}>{children}</div>;
}

export function ModelDiagram({ diagram, elements, selected, onSelect, zoom }: { diagram: SavedDiagram; elements: Map<string, ModelElement>; selected: string; onSelect: (id: string) => void; zoom: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { viewport.current?.scrollTo(0, 0); }, [diagram.id]);
  const shapes = visibleShapes(diagram.shapes);
  const classifiers = [...new Set(shapes.map(s => { const e = elements.get(s.elementId); return s.kind === 'Part' ? e?.properties.type : e?.id; }))].map(id => elements.get(id ?? '')).filter(e => e?.stereotypes.some(t => t.type.localName === 'ConstraintBlock'));
  const expressions = classifiers.flatMap(classifier => [...elements.values()].filter(e => e.ownerId === classifier!.id && e.type.localName === 'Constraint').flatMap(c => [...elements.values()].filter(e => e.ownerId === c.id && (e.properties.body || e.properties.value)).map(e => ({ id: e.id, name: classifier!.name, body: e.properties.body || e.properties.value }))));
  const points = shapes.flatMap(s => s.line ? Array.from({ length:s.geometry.length/2 }, (_,i)=>[s.geometry[2*i],s.geometry[2*i+1]]) : [[s.geometry[0],s.geometry[1]],[s.geometry[0]+s.geometry[2],s.geometry[1]+s.geometry[3]]]);
  const left = Math.min(0,...points.map(p=>p[0]))-32, top = Math.min(0,...points.map(p=>p[1]))-32;
  const width = Math.max(400,...points.map(p=>p[0]))-left+32, height = Math.max(300,...points.map(p=>p[1]))-top+32;
  // Background frames and lifelines must not paint over their children or messages.
  const containers = new Set(shapes.filter(s => !s.line && !textShapeKinds.has(s.kind) && !invisibleShapeKinds.has(s.kind)).map(s => s.parentId));
  const layer = (s: DiagramShape) => frameShapeKinds.has(s.kind) || containers.has(s.id) || s.kind === 'LifeLineLine' ? 0 : s.line ? 2 : textShapeKinds.has(s.kind) ? 3 : 1;
  const depth = (s: DiagramShape): number => { let d = 0, parent = shapes.find(p => p.id === s.parentId); while (parent && d < 256) { d++; parent = shapes.find(p => p.id === parent!.parentId); } return d; };
  const ordered = [...shapes].sort((a,b)=>layer(a)-layer(b) || depth(a)-depth(b));
  const scale = zoom ? zoom/100 : Math.min(1.5, Math.max(.1, Math.min(viewportSize.width/width, viewportSize.height/height)));
  return <div className="model-canvas-scroll" ref={viewport}><svg aria-label="Saved diagram" data-diagram-type={diagram.type} viewBox={`${left} ${top} ${width} ${height}`} width={width*scale} height={height*scale}>
    <defs>
      <marker id="model-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="#555"/></marker>
      <marker id="model-filled-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse"><path d="M1,1 L8,4.5 L1,8 Z" fill="#555"/></marker>
      <marker id="model-triangle" markerWidth="12" markerHeight="12" refX="11" refY="6" orient="auto-start-reverse"><path d="M1,1 L11,6 L1,11 Z" fill="white" stroke="#555"/></marker>
      <marker id="model-containment" markerWidth="12" markerHeight="12" refX="6" refY="6" orient="auto"><circle cx="6" cy="6" r="5" fill="white" stroke="#555"/><path d="M2,6 H10 M6,2 V10" stroke="#555"/></marker>
      <marker id="model-composition" markerWidth="14" markerHeight="10" refX="13" refY="5" orient="auto-start-reverse"><path d="M1,5 L7,1 L13,5 L7,9 Z" fill="#525252" stroke="#525252"/></marker>
      <marker id="model-aggregation" markerWidth="14" markerHeight="10" refX="13" refY="5" orient="auto-start-reverse"><path d="M1,5 L7,1 L13,5 L7,9 Z" fill="white" stroke="#525252"/></marker>
    </defs>
    {ordered.filter(s=>!invisibleShapeKinds.has(s.kind)).map(s => {
      const [x,y,w,h] = s.geometry, target = elements.get(s.elementId), isText = textShapeKinds.has(s.kind), isFrame = s.kind === 'DiagramFrame';
      const selectedShape = Boolean(selected && s.elementId === selected);
      const interactive = Boolean(s.elementId) && !isFrame;
      const stroke = isFrame ? '#d4d4d4' : '#8a8a8a';
      const label = shapeLabel(s, elements);
      const compartments = savedCompartments(s, elements, shapes);
      const stereotypes = s.properties.STEREOTYPES_DISPLAY_MODE?.includes('DO_NOT_DISPLAY') ? [] : target?.stereotypes.filter(t => !['DiagramInfo', 'ValueProperty', 'PartProperty', 'ReferenceProperty', 'ConstraintProperty'].includes(t.type.localName)) || [];
      const ends = associationMarkers(s, shapes, elements);
      const hasLabel = shapes.some(t=>t.parentId === s.id && textShapeKinds.has(t.kind));
      const requirement = target?.stereotypes.find(t=>t.properties.Text !== undefined);
      const extra = !isText && s.kind === 'Class' && requirement ? `${requirement.properties.Id ? `id = ${requirement.properties.Id}\n` : ''}${requirement.properties.Text}` : '';
      const marker = ['Generalization','Realization'].includes(s.kind) ? 'model-triangle' : s.kind === 'ContainmentLink' ? 'model-containment' : directedEdges.has(s.kind) ? ['SeqMessage','SeqSelfMessage'].includes(s.kind) && target?.properties.messageSort === 'synchCall' ? 'model-filled-arrow' : 'model-arrow' : undefined;
      const atStart = arrowAtStart(s,shapes,elements);
      const labelY = s.kind === 'Actor' ? y+h*.8 : s.kind === 'Package' ? y+18 : y+7;
      const labelHeight = s.kind === 'Actor' ? 32 : Math.max(12,y+h-labelY-3);
      const labelWidth = s.kind === 'Actor' ? Math.max(80, w*2) : Math.max(1,w-14);
      const displayLabel = diagramLabel(label);
      const allText = [displayLabel, extra, ...compartments.flatMap(c => [c.name, ...c.lines])].filter(Boolean).join('\n');
      const lineCount = (font: number) => allText.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length*font*.52/labelWidth)), stereotypes.length ? 1 : 0);
      let font = 11;
      if (!s.line && !frameShapeKinds.has(s.kind)) while (font > 7.5 && lineCount(font)*(font+2) + compartments.length*8 + (extra ? 8 : 0) > labelHeight) font -= .5;
      const centered = !isText && !extra && !compartments.length && !containers.has(s.id) && ['UseCase', 'State', 'CallBehaviorAction', 'OpaqueAction', 'SignalAction', 'SequenceLifeline'].includes(s.kind);
      const startMarker = ends.start || (marker && atStart ? marker : undefined);
      const endMarker = ends.end || (marker && !atStart ? marker : undefined);
      return <g key={s.id} className={`model-shape${selectedShape ? ' is-selected' : ''}`} data-shape-kind={s.kind} data-shape-id={s.id} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} aria-pressed={interactive ? selectedShape : undefined} aria-label={interactive ? `Inspect ${target?.name || label || s.kind}` : undefined} onClick={()=>interactive && onSelect(s.elementId)} onKeyDown={e=>{if(interactive && ['Enter',' '].includes(e.key)){e.preventDefault();onSelect(s.elementId);}}} style={{cursor:interactive?'pointer':undefined}}>
        {s.line ? <>
          <polyline className="model-shape-line" points={Array.from({length:s.geometry.length/2},(_,i)=>`${s.geometry[2*i]},${s.geometry[2*i+1]}`).join(' ')} fill="none" stroke={stroke} strokeWidth={1} strokeDasharray={dashedEdges.has(s.kind) || target?.properties.messageSort === 'reply' ? '5 3' : undefined} markerStart={startMarker ? `url(#${startMarker})` : undefined} markerEnd={endMarker ? `url(#${endMarker})` : undefined}/>
          <polyline points={Array.from({length:s.geometry.length/2},(_,i)=>`${s.geometry[2*i]},${s.geometry[2*i+1]}`).join(' ')} fill="none" stroke="transparent" strokeWidth="10"/>
          {s.kind === 'LostMessage' && <circle cx={target?.properties.receiveEvent ? s.geometry.at(-2) : s.geometry[0]} cy={target?.properties.receiveEvent ? s.geometry.at(-1) : s.geometry[1]} r="4" fill={stroke}/>}
        </> : <>
          {!isText && <ShapeSymbol shape={s} target={target} stroke={stroke} fill={selectedShape?'#f4f4f4':'white'}/>}
          {isFrame && <text x={x+10} y={y+17} className="model-frame-title">{abbreviations[diagram.type] || diagram.type} · {diagram.name}</text>}
          {!isFrame && !silentKinds.has(s.kind) && (isText || !hasLabel) && displayLabel && <foreignObject x={isText?x:s.kind === 'Actor'?x+w/2-labelWidth/2:x+7} y={isText?y:labelY} width={isText?Math.max(1,w+4):labelWidth} height={isText?Math.max(14,h+4):labelHeight}><FittedLabel height={isText?Math.max(14,h+4):labelHeight} font={font} signature={allText + stereotypes.map(s => s.type.localName).join()} className={`model-shape-label${centered ? ' is-centered' : ''}`} style={{fontSize:font,lineHeight:`${font+2}px`,textAlign:isText || frameShapeKinds.has(s.kind) || ['Note','Comment'].includes(s.kind)?'left':'center',textDecoration:s.kind==='InstanceSpecification'?'underline':undefined}}>
            {!isText && stereotypes.length ? <div className="model-stereotype">«{stereotypes.map(t=>t.type.localName).join(', ')}»</div> : null}
            {s.kind === 'InteractionUse' && <div className="model-stereotype">ref</div>}<div className={isText ? undefined : 'model-shape-name'}>{displayLabel}</div>
            {extra && <div className="model-compartment">{diagramLabel(extra)}</div>}
            {compartments.map(c => <div className="model-compartment" key={c.name}><div className="model-compartment-title">{c.name}</div>{c.lines.map((line,i) => <div key={i}>{line}</div>)}</div>)}
          </FittedLabel></foreignObject>}
        </>}
      </g>;
    })}
  </svg>{expressions.length > 0 && <section className="model-expressions" aria-label="Constraint expressions"><strong>Constraint expressions</strong>{expressions.map(e => <div key={e.id}><button onClick={() => onSelect(e.id)}>{e.name}</button><pre>{e.body}</pre></div>)}</section>}</div>;
}
