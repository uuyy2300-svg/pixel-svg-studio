(() => {
  const $ = (id) => document.getElementById(id);
  const defaults = { colors: 16, contrast: 100, transparent: false, customPalette: null, bevel: false, bevelDepth: 2 };
  const state = { image: null, fileName: '', originalURL: '', grid: [], gridWidth: 0, gridHeight: 0, palette: [], zoom: 1, baseWidth: 0, baseHeight: 0, outputWidth: 512, outputHeight: 512, cellSize: 16, effectiveCellSize: 16, view: 'pixel', settings: { ...defaults }, renderId: 0 };
  const controls = { colors: $('colorsRange'), contrast: $('contrastRange') };
  const outputWidthInput = $('outputWidthInput');
  const cellSizeInput = $('cellSizeInput');
  const canvas = $('previewCanvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  function setRangeProgress(input) {
    const min = Number(input.min), max = Number(input.max), val = Number(input.value);
    input.style.setProperty('--progress', `${((val - min) / (max - min)) * 100}%`);
  }
  function syncLabels() {
    $('colorsValue').textContent = controls.colors.value;
    $('contrastValue').textContent = controls.contrast.value;
    Object.values(controls).forEach(setRangeProgress);
  }
  function announceError(message) {
    const node = $('errorMessage');
    node.textContent = message;
    node.hidden = !message;
  }
  function quantizeColor(r, g, b) {
    const contrast = state.settings.contrast / 100;
    const adjust = (v) => Math.max(0, Math.min(255, Math.round((v - 128) * contrast + 128)));
    return [adjust(r), adjust(g), adjust(b)];
  }
  function rgbToHex([r, g, b]) { return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`; }

  // Median-cut palette retains the visual character of the source far better than per-channel bit truncation.
  function makePalette(samples, wanted) {
    if (!samples.length) return ['#000000'];
    let boxes = [samples];
    while (boxes.length < wanted) {
      let best = -1, bestScore = -1, channel = 0;
      boxes.forEach((box, index) => {
        if (box.length < 2) return;
        const ranges = [0, 1, 2].map(c => {
          const vals = box.map(p => p[c]);
          return Math.max(...vals) - Math.min(...vals);
        });
        const c = ranges.indexOf(Math.max(...ranges));
        const score = ranges[c] * box.length;
        if (score > bestScore) { best = index; bestScore = score; channel = c; }
      });
      if (best < 0) break;
      const ordered = boxes[best].slice().sort((a, b) => a[channel] - b[channel]);
      const half = Math.floor(ordered.length / 2);
      boxes.splice(best, 1, ordered.slice(0, half), ordered.slice(half));
    }
    return boxes.map(box => {
      const total = box.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
      return rgbToHex(total.map(v => v / box.length));
    });
  }
  function makeFrequentPalette(samples, wanted) {
    if (!samples.length) return ['#000000'];
    const counts = new Map();
    for (const pixel of samples) {
      const key = rgbToHex(pixel);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length <= wanted) return sorted.map(([color]) => color);
    const selected = [];
    const remaining = sorted.slice();
    while (selected.length < wanted && remaining.length) {
      let bestIndex = 0, bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const [hex, frequency] = remaining[i];
        const rgb = [1, 3, 5].map(pos => parseInt(hex.slice(pos, pos + 2), 16));
        const nearestDistance = selected.length ? Math.min(...selected.map(color => {
          const other = [1, 3, 5].map(pos => parseInt(color.slice(pos, pos + 2), 16));
          return 2 * (rgb[0] - other[0]) ** 2 + 4 * (rgb[1] - other[1]) ** 2 + 3 * (rgb[2] - other[2]) ** 2;
        })) : 1;
        const score = frequency * Math.max(1, nearestDistance);
        if (score > bestScore) { bestScore = score; bestIndex = i; }
      }
      selected.push(remaining.splice(bestIndex, 1)[0][0]);
    }
    return selected;
  }
  function nearestColor(pixel, palette) {
    let best = palette[0], bestDistance = Infinity;
    for (const color of palette) {
      const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
      const dr = pixel[0] - r, dg = pixel[1] - g, db = pixel[2] - b;
      const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (distance < bestDistance) { best = color; bestDistance = distance; }
    }
    return best;
  }
  function applyPixelBevel(grid, width, height, depth) {
    const total = grid.length, distances = new Uint8Array(total), tones = new Int8Array(total), queue = new Int32Array(total);
    let head = 0, tail = 0;
    const addSeed = (index, tone) => {
      if (grid[index] && distances[index] === 0) { distances[index] = 1; tones[index] = tone; queue[tail++] = index; }
      else if (grid[index] && tone && tones[index] === 0) tones[index] = tone;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!grid[i]) continue;
      let tone = 0;
      if (y === 0 || !grid[i - width]) tone++;
      if (x === 0 || !grid[i - 1]) tone++;
      if (y === height - 1 || !grid[i + width]) tone--;
      if (x === width - 1 || !grid[i + 1]) tone--;
      if (tone) addSeed(i, tone > 0 ? 1 : -1);
    }
    while (head < tail) {
      const i = queue[head++], nextDistance = distances[i] + 1;
      if (nextDistance > depth) continue;
      const x = i % width, y = Math.floor(i / width), neighbors = [];
      if (y > 0) neighbors.push(i - width);
      if (x > 0) neighbors.push(i - 1);
      if (x + 1 < width) neighbors.push(i + 1);
      if (y + 1 < height) neighbors.push(i + width);
      for (const n of neighbors) if (grid[n] && distances[n] === 0) {
        distances[n] = nextDistance; tones[n] = tones[i]; queue[tail++] = n;
      }
    }
    return grid.map((color, i) => {
      if (!color || !distances[i]) return color;
      const rgb = [1, 3, 5].map(pos => parseInt(color.slice(pos, pos + 2), 16));
      const strength = 0.24 * (1 - (distances[i] - 1) / Math.max(1, depth));
      const factor = tones[i] > 0 ? 1 + strength : 1 - strength;
      return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v * factor))).toString(16).padStart(2, '0')).join('');
    });
  }
  function syncPaletteEditor(palette) {
    const container = $('paletteSwatches');
    while (container.children.length < palette.length) {
      const row = document.createElement('label');
      row.className = 'palette-row';
      row.innerHTML = '<span class="palette-index"></span><input class="palette-picker" type="color" aria-label="选择颜色"><input class="palette-hex" type="text" maxlength="7" spellcheck="false" aria-label="颜色十六进制值">';
      const picker = row.querySelector('.palette-picker'), hex = row.querySelector('.palette-hex');
      picker.addEventListener('input', () => updateCustomColor(Number(row.dataset.index), picker.value));
      hex.addEventListener('change', () => {
        const value = hex.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(value)) updateCustomColor(Number(row.dataset.index), value.toLowerCase());
        else hex.value = state.settings.customPalette[Number(row.dataset.index)] || '#000000';
      });
      container.appendChild(row);
    }
    while (container.children.length > palette.length) container.lastElementChild.remove();
    [...container.children].forEach((row, index) => {
      row.dataset.index = index;
      row.querySelector('.palette-index').textContent = `色 ${index + 1}`;
      row.querySelector('.palette-picker').value = palette[index];
      row.querySelector('.palette-hex').value = palette[index].toUpperCase();
    });
  }
  function updateCustomColor(index, value) {
    if (!Array.isArray(state.settings.customPalette)) return;
    state.settings.customPalette[index] = value.toLowerCase();
    render();
  }
  $('restorePaletteButton').addEventListener('click', () => {
    state.settings.customPalette = null;
    $('customPalette').hidden = true;
    render();
  });
  function render() {
    if (!state.image) return;
    const id = ++state.renderId;
    const img = state.image;
    const ratio = img.naturalWidth / img.naturalHeight;
    const svgWidth = state.outputWidth;
    const svgHeight = Math.max(1, Math.round(svgWidth / ratio));
    let cellSize = state.cellSize;
    while (Math.ceil(svgWidth / cellSize) * Math.ceil(svgHeight / cellSize) > 120000) cellSize++;
    const cols = Math.max(1, Math.ceil(svgWidth / cellSize));
    const rows = Math.max(1, Math.ceil(svgHeight / cellSize));
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = cols; sampleCanvas.height = rows;
    const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    sampleCtx.imageSmoothingEnabled = true;
    sampleCtx.imageSmoothingQuality = 'high';
    sampleCtx.drawImage(img, 0, 0, cols, rows);
    const data = sampleCtx.getImageData(0, 0, cols, rows).data;
    const pixels = [];
    const samples = [];
    for (let i = 0; i < data.length; i += 4) {
      const rgb = quantizeColor(data[i], data[i + 1], data[i + 2]);
      const alpha = data[i + 3];
      pixels.push({ rgb, alpha });
      if (alpha > 8) samples.push(rgb);
    }
    const wantedColors = Number(state.settings.colors);
    let paletteSamples = samples;
    if (wantedColors <= 5) {
      const sourceCanvas = document.createElement('canvas');
      const sourceScale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
      sourceCanvas.width = Math.max(1, Math.round(img.naturalWidth * sourceScale));
      sourceCanvas.height = Math.max(1, Math.round(img.naturalHeight * sourceScale));
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      sourceContext.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);
      const sourceData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
      paletteSamples = [];
      for (let i = 0; i < sourceData.length; i += 4) {
        if (sourceData[i + 3] > 8) paletteSamples.push(quantizeColor(sourceData[i], sourceData[i + 1], sourceData[i + 2]));
      }
    }
    const generatedPalette = wantedColors <= 5
      ? makeFrequentPalette(paletteSamples, wantedColors)
      : makePalette(samples, wantedColors);
    $('customPalette').hidden = wantedColors > 5;
    if (wantedColors <= 5 && (!Array.isArray(state.settings.customPalette) || state.settings.customPalette.length !== wantedColors)) state.settings.customPalette = generatedPalette.slice();
    const palette = wantedColors <= 5 ? state.settings.customPalette.slice() : generatedPalette;
    syncPaletteEditor(palette);
    let grid = pixels.map(p => p.alpha < 8 && state.settings.transparent ? null : nearestColor(p.rgb, palette));
    if (state.settings.bevel && state.settings.transparent) grid = applyPixelBevel(grid, cols, rows, state.settings.bevelDepth);
    if (id !== state.renderId) return;
    state.grid = grid; state.gridWidth = cols; state.gridHeight = rows; state.palette = palette;
    canvas.width = cols; canvas.height = rows;
    const imageData = context.createImageData(cols, rows);
    grid.forEach((color, i) => {
      if (!color) { imageData.data[i * 4 + 3] = 0; return; }
      imageData.data[i * 4] = parseInt(color.slice(1, 3), 16);
      imageData.data[i * 4 + 1] = parseInt(color.slice(3, 5), 16);
      imageData.data[i * 4 + 2] = parseInt(color.slice(5, 7), 16);
      imageData.data[i * 4 + 3] = 255;
    });
    context.putImageData(imageData, 0, 0);
    state.outputHeight = svgHeight;
    state.effectiveCellSize = cellSize;
    $('cellInfo').textContent = `${cols} × ${rows} 格 · 单元格 ≥ ${cellSize}px`;
    $('exportSize').textContent = `${svgWidth} × ${svgHeight}px · ${cols} × ${rows} 格`;
    applyZoom();
    $('canvasWrap').classList.toggle('checker', state.settings.transparent && state.view === 'pixel');
    updateView();
  }
  function fitCanvas() {
    if (!state.image) return;
    const stage = $('stage');
    const maxW = Math.max(100, stage.clientWidth - 90);
    const maxH = Math.max(100, stage.clientHeight - 110);
    const ratio = state.image.naturalWidth / state.image.naturalHeight;
    state.baseWidth = Math.min(maxW, maxH * ratio);
    state.baseHeight = state.baseWidth / ratio;
    state.zoom = 1;
    applyZoom();
  }
  function applyZoom() {
    $('canvasWrap').style.width = `${Math.max(1, state.baseWidth * state.zoom)}px`;
    $('canvasWrap').style.height = `${Math.max(1, state.baseHeight * state.zoom)}px`;
    $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  }
  function updateView() {
    if (!state.image) return;
    const original = state.view === 'original';
    $('pixelViewButton').classList.toggle('active', !original);
    $('originalViewButton').classList.toggle('active', original);
    $('pixelViewButton').setAttribute('aria-pressed', String(!original));
    $('originalViewButton').setAttribute('aria-pressed', String(original));
    $('canvasWrap').classList.toggle('original', original);
    if (original && state.originalURL) {
      canvas.width = state.image.naturalWidth; canvas.height = state.image.naturalHeight;
      context.imageSmoothingEnabled = true; context.drawImage(state.image, 0, 0);
    } else if (state.grid.length) {
      canvas.width = state.gridWidth; canvas.height = state.gridHeight;
      const data = context.createImageData(canvas.width, canvas.height);
      state.grid.forEach((color, i) => {
        if (!color) { data.data[i * 4 + 3] = 0; return; }
        data.data[i * 4] = parseInt(color.slice(1, 3), 16);
        data.data[i * 4 + 1] = parseInt(color.slice(3, 5), 16);
        data.data[i * 4 + 2] = parseInt(color.slice(5, 7), 16);
        data.data[i * 4 + 3] = 255;
      });
      context.putImageData(data, 0, 0);
    }
    $('canvasWrap').classList.toggle('checker', state.settings.transparent && !original);
    applyZoom();
  }
  function loadFile(file) {
    if (!file) return;
    announceError('');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { announceError('请选择 PNG、JPG、WEBP 或 GIF 图片。'); return; }
    if (file.size > 20 * 1024 * 1024) { announceError('图片超过 20 MB，请换一张小一些的图片。'); return; }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth * image.naturalHeight > 40000000) { URL.revokeObjectURL(url); announceError('图片像素过大，请先缩小后再上传。'); return; }
      if (state.originalURL) URL.revokeObjectURL(state.originalURL);
      state.originalURL = url; state.image = image; state.fileName = file.name; state.view = 'pixel';
      state.outputWidth = Math.max(16, Math.min(4096, image.naturalWidth));
      state.cellSize = Math.max(1, Math.min(256, Number(cellSizeInput.value) || 16));
      outputWidthInput.value = state.outputWidth;
      $('copyButton').querySelector('span:first-child').textContent = '复制 SVG 代码';
      $('copyStatus').textContent = '无限放大不失真';
      $('emptyState').hidden = true; $('canvasWrap').hidden = false; $('stageFooter').hidden = false;
      $('downloadButton').disabled = false; $('copyButton').disabled = false;
      $('dropTitle').textContent = file.name;
      $('dropSub').textContent = `${Math.round(file.size / 1024)} KB · 点击替换`;
      $('workspaceHeading').textContent = file.name.replace(/\.[^.]+$/, '');
      $('fileDimensions').textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      fitCanvas();
      render();
      URL.revokeObjectURL(url === state.originalURL ? '' : url);
    };
    image.onerror = () => { URL.revokeObjectURL(url); announceError('这张图片无法读取，请换一个文件试试。'); };
    image.src = url;
  }
  function exportSVG() {
    if (!state.grid.length) return;
    const { gridWidth: w, gridHeight: h, grid, effectiveCellSize: cell, outputWidth, outputHeight } = state;
    const rects = [];
    grid.forEach((color, i) => {
      if (!color) return;
      const x = (i % w) * cell, y = Math.floor(i / w) * cell;
      const rectWidth = Math.min(cell, outputWidth - x), rectHeight = Math.min(cell, outputHeight - y);
      rects.push(`<rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" fill="${color}"/>`);
    });
    const background = state.settings.transparent ? '' : `<rect width="${outputWidth}" height="${outputHeight}" fill="#ffffff"/>`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}" shape-rendering="crispEdges">${background}${rects.join('')}</svg>`;
  }
  function downloadSVG() {
    const svg = exportSVG();
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${state.fileName.replace(/\.[^.]+$/, '') || 'pixel-art'}.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copySVG() {
    const svg = exportSVG();
    if (!svg) return;
    const status = $('copyStatus');
    try {
      await navigator.clipboard.writeText(svg);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = svg; textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed'; textarea.style.opacity = '0';
      document.body.appendChild(textarea); textarea.select();
      const copied = document.execCommand('copy'); textarea.remove();
      if (!copied) { status.textContent = '复制失败，请下载 SVG'; return; }
    }
    status.textContent = 'SVG 代码已复制';
    $('copyButton').querySelector('span:first-child').textContent = '已复制';
    setTimeout(() => { status.textContent = '无限放大不失真'; $('copyButton').querySelector('span:first-child').textContent = '复制 SVG 代码'; }, 1800);
  }
  function chooseFile() { $('fileInput').click(); }

  $('dropzone').addEventListener('click', chooseFile);
  $('emptyUploadButton').addEventListener('click', chooseFile);
  $('fileInput').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
  const dropzone = $('dropzone');
  ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, e => { e.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, e => { e.preventDefault(); dropzone.classList.remove('dragging'); }));
  dropzone.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  Object.entries(controls).forEach(([key, input]) => input.addEventListener('input', () => {
    const previous = state.settings[key];
    state.settings[key] = Number(input.value);
    if (key === 'colors' && Number(input.value) !== previous) state.settings.customPalette = null;
    syncLabels(); render();
  }));
  outputWidthInput.addEventListener('change', () => {
    const value = Number.parseInt(outputWidthInput.value, 10);
    state.outputWidth = Math.max(16, Math.min(4096, Number.isFinite(value) ? value : state.outputWidth));
    outputWidthInput.value = state.outputWidth;
    render();
  });
  cellSizeInput.addEventListener('change', () => {
    const value = Number.parseInt(cellSizeInput.value, 10);
    state.cellSize = Math.max(1, Math.min(256, Number.isFinite(value) ? value : state.cellSize));
    cellSizeInput.value = state.cellSize;
    render();
  });
  $('transparentToggle').addEventListener('change', e => { state.settings.transparent = e.target.checked; render(); });
  $('bevelToggle').addEventListener('change', e => {
    state.settings.bevel = e.target.checked;
    $('bevelDepthControl').hidden = !e.target.checked;
    render();
  });
  $('bevelDepthRange').addEventListener('input', e => {
    state.settings.bevelDepth = Number(e.target.value);
    $('bevelDepthValue').textContent = e.target.value;
    setRangeProgress(e.target);
    render();
  });
  $('defaultsButton').addEventListener('click', () => {
    state.settings = { ...defaults };
    controls.colors.value = defaults.colors; controls.contrast.value = defaults.contrast;
    state.cellSize = 16; cellSizeInput.value = 16;
    state.outputWidth = state.image ? Math.max(16, Math.min(4096, state.image.naturalWidth)) : 512;
    outputWidthInput.value = state.outputWidth;
    $('transparentToggle').checked = false; syncLabels(); render();
    $('bevelToggle').checked = false; $('bevelDepthControl').hidden = true;
    $('bevelDepthRange').value = 2; $('bevelDepthValue').textContent = '2'; setRangeProgress($('bevelDepthRange'));
  });
  $('resetButton').addEventListener('click', () => {
    if (state.originalURL) URL.revokeObjectURL(state.originalURL);
    state.image = null; state.originalURL = ''; state.grid = []; state.view = 'pixel'; state.zoom = 1;
    $('fileInput').value = ''; $('dropTitle').textContent = '拖一张图片到这里'; $('dropSub').textContent = '或点击浏览文件，最大 20 MB';
    $('workspaceHeading').textContent = '准备开始'; $('fileDimensions').textContent = '';
    $('emptyState').hidden = false; $('canvasWrap').hidden = true; $('stageFooter').hidden = true; $('downloadButton').disabled = true; $('copyButton').disabled = true;
    $('exportSize').textContent = 'SVG · 矢量格式'; announceError('');
    $('copyButton').querySelector('span:first-child').textContent = '复制 SVG 代码'; $('copyStatus').textContent = '无限放大不失真';
    state.settings = { ...defaults }; controls.colors.value = defaults.colors; controls.contrast.value = defaults.contrast;
    state.outputWidth = 512; state.cellSize = 16; state.outputHeight = 512; state.effectiveCellSize = 16;
    outputWidthInput.value = 512; cellSizeInput.value = 16;
    $('transparentToggle').checked = false; syncLabels();
    $('bevelToggle').checked = false; $('bevelDepthControl').hidden = true;
    $('bevelDepthRange').value = 2; $('bevelDepthValue').textContent = '2'; setRangeProgress($('bevelDepthRange'));
  });
  $('downloadButton').addEventListener('click', downloadSVG);
  $('copyButton').addEventListener('click', copySVG);
  $('pixelViewButton').addEventListener('click', () => { state.view = 'pixel'; updateView(); });
  $('originalViewButton').addEventListener('click', () => { state.view = 'original'; updateView(); });
  $('zoomInButton').addEventListener('click', () => { state.zoom = Math.min(4, state.zoom * 1.2); applyZoom(); });
  $('zoomOutButton').addEventListener('click', () => { state.zoom = Math.max(.2, state.zoom / 1.2); applyZoom(); });
  $('fitButton').addEventListener('click', fitCanvas);
  window.addEventListener('resize', () => { if (state.image) fitCanvas(); });
  syncLabels();
  setRangeProgress($('bevelDepthRange'));
})();
