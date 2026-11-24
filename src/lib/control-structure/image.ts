/** Render the full SVG layout, independent of the viewport's zoom and pan. */
export async function controlDiagramPng(svg: SVGSVGElement): Promise<Blob> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = svg.viewBox.baseVal;
  if (!(width > 0 && height > 0)) throw new Error('The diagram is not ready.');
  const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(32_000_000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  copy.setAttribute('width', String(canvas.width));
  copy.setAttribute('height', String(canvas.height));
  copy.style.maxWidth = 'none';
  copy.style.width = `${canvas.width}px`;
  copy.style.height = `${canvas.height}px`;
  // The app's CSS reset is outside the SVG. Carry its sizing rule into the
  // standalone image so padded HTML labels keep their measured dimensions.
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = '* { box-sizing: border-box; }';
  copy.prepend(style);
  // Selection is an editor affordance, not part of the exported structure.
  for (const selected of copy.querySelectorAll('.is-selected')) selected.classList.remove('is-selected');
  for (const hit of copy.querySelectorAll('.control-connection-hit')) hit.remove();
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  await image.decode();
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image rendering is unavailable.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not render the diagram.')), 'image/png'));
}
