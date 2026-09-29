/* Escáner PWA: procesa códigos de cámara o imágenes en el propio dispositivo. */
const $ = (selector) => document.querySelector(selector);
const refs = {
  startCamera: $('#startCameraButton'), stopCamera: $('#stopCameraButton'), cameraPanel: $('#cameraPanel'),
  cameraVideo: $('#cameraVideo'), cameraStatus: $('#cameraStatus'), fileInput: $('#fileInput'),
  imagePanel: $('#imagePanel'), imageCanvas: $('#imageCanvas'), imageStatus: $('#imageStatus'),
  scanSelection: $('#scanSelectionButton'), scanFullImage: $('#scanFullImageButton'), clearSelection: $('#clearSelectionButton'),
  results: $('#resultsList'), emptyResults: $('#emptyResults'), resultCount: $('#resultCount'),
  clearResults: $('#clearResultsButton'), copyAll: $('#copyAllButton'), share: $('#shareButton'),
  message: $('#appMessage'), resultTemplate: $('#resultTemplate'), install: $('#installButton')
};

let stream;
let cameraLoop;
let imageBitmap;
let selection = null;
let drawing = false;
let drawStart = null;
let deferredInstallPrompt;
let zxingReader;
let ocrWorkerPromise;
let lastOcrDigits = '';
const detectedCodes = new Set();
const formats = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'qr_code', 'data_matrix', 'aztec', 'pdf417'];

function tell(message) { refs.message.textContent = message; }
function now() { return new Intl.DateTimeFormat('es-EC', { hour: '2-digit', minute: '2-digit' }).format(new Date()); }

function addResult(code, source) {
  const value = String(code || '').trim();
  if (!value) return false;
  if (detectedCodes.has(value)) { tell(`El código ${value} ya está en la lista.`); return false; }
  detectedCodes.add(value);
  const item = refs.resultTemplate.content.cloneNode(true);
  item.querySelector('.result-code').textContent = value;
  item.querySelector('.result-meta').textContent = `${source} · ${now()}`;
  item.querySelector('.copy-one-button').addEventListener('click', () => copyText(value, 'Código copiado.'));
  refs.results.prepend(item);
  updateResults();
  tell(`Código detectado: ${value}`);
  if (navigator.vibrate) navigator.vibrate(70);
  return true;
}

function updateResults() {
  const total = detectedCodes.size;
  refs.resultCount.textContent = total;
  refs.emptyResults.classList.toggle('hidden', total > 0);
  refs.copyAll.disabled = total === 0;
  refs.share.disabled = total === 0;
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement('textarea');
    area.value = value; document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
  }
  tell(successMessage);
}

async function detectorForBrowser() {
  if (!('BarcodeDetector' in window)) return null;
  try { return new BarcodeDetector({ formats }); }
  catch { return new BarcodeDetector(); }
}

async function scanSource(source) {
  const detector = await detectorForBrowser();
  if (detector) {
    try {
      const found = await detector.detect(source);
      const accepted = acceptedCodes(found.map(item => item.rawValue));
      if (accepted.length) return accepted;
    } catch (error) { console.warn('BarcodeDetector no pudo procesar la imagen', error); }
  }
  const zxingCodes = acceptedCodes(await scanWithZXing(source, !(source instanceof HTMLVideoElement)));
  if (zxingCodes.length) return zxingCodes;
  // Quagga está especializado en códigos lineales (como Code 128), por lo que
  // suele resolver guías fotografiadas con sombras mejor que un lector genérico.
  if (!(source instanceof HTMLVideoElement)) {
    const quaggaCodes = acceptedCodes(await scanWithQuagga(source));
    if (quaggaCodes.length) return quaggaCodes;
  }
  return [];
}

