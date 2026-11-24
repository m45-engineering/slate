const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readDocument, writeDocument } = require('../electron/file-store.cjs');
const { isTextFile, isOpenableFile } = require('../electron/file-types.cjs');

test('model archives open as bytes and cannot be saved over or converted through text Save As', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-model-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'model.mdzip');
  const bytes = Buffer.from([80,75,3,4,0,255]);
  await fs.writeFile(file, bytes);
  const document = await readDocument(file);
  assert.deepEqual(Buffer.from(document.content, 'base64'), bytes);
  assert.equal(isTextFile(file), false);
  assert.equal(isOpenableFile(file), true);
  await assert.rejects(writeDocument(file, 'changed', document), /read-only/);
  await assert.rejects(writeDocument(path.join(directory, 'copy.txt'), 'changed', document), /read-only/);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('saved layouts preserve node rectangles, connector bends, and explicit element IDs', async () => {
  const JSZip = require('jszip');
  const { readSavedDiagrams } = await import('../src/lib/mbse/diagrams.ts');
  const zip = new JSZip();
  zip.file('com.nomagic.magicdraw.uml_model.model', `<xmi:XMI xmlns:xmi="http://www.omg.org/XMI"><ownedDiagram xmi:id="d" name="Blocks"><DiagramRepresentationObject type="SysML Internal Block Diagram"><binaryObject streamContentID="BINARY-layout"/></DiagramRepresentationObject></ownedDiagram></xmi:XMI>`);
  zip.file('BINARY-layout', `<mdOwnedViews><mdElement elementClass="Part" xmi:id="shape"><elementID xmi:idref="part"/><geometry>140, 56, 175, 119</geometry></mdElement><mdElement elementClass="Connector" xmi:id="edge"><elementID xmi:idref="connection"/><geometry>140, 98; 70, 98; 70, 61; 20, 61;</geometry></mdElement></mdOwnedViews>`);
  const [diagram] = await readSavedDiagrams(await zip.generateAsync({type:'uint8array'}));
  assert.equal(diagram.supported, true);
  assert.equal(diagram.shapes[0].elementId, 'part');
  assert.deepEqual(diagram.shapes[0].geometry, [140,56,175,119]);
  assert.equal(diagram.shapes[1].line, true);
  assert.deepEqual(diagram.shapes[1].geometry, [140,98,70,98,70,61,20,61]);
  zip.file('BINARY-layout', '<!DOCTYPE x [<!ENTITY x "bad">]><mdOwnedViews/>');
  await assert.rejects(readSavedDiagrams(await zip.generateAsync({type:'uint8array'})), /DTD/);
  zip.file('BINARY-layout', '<mdOwnedViews><broken></mdOwnedViews>');
  await assert.rejects(readSavedDiagrams(await zip.generateAsync({type:'uint8array'})));
});

test('rich diagram labels render as text without executing embedded markup', async () => {
  const { diagramLabel } = await import('../src/lib/mbse/diagrams.ts');
  assert.equal(diagramLabel('<html><head><style>body {color:red}</style></head><body><p>Bus &amp; power<br/>interface</p><script>bad()</script></body></html>'), 'Bus & power\ninterface');
  assert.equal(diagramLabel('voltage < limit'), 'voltage < limit');
});

