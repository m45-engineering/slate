import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';

test('MDZIP saved diagram viewer preserves geometry and opens element details without editing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slate-mdzip-'));
  const file = path.join(dir, 'example.mdzip');
  const zip = new JSZip();
  zip.file('com.nomagic.magicdraw.uml_model.model', `<xmi:XMI xmlns:xmi="http://www.omg.org/spec/XMI/20131001" xmlns:uml="http://www.omg.org/spec/UML/20131001"><uml:Model xmi:id="model" name="Example"><packagedElement xmi:type="uml:Class" xmi:id="part" name="Satellite"/><xmi:Extension><ownedDiagram xmi:id="unsupported" name="Model hierarchy"><DiagramRepresentationObject type="SysML Package Diagram"/></ownedDiagram><ownedDiagram xmi:id="empty" name="Empty blocks"><DiagramRepresentationObject type="SysML Block Definition Diagram"/></ownedDiagram><ownedDiagram xmi:type="uml:Diagram" xmi:id="diagram" name="Satellite structure"><xmi:Extension><DiagramRepresentationObject type="SysML Block Definition Diagram"><binaryObject streamContentID="BINARY-layout"/></DiagramRepresentationObject></xmi:Extension></ownedDiagram></xmi:Extension></uml:Model></xmi:XMI>`);
  zip.file('BINARY-layout', `<mdOwnedViews><mdElement elementClass="Class" xmi:id="shape"><elementID xmi:idref="part"/><geometry>40, 50, 180, 90</geometry></mdElement></mdOwnedViews>`);
  await writeFile(file, await zip.generateAsync({type:'nodebuffer'}));
  const app = await electron.launch({ executablePath: process.env.SLATE_EXECUTABLE || undefined, args: [...(process.env.SLATE_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(dir,'profile')}`, file], env:{...process.env,SLATE_DEV_URL:''} });
  try {
    const page = await app.firstWindow();
    const errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1500,950));
    await expect(page.getByLabel('Read-only model viewer')).toBeVisible();
    const svg = page.getByLabel('Saved diagram');
    await expect(svg).toBeVisible({timeout:30000});
    const navigation = page.getByLabel('Diagram navigation', {exact:true});
    const availableCount = 1;
    await expect(navigation.getByRole('button')).toHaveCount(availableCount);
    await expect(navigation).toContainText(`${availableCount} of ${3} diagrams`);
    await expect(navigation.getByText(/^Model hierarchy$/i)).toBeHidden();
    await page.getByLabel('Find diagram').fill('Model hierarchy');
    await expect(navigation.getByRole('button')).toHaveCount(0);
    await expect(navigation.getByText('No available previews match your search.')).toBeVisible();
    await expect(navigation.getByText(/^Model hierarchy$/i)).toBeVisible();
    await expect(svg).toBeVisible();
    await page.getByLabel('Find diagram').fill('');
    const shape = svg.locator('g[role="button"]').first();
    await expect(svg.locator('title')).toHaveCount(0);
    const box = shape.locator(':scope > .model-shape-box');
    const originalStroke = await box.evaluate(el => getComputedStyle(el).stroke);
    await shape.click();
    await expect(box).toHaveCSS('stroke', originalStroke);
    await expect(box).toHaveCSS('stroke-width', '1px');
    await expect(box).toHaveCSS('fill', 'rgb(244, 244, 244)');
    await expect(shape).toHaveCSS('outline-style', 'none');
    await expect(shape).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(shape).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(shape).toHaveCSS('outline-style', 'none');
    await expect(shape.locator(':scope > .model-shape-box')).toHaveCSS('stroke-dasharray', '3px, 2px');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Model element details', {exact:true}).locator('h2')).toBeVisible();
    const details = page.getByLabel('Model element details', {exact:true});
    const bounds = await details.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    const navWidth = (await navigation.boundingBox())!.width;
    const navigationHandle = page.getByRole('separator', {name:'Resize diagram navigation'});
    const navGrip = (await navigationHandle.boundingBox())!;
    await page.mouse.move(navGrip.x + navGrip.width/2, navGrip.y + navGrip.height/2);
    await page.mouse.down(); await page.mouse.move(navGrip.x + 70, navGrip.y + navGrip.height/2, {steps:10}); await page.mouse.up();
    await expect.poll(async () => (await navigation.boundingBox())!.width).toBeGreaterThan(navWidth + 40);
    const detailsWidth = (await details.boundingBox())!.width;
    const detailsHandle = page.getByRole('separator', {name:'Resize element details'});
    const detailsGrip = (await detailsHandle.boundingBox())!;
    await page.mouse.move(detailsGrip.x + detailsGrip.width/2, detailsGrip.y + detailsGrip.height/2);
    await page.mouse.down(); await page.mouse.move(detailsGrip.x - 70, detailsGrip.y + detailsGrip.height/2, {steps:10}); await page.mouse.up();
    await expect.poll(async () => (await details.boundingBox())!.width).toBeGreaterThan(detailsWidth + 40);
    await detailsHandle.focus(); await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await details.boundingBox())!.width).toBeGreaterThan(detailsWidth + 60);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(700,650));
    await expect(page.locator('.model-panels')).toHaveClass(/is-stacked/);
    await expect(page.getByRole('button', {name:'Close element details'})).toBeInViewport();
    expect(await page.locator('.model-viewer').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1500,950));
    await expect(page.locator('.model-panels')).not.toHaveClass(/is-stacked/);
    await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
    await page.getByLabel('Diagram zoom').selectOption('100');
    const width = await svg.getAttribute('width');
    await page.getByLabel('Diagram zoom').selectOption('150');
    await expect(svg).toHaveAttribute('width', String(Number(width)*1.5));
    await page.getByLabel('Diagram zoom').selectOption('100');
    await expect(svg.locator('rect').first()).toHaveAttribute('x','40');
    await page.getByRole('button', {name:'Close element details'}).click();
    await expect(page.getByLabel('Model element details', {exact:true})).toHaveCount(0);
    await page.getByLabel('Diagram zoom').selectOption('0');
    await expect(svg).toBeVisible();
    expect(await page.locator('.model-canvas-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({path:'tmp/mdzip-validation/viewer.png'});
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});

test('models without available layouts explain the limitation without a dead-end diagram button', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slate-mdzip-unavailable-'));
  const file = path.join(dir, 'packages.mdzip');
  const zip = new JSZip();
  zip.file('com.nomagic.magicdraw.uml_model.model', `<xmi:XMI xmlns:xmi="http://www.omg.org/spec/XMI/20131001" xmlns:uml="http://www.omg.org/spec/UML/20131001"><uml:Model xmi:id="model" name="Example"><xmi:Extension><ownedDiagram xmi:id="d" name="Packages"><DiagramRepresentationObject type="SysML Package Diagram"/></ownedDiagram></xmi:Extension></uml:Model></xmi:XMI>`);
  await writeFile(file, await zip.generateAsync({type:'nodebuffer'}));
  const app = await electron.launch({ executablePath: process.env.SLATE_EXECUTABLE || undefined, args: [...(process.env.SLATE_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(dir,'profile')}`, file], env:{...process.env,SLATE_DEV_URL:''} });
  try {
    const page = await app.firstWindow();
    const navigation = page.getByLabel('Diagram navigation', {exact:true});
    await expect(navigation).toContainText('0 of 1 diagrams');
    await expect(navigation.getByRole('button')).toHaveCount(0);
    await expect(page.getByText('No available preview', {exact:true})).toBeVisible();
    await expect(page.getByLabel('Diagram zoom')).toHaveCount(0);
    await page.getByText('Unavailable previews (1)', {exact:true}).click();
    await expect(navigation.getByText('Packages', {exact:true})).toBeVisible();
  } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});