function createCanvasFromSource(source) {
  const canvas = document.createElement('canvas');
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width || source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height || source.naturalHeight;
  canvas.width = width || 1;
  canvas.height = height || 1;
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function buildScanVariants(source, includeEnhancements) {
  const original = createCanvasFromSource(source);
  // En imágenes completas muy grandes se conserva la memoria del móvil;
  // el tratamiento intensivo se aplica al recorte que el usuario marque.
  if (!includeEnhancements || original.width * original.height > 2000000) return [original];

  const enlarged = document.createElement('canvas');
  enlarged.width = original.width * 2;
  enlarged.height = original.height * 2;
  const enlargedContext = enlarged.getContext('2d');
  enlargedContext.imageSmoothingEnabled = false;
  enlargedContext.drawImage(original, 0, 0, enlarged.width, enlarged.height);

  const pixels = enlargedContext.getImageData(0, 0, enlarged.width, enlarged.height);
  const variants = [original, enlarged];
  // Las fotos de guías suelen tener sombras grises. Estas versiones binarias
  // separan las barras negras del papel sin modificar la imagen del usuario.
  [115, 145, 175].forEach((limit) => {
    const threshold = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    for (let index = 0; index < threshold.data.length; index += 4) {
      const lightness = threshold.data[index] * 0.299 + threshold.data[index + 1] * 0.587 + threshold.data[index + 2] * 0.114;
      const value = lightness < limit ? 0 : 255;
      threshold.data[index] = value;
      threshold.data[index + 1] = value;
      threshold.data[index + 2] = value;
      threshold.data[index + 3] = 255;
    }
    const processed = document.createElement('canvas');
    processed.width = enlarged.width;
    processed.height = enlarged.height;
    processed.getContext('2d').putImageData(threshold, 0, 0);
    variants.push(processed);
  });
  return variants;
}

async function scanWithZXing(source, includeEnhancements) {
  if (!window.ZXingBrowser) return [];
  const variants = buildScanVariants(source, includeEnhancements);
  for (const variant of variants) {
    try {
      zxingReader ||= new ZXingBrowser.BrowserMultiFormatReader();
      const result = await zxingReader.decodeFromImageElement(await canvasToImage(variant));
      if (result?.getText?.()) return [result.getText()];
    } catch { /* El siguiente tratamiento de imagen puede reconocerlo. */ }
  }
  return [];
}

function decodeQuaggaImage(src, locate) {
  return new Promise((resolve) => {
    try {
      window.Quagga.decodeSingle({
        src,
        numOfWorkers: 0,
        locate,
        inputStream: { size: 0 },
        locator: { halfSample: false, patchSize: 'medium' },
        decoder: { readers: ['code_128_reader'] }
      }, (result) => resolve(result?.codeResult?.code ? [result.codeResult.code] : []));
    } catch { resolve([]); }
  });
}

async function scanWithQuagga(source) {
  if (!window.Quagga?.decodeSingle) return [];
  const strips = [source];
  // Al seleccionar la guía completa, el título y los dígitos de debajo
  // añaden trazos verticales. Se prueba además la franja central que contiene
  // solamente las barras, manteniendo sus zonas blancas laterales.
  const original = createCanvasFromSource(source);
  if (original.width > 80 && original.height > 40) {
    const strip = document.createElement('canvas');
    const x = Math.round(original.width * 0.035);
    const y = Math.round(original.height * 0.20);
    const width = Math.round(original.width * 0.93);
    const height = Math.round(original.height * 0.52);
    strip.width = width;
    strip.height = height;
    strip.getContext('2d').drawImage(original, x, y, width, height, 0, 0, width, height);
    strips.push(strip);
  }
  // Primero intenta ubicar el código dentro del recorte; si el usuario ya
  // marcó solo las barras, el segundo intento lo decodifica directamente.
  for (const candidate of strips) {
    for (const variant of buildScanVariants(candidate, true)) {
      const image = variant.toDataURL('image/jpeg', 0.98);
      const located = await decodeQuaggaImage(image, true);
      if (located.length) return located;
      const direct = await decodeQuaggaImage(image, false);
      if (direct.length) return direct;
    }
  }
  return [];
}

function canvasToImage(source) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    if (source instanceof HTMLVideoElement) {
      const frame = document.createElement('canvas');
      frame.width = source.videoWidth || 1280;
      frame.height = source.videoHeight || 720;
      frame.getContext('2d').drawImage(source, 0, 0, frame.width, frame.height);
      image.src = frame.toDataURL('image/png');
    } else {
      image.src = source.toDataURL('image/png');
    }
  });
}

