const state = {
  folderHandle: null,
  source: null,
  records: [],
  groups: [],
  selected: new Set(),
  scanning: false,
  toastTimer: null,
};

const $ = (id) => document.getElementById(id);
const chooseButton = $('chooseButton');
const folderInput = $('folderInput');
const scanButton = $('scanButton');
const clearButton = $('clearButton');
const deleteButton = $('deleteButton');
const locationText = $('locationText');
const locationDisplay = $('locationDisplay');
const helperText = $('helperText');
const progressWrap = $('progressWrap');
const reportPanel = $('reportPanel');
const groupsList = $('groupsList');
const emptyState = $('emptyState');

const supportsDirectoryPicker = 'showDirectoryPicker' in window;
const HASH_CACHE_DB = 'duplicate-check-cache';
const HASH_CACHE_VERSION = 1;
let hashCacheDbPromise = null;
let pendingCacheWrites = [];

function openHashCache() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!hashCacheDbPromise) {
    hashCacheDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(HASH_CACHE_DB, HASH_CACHE_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('hashes', { keyPath: 'key' });
        store.createIndex('rootId', 'rootId', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return hashCacheDbPromise;
}

async function loadHashCache(rootId) {
  const db = await openHashCache();
  if (!db) return new Map();
  return new Promise((resolve, reject) => {
    const request = db.transaction('hashes', 'readonly').objectStore('hashes').index('rootId').getAll(rootId);
    request.onsuccess = () => resolve(new Map(request.result.map((entry) => [entry.path, entry])));
    request.onerror = () => reject(request.error);
  });
}

function queueHashCacheWrite(entry) {
  pendingCacheWrites.push(entry);
}

async function flushHashCacheWrites() {
  if (!pendingCacheWrites.length) return;
  const db = await openHashCache();
  if (!db) return;
  const writes = pendingCacheWrites.splice(0);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('hashes', 'readwrite');
    const store = transaction.objectStore('hashes');
    writes.forEach((entry) => store.put(entry));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function rootCacheId() {
  const inputRoot = state.inputFiles?.[0]?.webkitRelativePath?.split('/')[0];
  return `${state.source || 'unknown'}:${state.folderHandle?.name || inputRoot || locationText.textContent}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(timestamp));
}

function setToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#ff896f' : '#e8eee9';
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function setProgress(text, percent) {
  $('progressText').textContent = text;
  $('progressPercent').textContent = `${Math.round(percent)}%`;
  $('progressBar').style.width = `${percent}%`;
}

function renderReport({ status, title, detail, filesFound, reusedHashes, hashedCandidates, skippedItems, skippedBranches, issues = [] }) {
  const safeIssues = issues.filter(Boolean);
  reportPanel.hidden = false;
  reportPanel.className = `report-panel status-${status}`;
  $('reportTitle').textContent = title;
  $('reportDetail').textContent = detail;
  $('reportStatus').textContent = status === 'complete' ? 'COMPLETE' : status === 'warning' ? 'PARTIAL' : 'ERROR';
  $('reportFiles').textContent = Number(filesFound || 0).toLocaleString();
  $('reportReused').textContent = Number(reusedHashes || 0).toLocaleString();
  $('reportHashed').textContent = Number(hashedCandidates || 0).toLocaleString();
  $('reportSkipped').textContent = Number(skippedItems || 0).toLocaleString();
  $('reportBranches').textContent = Number(skippedBranches || 0).toLocaleString();
  $('reportIssueCount').textContent = safeIssues.length ? `${safeIssues.length} shown` : '';
  const issueList = $('reportIssueList');
  issueList.innerHTML = '';
  safeIssues.slice(0, 10).forEach((issue) => {
    const item = document.createElement('li');
    item.textContent = issue;
    issueList.appendChild(item);
  });
  $('reportIssues').hidden = safeIssues.length === 0;
}

function setFolderLabel(name, source) {
  locationText.textContent = name;
  locationDisplay.classList.add('selected');
  scanButton.disabled = false;
  helperText.textContent = source === 'picker'
    ? 'Folder access is enabled for this session. You can delete duplicates after reviewing them.'
    : 'Folder selected. Scan results are read-only in this browser fallback; use Choose folder in Chrome or Edge to enable deletion.';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

chooseButton.addEventListener('click', async () => {
  if (supportsDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      state.folderHandle = handle;
      state.source = 'picker';
      setFolderLabel(handle.name, 'picker');
      setToast('Folder ready. Start a scan when you’re ready.');
    } catch (error) {
      if (error.name !== 'AbortError') setToast('Could not open that folder.', true);
    }
  } else {
    folderInput.click();
  }
});

folderInput.addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  state.source = 'input';
  state.folderHandle = null;
  state.inputFiles = files;
  const root = files[0].webkitRelativePath?.split('/')[0] || 'Selected folder';
  setFolderLabel(root, 'input');
});

// A small incremental SHA-256 implementation keeps memory use bounded. The
// previous version called file.arrayBuffer(), which can fail on very large USB
// files because it tries to allocate the whole file at once.
class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.totalBytes = 0;
    this.w = new Uint32Array(64);
  }

  update(data) {
    this.totalBytes += data.length;
    let offset = 0;
    if (this.bufferLength) {
      const needed = 64 - this.bufferLength;
      const copied = Math.min(needed, data.length);
      this.buffer.set(data.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.process(this.buffer);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.process(data.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.length - offset;
    }
    return this;
  }

  process(block) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    for (let i = 0; i < 16; i += 1) this.w[i] = ((block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i += 1) {
      const x = this.w[i - 15];
      const y = this.w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      this.w[i] = (this.w[i - 16] + s0 + this.w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + this.w[i]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
    }
    this.h[0] = (this.h[0] + a) >>> 0; this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0; this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0; this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0; this.h[7] = (this.h[7] + h) >>> 0;
  }

  digest() {
    const bitLength = BigInt(this.totalBytes) * 8n;
    this.buffer[this.bufferLength] = 0x80;
    this.bufferLength += 1;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.process(this.buffer);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    for (let i = 0; i < 8; i += 1) this.buffer[63 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
    this.process(this.buffer);
    return Array.from(this.h, (value) => value.toString(16).padStart(8, '0')).join('');
  }
}

function pauseForUsb() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const QUICK_SAMPLE_BYTES = 64 * 1024;
const FAST_HASH_LIMIT = 64 * 1024 * 1024;

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digestBytes(bytes) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function quickFingerprint(file, progress) {
  let sample;
  if (file.size <= QUICK_SAMPLE_BYTES * 2) {
    sample = new Uint8Array(await file.arrayBuffer());
  } else {
    const first = new Uint8Array(await file.slice(0, QUICK_SAMPLE_BYTES).arrayBuffer());
    const last = new Uint8Array(await file.slice(file.size - QUICK_SAMPLE_BYTES, file.size).arrayBuffer());
    sample = new Uint8Array(first.length + last.length);
    sample.set(first, 0);
    sample.set(last, first.length);
  }
  progress.quickBytes += sample.byteLength;
  progress.quickIndex += 1;
  setProgress(`Quick-checking ${progress.quickIndex} of ${progress.quickCandidates} same-size files…`, 42 + (progress.quickIndex / Math.max(progress.quickCandidates, 1)) * 12);
  await pauseForUsb();
  return digestBytes(sample);
}

async function digest(file, progress) {
  progress.hashIndex += 1;
  // Web Crypto is much faster for ordinary files. Keep the chunked fallback
  // for large files so one huge video/archive never needs a huge allocation.
  if (file.size <= FAST_HASH_LIMIT) {
    const data = new Uint8Array(await file.arrayBuffer());
    progress.hashedBytes += data.byteLength;
    setProgress(`Full-hashing ${progress.hashIndex} of ${progress.fullHashCandidates} files…`, 54 + (progress.hashedBytes / Math.max(progress.hashTotalBytes, 1)) * 41);
    const hash = await digestBytes(data);
    await pauseForUsb();
    return hash;
  }

  const hasher = new Sha256();
  const chunkSize = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer());
    hasher.update(chunk);
    progress.hashedBytes += chunk.byteLength;
    if (progress.hashTotalBytes) {
      setProgress(`Full-hashing ${progress.hashIndex} of ${progress.fullHashCandidates} files…`, 54 + (progress.hashedBytes / progress.hashTotalBytes) * 41);
    }
    // Yield between chunks so the browser stays responsive while reading a USB drive.
    await pauseForUsb();
  }
  return hasher.digest();
}

async function readDirectory(handle, parentPath, records, progress) {
  try {
    for await (const entry of handle.values()) {
      const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        progress.directories += 1;
        await readDirectory(entry, path, records, progress);
        continue;
      }
      try {
        const file = await entry.getFile();
        const record = {
          id: `file-${records.length}`,
          name: entry.name,
          path,
          size: file.size,
          modified: file.lastModified,
          hash: null,
          fileHandle: entry,
          parentHandle: handle,
        };
        const cached = progress.cache.get(path);
        if (cached && cached.size === file.size && cached.modified === file.lastModified && cached.hash) {
          record.hash = cached.hash;
          record.quickHash = cached.quickHash || null;
          record.cached = true;
          progress.reusedHashes += 1;
        }
        records.push(record);
        progress.count += 1;
        if (record.cached) publishPartialResults(records, progress);
        if (progress.count % 25 === 0) {
          setProgress(`Found ${progress.count.toLocaleString()} files…`, Math.min(42, 6 + Math.log10(progress.count + 1) * 14));
          await pauseForUsb();
        }
      } catch (error) {
        progress.skipped += 1;
        progress.skippedExamples.push(path);
      }
    }
  } catch (error) {
    // USB drives often contain folders that disappear or deny access while the
    // drive is being read. Skip that branch and let the rest of the scan finish.
    progress.skippedDirectories += 1;
    progress.skippedExamples.push(parentPath || handle.name || 'selected folder');
  }
}

async function readInputFiles(files, records, progress) {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const path = file.webkitRelativePath || file.name;
    const record = {
      id: `file-${index}`,
      name: file.name,
      path,
      size: file.size,
      modified: file.lastModified,
      hash: null,
      file,
      fileHandle: null,
      parentHandle: null,
    };
    const cached = progress.cache.get(path);
    if (cached && cached.size === file.size && cached.modified === file.lastModified && cached.hash) {
      record.hash = cached.hash;
      record.quickHash = cached.quickHash || null;
      record.cached = true;
      progress.reusedHashes += 1;
    }
    records.push(record);
    if (record.cached) publishPartialResults(records, progress);
    if ((index + 1) % 25 === 0) await pauseForUsb();
  }
}

async function hashPotentialDuplicates(records, progress) {
  const bySize = new Map();
  records.forEach((record) => {
    const key = String(record.size);
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(record);
  });
  const candidates = Array.from(bySize.values()).filter((bucket) => bucket.length > 1).flat();
  progress.quickCandidates = candidates.filter((record) => !record.quickHash).length;
  progress.quickIndex = 0;
  progress.quickBytes = 0;
  progress.hashedCandidates = 0;
  progress.fullHashCandidates = 0;
  progress.hashTotalBytes = 0;
  progress.hashedBytes = 0;
  progress.hashIndex = 0;
  if (!candidates.length) return;

  const byQuickFingerprint = new Map();
  for (const record of candidates) {
    try {
      if (!record.quickHash) {
        const file = record.file || await record.fileHandle.getFile();
        record.file = file;
        record.quickHash = await quickFingerprint(file, progress);
      }
      const key = `${record.size}:${record.quickHash}`;
      if (!byQuickFingerprint.has(key)) byQuickFingerprint.set(key, []);
      byQuickFingerprint.get(key).push(record);
    } catch (error) {
      progress.skipped += 1;
      progress.skippedExamples.push(record.path);
    }
  }

  const fullCandidates = Array.from(byQuickFingerprint.values()).filter((bucket) => bucket.length > 1).flat();
  const newFullCandidates = fullCandidates.filter((record) => !record.hash);
  progress.fullHashCandidates = newFullCandidates.length;
  progress.hashCandidates = newFullCandidates.length;
  progress.hashTotalBytes = newFullCandidates.reduce((total, record) => total + record.size, 0);
  for (const record of newFullCandidates) {
    try {
      record.hash = await digest(record.file, progress);
      progress.hashedCandidates += 1;
      record.cached = false;
      queueHashCacheWrite({
        key: `${progress.rootId}|${record.path}`,
        rootId: progress.rootId,
        path: record.path,
        size: record.size,
        modified: record.modified,
        quickHash: record.quickHash,
        hash: record.hash,
        savedAt: Date.now(),
      });
      publishPartialResults(records, progress);
    } catch (error) {
      progress.skipped += 1;
      progress.skippedExamples.push(record.path);
    }
  }
}

function makeGroups(records) {
  const map = new Map();
  records.forEach((record) => {
    if (!record.hash) return;
    if (!map.has(record.hash)) map.set(record.hash, []);
    map.get(record.hash).push(record);
  });
  return Array.from(map.entries())
    .filter(([, files]) => files.length > 1)
    .map(([hash, files], index) => ({
      id: `group-${index}`,
      hash,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    }));
}

function updateStats() {
  const duplicateRecords = state.groups.flatMap((group) => group.files.slice(1));
  const selectedBytes = duplicateRecords.filter((record) => state.selected.has(record.id)).reduce((total, record) => total + record.size, 0);
  $('filesStat').textContent = state.records.length ? state.records.length.toLocaleString() : '—';
  $('duplicatesStat').textContent = state.groups.length ? duplicateRecords.length.toLocaleString() : '—';
  $('duplicateFoot').textContent = state.groups.length ? `${state.groups.length} matching group${state.groups.length === 1 ? '' : 's'}` : 'waiting for scan';
  $('spaceStat').textContent = state.groups.length ? formatBytes(selectedBytes) : '—';
  $('groupCount').textContent = state.groups.length;
  deleteButton.disabled = state.selected.size === 0 || state.scanning;
}

function publishPartialResults(records, progress, force = false) {
  const nextGroups = makeGroups(records);
  const signature = nextGroups.map((group) => `${group.hash}:${group.files.length}`).join('|');
  const now = performance.now();
  if (!force && signature === progress.lastGroupSignature) return;
  if (!force && now - progress.lastPublishAt < 250) return;
  state.records = records;
  state.groups = nextGroups;
  state.selected.clear();
  state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
  progress.lastGroupSignature = signature;
  progress.lastPublishAt = now;
  renderGroups();
}

function renderGroups() {
  groupsList.innerHTML = '';
  if (!state.groups.length) {
    groupsList.hidden = true;
    emptyState.hidden = false;
    $('emptyTitle').textContent = state.scanning ? 'Scanning for duplicates…' : 'No duplicate groups yet';
    $('emptyCopy').textContent = state.scanning ? 'Results will appear here as files finish their checks.' : 'Select a folder above and start a scan. Identical files will be grouped by content, not just filename.';
    updateStats();
    return;
  }
  emptyState.hidden = true;
  groupsList.hidden = false;
  state.groups.forEach((group, groupIndex) => {
    const duplicateFiles = group.files.slice(1);
    const reclaimable = duplicateFiles.reduce((sum, file) => sum + file.size, 0);
    const card = document.createElement('article');
    card.className = 'group-card';
    card.innerHTML = `
      <div class="group-header">
        <div class="group-title"><strong>Match ${String(groupIndex + 1).padStart(2, '0')}</strong><span class="hash">${group.hash.slice(0, 14)}…</span></div>
        <div class="group-meta">${group.files.length} copies · ${formatBytes(reclaimable)} reclaimable</div>
      </div>
    `;
    group.files.forEach((record, fileIndex) => {
      const isKeep = fileIndex === 0;
      const row = document.createElement('div');
      row.className = `file-row${isKeep ? ' is-keep' : ''}`;
      const hashLabel = record.hash ? `${record.hash.slice(0, 18)}…` : 'hash pending';
      const cachedClass = record.cached ? ' cached' : '';
      row.innerHTML = `
        <input class="file-check" type="checkbox" ${isKeep || state.scanning ? 'disabled' : ''} ${state.selected.has(record.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(record.name)}" />
        <div class="file-main"><span class="file-icon">▧</span><div><div class="file-name" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</div><span class="file-path" title="${escapeHtml(record.path)}">${escapeHtml(record.path)}</span><span class="file-hash${cachedClass}" title="${record.hash || ''}">sha256 ${hashLabel}</span></div></div>
        <span class="file-size">${formatBytes(record.size)}</span>
        <span class="file-date">${formatDate(record.modified)}</span>
        ${isKeep ? '<span class="keep-label">Keep original</span>' : `<button class="delete-one" type="button" ${state.scanning ? 'disabled' : ''}>Delete</button>`}
      `;
      if (!isKeep) {
        const checkbox = row.querySelector('.file-check');
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selected.add(record.id); else state.selected.delete(record.id);
          updateStats();
        });
        row.querySelector('.delete-one').addEventListener('click', () => deleteRecords([record]));
      }
      card.appendChild(row);
    });
    groupsList.appendChild(card);
  });
  updateStats();
}

async function runScan() {
  if (state.scanning) return;
  state.scanning = true;
  state.records = [];
  state.groups = [];
  state.selected.clear();
  clearButton.hidden = true;
  $('liveStatus').hidden = false;
  $('liveStatus').innerHTML = '<i></i> Live results';
  emptyState.hidden = false;
  groupsList.hidden = true;
  progressWrap.hidden = false;
  reportPanel.hidden = true;
  scanButton.disabled = true;
  deleteButton.disabled = true;
  setProgress('Preparing scan…', 4);
  const records = [];
  const progress = { count: 0, skipped: 0, skippedDirectories: 0, skippedExamples: [], directories: 0, quickCandidates: 0, quickIndex: 0, quickBytes: 0, fullHashCandidates: 0, hashCandidates: 0, hashIndex: 0, hashedCandidates: 0, hashTotalBytes: 0, hashedBytes: 0, reusedHashes: 0, cache: new Map(), rootId: rootCacheId(), lastPublishAt: 0, lastGroupSignature: '' };
  try {
    try {
      progress.cache = await loadHashCache(progress.rootId);
    } catch (cacheError) {
      progress.cacheWarning = cacheError?.message || 'Saved hash history was unavailable for this scan.';
    }
    if (state.source === 'picker' && state.folderHandle) await readDirectory(state.folderHandle, '', records, progress);
    if (state.source === 'input') await readInputFiles(state.inputFiles, records, progress);
    state.records = records;
    publishPartialResults(records, progress, true);
    setProgress(`Found ${records.length.toLocaleString()} files. Checking possible duplicates…`, 45);
    await hashPotentialDuplicates(records, progress);
    state.records = records;
    state.groups = makeGroups(records);
    state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
    setProgress(`Scan complete · ${records.length} files checked`, 100);
    publishPartialResults(records, progress, true);
    try {
      await flushHashCacheWrites();
    } catch (cacheError) {
      progress.cacheWarning = cacheError?.message || 'New hashes could not be saved for the next scan.';
    }
    renderGroups();
    clearButton.hidden = false;
    const skipped = progress.skipped + progress.skippedDirectories;
    const filterSummary = `${progress.reusedHashes.toLocaleString()} unchanged hashes were reused. ${progress.quickCandidates ? `${progress.quickCandidates.toLocaleString()} same-size files were quick-checked; ${progress.fullHashCandidates.toLocaleString()} needed full hashing.` : 'No new same-size candidates needed hashing.'}`;
    if (skipped || progress.cacheWarning) {
      helperText.textContent = skipped
        ? `Scan complete. ${skipped.toLocaleString()} file${skipped === 1 ? '' : 's or folder branches'} could not be read and were skipped.`
        : 'Scan complete. The file scan succeeded, but saved hash tracking was unavailable for this run.';
      const issues = progress.skippedExamples.slice(0, 8).map((path) => `Could not read: ${path}`);
      if (progress.skippedExamples.length > 8) issues.push(`…and ${(progress.skippedExamples.length - 8).toLocaleString()} more unreadable item${progress.skippedExamples.length - 8 === 1 ? '' : 's'}.`);
      if (progress.cacheWarning) issues.push(`Hash tracking: ${progress.cacheWarning}`);
      renderReport({
        status: 'warning',
        title: 'Scan completed with warnings',
        detail: `The readable portion of the location was checked. ${filterSummary} Some files or folder branches could not be opened, so duplicate results may be partial. No files were changed during the scan.`,
        filesFound: records.length,
        reusedHashes: progress.reusedHashes,
        hashedCandidates: progress.hashedCandidates,
        skippedItems: progress.skipped,
        skippedBranches: progress.skippedDirectories,
        issues,
      });
      setToast(`${state.groups.length ? `Found ${state.groups.length} duplicate group${state.groups.length === 1 ? '' : 's'}. ` : ''}${skipped} unreadable item${skipped === 1 ? '' : 's'} skipped.`);
    } else {
      renderReport({
        status: 'complete',
        title: 'Scan completed successfully',
        detail: `All readable files were checked for exact content matches. ${filterSummary} No files were changed during the scan.`,
        filesFound: records.length,
        reusedHashes: progress.reusedHashes,
        hashedCandidates: progress.hashedCandidates,
        skippedItems: 0,
        skippedBranches: 0,
      });
      setToast(state.groups.length ? `Found ${state.groups.length} duplicate group${state.groups.length === 1 ? '' : 's'}.` : 'No exact duplicates found. Nice and tidy.');
    }
  } catch (error) {
    console.error('Duplicate scan failed:', error);
    state.records = records;
    state.groups = makeGroups(records);
    state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
    renderGroups();
    const errorName = error?.name ? `${error.name}: ` : '';
    const errorMessage = error?.message || 'The drive stopped responding or access was interrupted.';
    renderReport({
      status: 'error',
      title: 'Scan stopped before completion',
      detail: `${errorName}${errorMessage} Some results may be partial. Reconnect the drive, close other apps using it, and scan again. No files were changed during the scan.`,
      filesFound: records.length,
      reusedHashes: progress.reusedHashes,
      hashedCandidates: progress.hashedCandidates,
      skippedItems: progress.skipped,
      skippedBranches: progress.skippedDirectories,
      issues: [`Error: ${errorName}${errorMessage}`, ...progress.skippedExamples.slice(0, 8).map((path) => `Could not read: ${path}`)],
    });
    clearButton.hidden = false;
    setToast('The scan stopped. See the Scan Report below for details.', true);
  } finally {
    state.scanning = false;
    $('liveStatus').innerHTML = '<i></i> Final results';
    scanButton.disabled = false;
    renderGroups();
    try {
      await flushHashCacheWrites();
    } catch (cacheError) {
      // The scan results remain valid even if the local history cannot be saved.
    }
    updateStats();
    setTimeout(() => { progressWrap.hidden = true; }, 900);
  }
}

async function deleteRecords(records) {
  if (!records.length) return;
  if (!state.folderHandle) {
    setToast('Deletion needs folder permission. Choose the folder with Chrome or Edge, then scan again.', true);
    return;
  }
  const confirmed = window.confirm(`Delete ${records.length} selected duplicate${records.length === 1 ? '' : 's'}? This moves them out of the folder permanently.`);
  if (!confirmed) return;
  let deleted = 0;
  for (const record of records) {
    try {
      await record.parentHandle.removeEntry(record.name);
      state.records = state.records.filter((item) => item.id !== record.id);
      state.selected.delete(record.id);
      deleted += 1;
    } catch (error) {
      setToast(`Could not delete ${record.name}. Check folder permission.`, true);
    }
  }
  state.groups = makeGroups(state.records);
  state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
  renderGroups();
  setToast(deleted ? `${deleted} duplicate${deleted === 1 ? '' : 's'} deleted.` : 'No files were deleted.', deleted === 0);
}

scanButton.addEventListener('click', runScan);
deleteButton.addEventListener('click', () => deleteRecords(state.groups.flatMap((group) => group.files.filter((file) => state.selected.has(file.id)))));
clearButton.addEventListener('click', () => {
  state.records = [];
  state.groups = [];
  state.selected.clear();
  state.inputFiles = [];
  reportPanel.hidden = true;
  $('liveStatus').hidden = true;
  clearButton.hidden = true;
  progressWrap.hidden = true;
  renderGroups();
  setToast('Results cleared. Your folder was not changed.');
});

updateStats();