test('all diagram families preserve their layout, including nested sequence operands and external labels', async () => {
  const JSZip = require('jszip');
  const { readSavedDiagrams, supportedDiagramTypes } = await import('../src/lib/mbse/diagrams.ts');
  const zip = new JSZip();
  const types = supportedDiagramTypes.filter(t => t !== 'Generic Table' && !t.endsWith('Matrix'));
  zip.file('com.nomagic.magicdraw.uml_model.model', `<xmi:XMI xmlns:xmi="http://www.omg.org/XMI">${types.map((type,i)=>`<ownedDiagram xmi:id="d${i}" name="${type}"><DiagramRepresentationObject type="${type}"><binaryObject streamContentID="BINARY-layout"/></DiagramRepresentationObject></ownedDiagram>`).join('')}</xmi:XMI>`);
  zip.file('BINARY-layout', `<mdOwnedViews><mdElement elementClass="CombinedFragment" xmi:id="frame"><geometry>10,20,300,200</geometry><operands><mdElement elementClass="InteractionOperand" xmi:id="operand"><geometry>15,40,290,170</geometry><text>[ready]</text></mdElement></operands></mdElement><mdElement elementClass="Class" xmi:id="external"><elementID href="profile.mdzip#class"><referenceExtension referentPath="Profile::External"/></elementID><geometry>50,60,80,40</geometry></mdElement></mdOwnedViews>`);
  const diagrams = await readSavedDiagrams(await zip.generateAsync({type:'uint8array'}));
  assert.equal(diagrams.length,10);
  for (const d of diagrams) {
    assert.equal(d.supported,true);
    assert.equal(d.shapes.length,3);
    assert.equal(d.shapes[1].parentId,'frame');
    assert.equal(d.shapes[1].text,'[ready]');
    assert.equal(d.shapes[2].referenceName,'External');
    assert.deepEqual(d.shapes[1].geometry,[15,40,290,170]);
  }
});

test('tables retain saved row order, column widths, and hidden columns', async () => {
  const JSZip = require('jszip');
  const { readSavedDiagrams } = await import('../src/lib/mbse/diagrams.ts');
  const zip = new JSZip();
  zip.file('com.nomagic.magicdraw.uml_model.model', `<xmi:XMI xmlns:xmi="http://www.omg.org/XMI"><ownedDiagram xmi:id="d"><DiagramRepresentationObject type="Generic Table"/></ownedDiagram><DiagramTable base_Diagram="d"><columnIds>_NUMBER_</columnIds><columnIds>QPROP:Element:name</columnIds><columnIds>hidden</columnIds><columnWidth>35</columnWidth><columnWidth>280</columnWidth><columnWidth>0</columnWidth><hideColumns>hidden</hideColumns><rowElements>b</rowElements><rowElements>a</rowElements></DiagramTable></xmi:XMI>`);
  const [d] = await readSavedDiagrams(await zip.generateAsync({type:'uint8array'}));
  assert.deepEqual(d.table,{rowIds:['b','a'],columns:[{id:'_NUMBER_',width:35},{id:'QPROP:Element:name',width:280}]});
});

test('flow arrows follow semantic targets instead of assuming the last saved point', async () => {
  const { arrowAtStart, tableCell, shapeLabel } = await import('../src/lib/mbse/presentation.ts');
  const element = (id,name,props={}) => ({id,name,properties:props,type:{localName:'Class'},stereotypes:[],references:[]});
  const source=element('source','Controller'), target=element('target','Requirement');
  const edge={...element('edge',''),references:[{role:'target',targetId:'target'}]};
  const elements=new Map([source,target,edge].map(e=>[e.id,e]));
  const shape={elementId:'edge',first:'t',second:'s'};
  assert.equal(arrowAtStart(shape,[{id:'s',elementId:'source'},{id:'t',elementId:'target'}],elements),true);
  assert.equal(arrowAtStart({...shape,first:'s',second:'t'},[{id:'s',elementId:'source'},{id:'t',elementId:'target'}],elements),false);
  const bundle={model:{elements:[source,target],relationships:[{id:'sat',kind:'satisfaction',sourceIds:['source'],targetIds:['target']}]}};
  assert.deepEqual(tableCell('QPROP:Element:SatisfiedBy',target,bundle),[{text:'Controller',elementId:'source'}]);
  assert.equal(shapeLabel({kind:'SequenceLifeline',elementId:'lifeline',text:''},new Map([...elements,['lifeline',{...element('lifeline',''),references:[{role:'represents',targetId:'source'}]}]])),'Controller');
});