function isValidAccessKey(value) {
  if (!/^\d{49}$/.test(value)) return false;
  let factor = 2;
  let total = 0;
  for (let index = 47; index >= 0; index -= 1) {
    total += Number(value[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  let verifier = 11 - (total % 11);
  if (verifier === 11) verifier = 0;
  if (verifier === 10) verifier = 1;
  return verifier === Number(value[48]);
}

function acceptedCodes(values) {
  return values.map(value => String(value || '').trim()).filter((value) => {
    // Una cadena numérica extensa corresponde a la clave de acceso de Ecuador.
    // Solo se acepta cuando sus 49 dígitos superan el dígito verificador.
    if (/^\d{20,}$/.test(value)) return isValidAccessKey(value);
    return Boolean(value);
  });
}

function captionCanvas(binarize = true) {
  if (!selection || !imageBitmap) return null;
  const sourceWidth = refs.imageCanvas.width;
  const sourceHeight = refs.imageCanvas.height;
  const margin = Math.max(8, Math.round(selection.width * 0.035));
  const x = Math.max(0, Math.round(selection.x - margin));
  // Se toma solo la línea numérica debajo de las barras: leer barras y texto
  // a la vez hace que el OCR interprete patrones verticales como caracteres.
  // La línea numérica comienza justo bajo las barras. Mantener un pequeño
  // borde superior evita cortar la parte alta de los dígitos al seleccionar
  // el bloque completo con el ratón o con el dedo.
  const y = Math.max(0, Math.round(selection.y + selection.height * 0.68));
  const width = Math.min(sourceWidth - x, Math.round(selection.width + margin * 2));
  const height = Math.min(sourceHeight - y, Math.max(42, Math.round(selection.height * 0.5)));
  const canvas = document.createElement('canvas');
  canvas.width = width * 6;
  canvas.height = height * 6;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(imageBitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
  if (binarize) {
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < data.data.length; index += 4) {
      const gray = data.data[index] * 0.299 + data.data[index + 1] * 0.587 + data.data[index + 2] * 0.114;
      const pixel = gray < 205 ? 0 : 255;
      data.data[index] = pixel;
      data.data[index + 1] = pixel;
      data.data[index + 2] = pixel;
    }
    context.putImageData(data, 0, 0);
  }
  return canvas;
}

async function accessKeyFromBrowserText() {
  if (!('TextDetector' in window)) return [];
  try {
    // Chrome puede usar su reconocimiento de texto nativo: es el enfoque más
    // parecido a Lens y funciona especialmente bien con la clave impresa.
    const detector = new TextDetector();
    const blocks = await detector.detect(captionCanvas(false));
    const digits = blocks.map(block => block.rawValue).join('').replace(/\D/g, '');
    lastOcrDigits = digits;
    return isValidAccessKey(digits) ? [digits] : [];
  } catch (error) {
    console.warn('OCR nativo no disponible', error);
    return [];
  }
}

async function accessKeyFromCaption() {
  const nativeCode = await accessKeyFromBrowserText();
  if (nativeCode.length) return nativeCode;
  if (!window.Tesseract?.createWorker) return [];
  const source = captionCanvas();
  if (!source) return [];
  try {
    ocrWorkerPromise ||= (async () => {
      const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
      return worker;
    })();
    const worker = await ocrWorkerPromise;
    const { data } = await worker.recognize(source);
    const digits = (data.text || '').replace(/\D/g, '');
    // Diagnóstico temporal: la interfaz muestra qué devolvió OCR antes de
    // validar el dígito verificador; así se puede ajustar sin aceptar datos
    // incorrectos silenciosamente.
    lastOcrDigits = digits;
    return isValidAccessKey(digits) ? [digits] : [];
  } catch (error) {
    console.warn('OCR de clave de acceso no disponible', error);
    lastOcrDigits = `error de OCR: ${error?.message || 'desconocido'}`;
    ocrWorkerPromise = null;
    return [];
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { tell('Este navegador no permite usar la cámara. Prueba con Chrome o Edge actualizado.'); return; }
  stopCamera();
  refs.cameraPanel.classList.remove('hidden');
  refs.cameraStatus.textContent = 'Solicitando permiso de cámara…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    refs.cameraVideo.srcObject = stream;
    await refs.cameraVideo.play();
    refs.cameraStatus.textContent = 'Apunta el recuadro al código.';
    scanCameraFrame();
  } catch (error) {
    refs.cameraStatus.textContent = 'No fue posible abrir la cámara.';
    tell(error.name === 'NotAllowedError' ? 'Autoriza el permiso de cámara e inténtalo otra vez.' : 'No se encontró una cámara disponible.');
  }
}

async function scanCameraFrame() {
  if (!stream || refs.cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) { cameraLoop = requestAnimationFrame(scanCameraFrame); return; }
  const codes = await scanSource(refs.cameraVideo);
  codes.forEach((code) => addResult(code, 'Cámara'));
  if (stream) cameraLoop = requestAnimationFrame(scanCameraFrame);
}

function stopCamera() {
  if (cameraLoop) cancelAnimationFrame(cameraLoop);
  cameraLoop = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  refs.cameraVideo.srcObject = null;
  refs.cameraPanel.classList.add('hidden');
}

async function loadImage(file) {
  if (!file) return;
  stopCamera();
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    URL.revokeObjectURL(url);
    const limit = 1600;
    const ratio = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    refs.imageCanvas.width = width; refs.imageCanvas.height = height;
    imageBitmap = image;
    selection = null;
    refs.imagePanel.classList.remove('hidden');
    redrawCanvas();
    refs.imageStatus.textContent = 'Imagen cargada. Marca una zona o analiza la imagen completa.';
    tell('Imagen lista para analizar.');
  };
  image.onerror = () => tell('No pude abrir ese archivo. Usa una imagen JPG, PNG, WEBP, GIF o BMP.');
  image.src = url;
}

function redrawCanvas() {
  if (!imageBitmap) return;
  const canvas = refs.imageCanvas;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
  if (selection && selection.width > 2 && selection.height > 2) {
    context.fillStyle = 'rgba(0, 0, 0, .38)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(imageBitmap, selection.x, selection.y, selection.width, selection.height, selection.x, selection.y, selection.width, selection.height);
    context.strokeStyle = '#e8b44f'; context.lineWidth = 3; context.setLineDash([8, 4]);
    context.strokeRect(selection.x, selection.y, selection.width, selection.height); context.setLineDash([]);
  }
}

function canvasPoint(event) {
  const rect = refs.imageCanvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(refs.imageCanvas.width, (event.clientX - rect.left) * refs.imageCanvas.width / rect.width)), y: Math.max(0, Math.min(refs.imageCanvas.height, (event.clientY - rect.top) * refs.imageCanvas.height / rect.height)) };
}