test('all 98 DellSat diagrams render as layouts, tables, or matrices', async () => {
  test.skip(!process.env.SLATE_MDZIP_SAMPLE, 'Set SLATE_MDZIP_SAMPLE to the local DellSat archive.');
  test.setTimeout(120_000);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slate-all-diagrams-'));
  const app = await electron.launch({ executablePath: process.env.SLATE_EXECUTABLE || undefined, args: [...(process.env.SLATE_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(dir,'profile')}`, process.env.SLATE_MDZIP_SAMPLE!], env:{...process.env,SLATE_DEV_URL:''} });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror',e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1700,1100));
    const nav = page.getByLabel('Diagram navigation', {exact:true});
    await expect(nav).toContainText('98 of 98 diagrams', {timeout:30000});
    await expect(nav.getByRole('button')).toHaveCount(98);
    await expect(nav.getByText(/Unavailable previews/)).toHaveCount(0);
    let diagrams=0,tables=0,emptyCanvases=0;const types = new Set<string>();
    const clipped: string[] = [];
    for(let i=0;i<98;i++) {
      const button=nav.getByRole('button').nth(i);
      const name=await button.locator('span').innerText();
      const type=await button.locator('small').innerText();
      await button.click();
      await expect(page.locator('.model-canvas-area header strong')).toHaveText(name);
      if(type==='Generic Table' || type.endsWith('Matrix')) {
        const table=page.getByRole('table',{name,exact:true});
        await expect(table).toBeVisible();
        expect(await table.locator('tbody tr').count()).toBeGreaterThan(0);
        const counts: Record<string,number>={'Requirements Satisfactions':9,'Structural Allocations Table':27,'Requirements Verifications':3,'Behavioral Allocations Matrix':18};
        await expect(table.locator('tbody tr')).toHaveCount(counts[name]);
        if(type.endsWith('Matrix')) expect(await table.locator('td button').count()).toBe(name==='Requirements Verifications'?3:18);
        if(name==='Requirements Satisfactions') await expect(table).toContainText('P-NF-1');
        await table.getByRole('button').first().click();
        await expect(page.getByLabel('Model element details', {exact:true}).locator('h2')).toBeVisible();
        tables++;
      } else {
        const svg=page.getByLabel('Saved diagram',{exact:true});
        await expect(svg).toBeVisible();
        const shapeCount = await svg.locator('[data-shape-kind]').count();
        expect(shapeCount).toBeGreaterThan(0);
        if (shapeCount === 1) { await expect(page.getByText('This saved canvas contains only a frame.')).toBeVisible(); emptyCanvases++; }
        if(type==='SysML Use Case Diagram') expect(await svg.locator('ellipse').count()).toBeGreaterThan(0);
        if(type==='SysML Sequence Diagram' && shapeCount > 1) {
          expect(await svg.locator('[data-shape-kind="LifeLineLine"] line').count()).toBeGreaterThan(0);
          if (name !== 'Lifelines') expect(await svg.locator('[data-shape-kind="MessageSignature"]').count()).toBeGreaterThan(0);
        }
        if(name==='Copyright, license, & distribution') await expect(svg).toContainText('Delligatti Associates');
        if(name==='Structure of the Hohmann Transfer expression') await expect(page.getByLabel('Constraint expressions')).toContainText('semimajorAxis');
        if(name==='Composition of the Transfer Time Analysis Context') {
          expect(await svg.locator('polyline[marker-end="url(#model-composition)"]').count()).toBeGreaterThan(0);
          await page.screenshot({path:'tmp/mdzip-validation/refined-composition.png'});
        }
        if(name==='Attitude Control Subsystem Classifier Behavior') {
          await expect(svg.locator('[data-shape-kind="Region"]')).toHaveCount(1);
          await expect(svg.locator('[data-shape-kind="State"]')).toHaveCount(7);
          await page.screenshot({path:'tmp/mdzip-validation/refined-nested-state.png'});
        }
        if(name==='DellSat-77 Satellite Structure and Properties') {
          expect(await svg.locator('.model-compartment-title').count()).toBeGreaterThan(0);
          const satellite = svg.getByRole('button', {name:'Inspect DellSat-77 Satellite', exact:true});
          await expect(satellite).toContainText('/mass : kg');
          await expect(satellite).not.toContainText('orbitInclination');
          await page.screenshot({path:'tmp/mdzip-validation/refined-compartments.png'});
        }
        if(name==='Base Metric Suite') await expect(svg).toContainText('BaseMetricSuite');
        clipped.push(...await svg.locator('foreignObject').evaluateAll(nodes => nodes.filter(n => {
          const label = n.firstElementChild as HTMLElement;
          return label && label.scrollHeight > Number(n.getAttribute('height')) + 1;
        }).map(n => (n.textContent || '').slice(0, 160))));
        diagrams++;
      }
      if(!types.has(type)) {
        await page.screenshot({path:`tmp/mdzip-validation/${type.replaceAll(' ','-')}.png`});
        types.add(type);
      }
    }
    expect(diagrams).toBe(94);expect(tables).toBe(4);expect(types.size).toBe(13);expect(emptyCanvases).toBe(13);
    expect(clipped).toEqual([]);
    expect(errors).toEqual([]);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