test('Cameo presentation preserves nested parts, state regions, compartment members, and endpoint references', async () => {
  const JSZip = require('jszip');
  const { readSavedDiagrams } = await import('../src/lib/mbse/diagrams.ts');
  const { visibleShapes } = await import('../src/lib/mbse/presentation.ts');
  const zip = new JSZip();
  zip.file('com.nomagic.magicdraw.uml_model.model', '<xmi:XMI xmlns:xmi="http://www.omg.org/XMI"><ownedDiagram xmi:id="d"><DiagramRepresentationObject type="SysML Internal Block Diagram"><binaryObject streamContentID="layout"/></DiagramRepresentationObject></ownedDiagram></xmi:XMI>');
  zip.file('layout', `<mdOwnedViews><mdElement elementClass="Part" xmi:id="outer"><geometry>10,20,400,300</geometry><compartment compartmentID="COMPARTMENT_ID_VALUES" xmi:value="b^a"/><parts><mdElement elementClass="Part" xmi:id="inner"><geometry>40,60,100,80</geometry></mdElement></parts></mdElement><mdElement elementClass="State" xmi:id="state"><geometry>500,20,300,200</geometry><regions><mdElement elementClass="Region" xmi:id="region"><geometry>510,50,280,160</geometry></mdElement></regions></mdElement><mdElement elementClass="Association" xmi:id="edge"><geometry>10,20;40,50;</geometry><associationFirstEndID xmi:idref="role"/></mdElement><mdElement elementClass="Part" xmi:id="hidden"><visible xmi:value="false"/><geometry>0,0,100,100</geometry><parts><mdElement elementClass="Part" xmi:id="hidden-child"><geometry>10,10,20,20</geometry></mdElement></parts></mdElement></mdOwnedViews>`);
  const [d] = await readSavedDiagrams(await zip.generateAsync({type:'uint8array'}));
  assert.equal(d.shapes.find(s=>s.id==='inner').parentId,'outer');
  assert.deepEqual(d.shapes.find(s=>s.id==='inner').geometry,[40,60,100,80]);
  assert.equal(d.shapes.find(s=>s.id==='region').parentId,'state');
  assert.deepEqual(d.shapes[0].compartments,[{id:'COMPARTMENT_ID_VALUES',hiddenIds:['b','a']}]);
  assert.equal(d.shapes.find(s=>s.id==='edge').properties.associationFirstEndID,'role');
  assert.equal(visibleShapes(d.shapes).length,5);
});

test('saved compartments exclude hidden members and respect suppression; composition diamonds mark the whole end', async () => {
  const { savedCompartments, associationMarkers } = await import('../src/lib/mbse/presentation.ts');
  const element=(id,name,properties={})=>({id,name,properties,type:{localName:'Property'},ownerId:'block',references:[],stereotypes:[{type:{localName:'ValueProperty'}}]});
  const a=element('a','mass'),b=element('b','voltage'),part=element('part','component',{aggregation:'composite'});
  const elements=new Map([a,b,part].map(e=>[e.id,e]));
  const shape={kind:'Class',elementId:'block',properties:{SUPPRESS_VALUES_COMPARTMENT:'false'},compartments:[{id:'COMPARTMENT_ID_VALUES',hiddenIds:['b','part','unresolved']}]};
  assert.deepEqual(savedCompartments(shape,elements),[{name:'values',lines:['mass']}]);
  assert.deepEqual(savedCompartments({...shape,properties:{SUPPRESS_VALUES_COMPARTMENT:'true'}},elements),[]);
  const roles=[{id:'first-role',elementId:'part'},{id:'second-role',elementId:'a'}];
  const edge={kind:'Association',properties:{associationFirstEndID:'first-role',associationSecondEndID:'second-role'}};
  assert.deepEqual(associationMarkers(edge,roles,elements),{start:undefined,end:'model-composition'});
  assert.deepEqual(associationMarkers({...edge,properties:{associationFirstEndID:'second-role',associationSecondEndID:'first-role'}},roles,elements),{start:'model-composition',end:undefined});
});