function beginSelection(event) {
  if (!imageBitmap) return;
  event.preventDefault(); refs.imageCanvas.setPointerCapture?.(event.pointerId);
  drawing = true; drawStart = canvasPoint(event); selection = { x: drawStart.x, y: drawStart.y, width: 0, height: 0 };
}
function moveSelection(event) {
  if (!drawing) return;
  const point = canvasPoint(event);
  selection = { x: Math.min(drawStart.x, point.x), y: Math.min(drawStart.y, point.y), width: Math.abs(point.x - drawStart.x), height: Math.abs(point.y - drawStart.y) };
  redrawCanvas();
}
function endSelection() {
  if (!drawing) return;
  drawing = false;
  if (selection.width < 10 || selection.height < 10) selection = null;
  redrawCanvas();
  refs.imageStatus.textContent = selection ? 'Zona seleccionada. Pulsa “Leer selección”.' : 'Selecciona una zona más amplia para analizarla.';
}

async function scanImage(useSelection) {
  if (!imageBitmap) return;
  let source = refs.imageCanvas;
  if (useSelection && selection) {
    const crop = document.createElement('canvas'); crop.width = Math.round(selection.width); crop.height = Math.round(selection.height);
    crop.getContext('2d').drawImage(refs.imageCanvas, selection.x, selection.y, selection.width, selection.height, 0, 0, crop.width, crop.height);
    source = crop;
  }
  refs.imageStatus.textContent = 'Analizando…';
  let codes = await scanSource(source);
  if (!codes.length && useSelection && selection) {
    refs.imageStatus.textContent = 'Leyendo los dígitos impresos como respaldo…';
    codes = await accessKeyFromCaption();
  }
  if (codes.length) {
    codes.forEach(code => addResult(code, useSelection && selection ? 'Selección de imagen' : 'Imagen'));
    refs.imageStatus.textContent = 'Lectura terminada.';
  } else {
    refs.imageStatus.textContent = lastOcrDigits ? `OCR obtuvo: ${lastOcrDigits}` : 'No se encontró un código en esta zona.';
    tell('No detecté un código. Prueba con una imagen más nítida o marca una zona más ajustada.');
  }
}

function shareResults() {
  const text = `Códigos escaneados:\n${[...detectedCodes].join('\n')}`;
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(text)}`;
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) window.open(whatsapp, '_blank', 'noopener');
  else copyText(text, 'Resultados copiados. Puedes pegarlos donde necesites.');
}

refs.startCamera.addEventListener('click', startCamera);
refs.stopCamera.addEventListener('click', stopCamera);
refs.fileInput.addEventListener('change', event => loadImage(event.target.files[0]));
refs.scanSelection.addEventListener('click', () => scanImage(true));
refs.scanFullImage.addEventListener('click', () => scanImage(false));
refs.clearSelection.addEventListener('click', () => { selection = null; redrawCanvas(); refs.imageStatus.textContent = 'Selección eliminada.'; });
refs.imageCanvas.addEventListener('pointerdown', beginSelection);
refs.imageCanvas.addEventListener('pointermove', moveSelection);
refs.imageCanvas.addEventListener('pointerup', endSelection);
refs.imageCanvas.addEventListener('pointercancel', endSelection);
refs.clearResults.addEventListener('click', () => { detectedCodes.clear(); refs.results.replaceChildren(); updateResults(); tell('Resultados eliminados.'); });
refs.copyAll.addEventListener('click', () => copyText([...detectedCodes].join('\n'), 'Resultados copiados.'));
refs.share.addEventListener('click', shareResults);

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt = event; refs.install.classList.remove('hidden'); });
refs.install.addEventListener('click', async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; refs.install.classList.add('hidden'); });
window.addEventListener('appinstalled', () => { refs.install.classList.add('hidden'); tell('La aplicación fue instalada correctamente.'); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
updateResults();

