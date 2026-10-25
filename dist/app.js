const state = {
  folderHandle: null,
  source: null,
  records: [],
  groups: [],
  selected: new Set(),
  originals: new Map(),
  scanning: false,
  viewMode: 'list',
  sortBy: 'name',
  sortDirection: 'asc',
  storage: { folderBytes: null, diskTotalBytes: null, diskFreeBytes: null, error: '' },
  toastTimer: null,
  totalFilesFound: null,
  nativeRoot: '',
};

const $ = (id) => document.getElementById(id);
const chooseButton = $('chooseButton');
const folderInput = $('folderInput');
const scanButton = $('scanButton');
const clearButton = $('clearButton');
const deleteButton = $('deleteButton');
const refreshStorageButton = $('refreshStorageButton');
const locationText = $('locationText');
const locationDisplay = $('locationDisplay');
const helperText = $('helperText');
const progressWrap = $('progressWrap');
const reportPanel = $('reportPanel');
const groupsList = $('groupsList');
const emptyState = $('emptyState');
const nativeStatus = $('nativeStatus');
const cacheStatus = $('cacheStatus');
const clearCacheButton = $('clearCacheButton');
const filtersBar = $('filtersBar');
const typeFilter = $('typeFilter');
const locationFilter = $('locationFilter');
const cacheFilter = $('cacheFilter');
const clearFilters = $('clearFilters');
const sortFilter = $('sortFilter');
const sortDirection = $('sortDirection');
const listViewButton = $('listViewButton');
const treeViewButton = $('treeViewButton');
const selectionToolbar = $('selectionToolbar');
const selectionCount = $('selectionCount');
const selectionSpace = $('selectionSpace');
const selectionScope = $('selectionScope');
const selectAllButton = $('selectAllButton');
const clearSelectionButton = $('clearSelectionButton');
const quickDeleteButton = $('quickDeleteButton');
const selectionPreview = $('selectionPreview');
const selectionPreviewCount = $('selectionPreviewCount');
const selectionPreviewList = $('selectionPreviewList');
const NATIVE_SCANNER_URL = 'http://127.0.0.1:4317';
let nativeAvailable = false;
let nativeStoragePollTimer = null;

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

async function clearBrowserHashCache() {
  pendingCacheWrites = [];
  if (!('indexedDB' in window)) return false;
  const db = hashCacheDbPromise ? await hashCacheDbPromise.catch(() => null) : null;
  db?.close();
  hashCacheDbPromise = null;
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(HASH_CACHE_DB);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error('browser hash cache could not be deleted'));
    request.onblocked = () => reject(new Error('browser hash cache is busy; finish the scan and try again'));
  });
}

async function clearHashCache() {
  if (state.scanning) return;
  const confirmed = window.confirm('Clear saved hash history? The next scan will recheck files instead of reusing cached hashes. Your files will not be changed.');
  if (!confirmed) return;
  clearCacheButton.disabled = true;
  const cleared = [];
  const problems = [];
  try {
    if (await clearBrowserHashCache()) cleared.push('browser');
  } catch (error) {
    problems.push(`browser cache: ${error.message || 'could not clear'}`);
  }
  if (nativeAvailable) {
    try {
      const response = await fetch(`${NATIVE_SCANNER_URL}/cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      if (result.removed) cleared.push('native');
    } catch (error) {
      problems.push(`native cache: ${error.message || 'could not clear'}`);
    }
  }
  clearCacheButton.disabled = state.scanning;
  if (problems.length) {
    cacheStatus.textContent = `Cache cleanup incomplete: ${problems.join('; ')}`;
    setToast(problems.join(' · '), true);
    return;
  }
  cacheStatus.textContent = cleared.length ? 'Hash history cleared. The next scan will perform fresh checks.' : 'No saved hash history was found.';
  setToast(cleared.length ? 'Hash cache cleared. The next scan will recheck files.' : 'No hash cache was found.');
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

function resetStorageStats() {
  state.storage = { folderBytes: null, diskTotalBytes: null, diskFreeBytes: null, error: '' };
}

function storageDetail() {
  const folder = state.storage.folderBytes == null ? 'folder size unavailable' : `${formatBytes(state.storage.folderBytes)} of readable files`;
  const free = state.storage.diskFreeBytes == null
    ? state.storage.error ? `free space unavailable (${state.storage.error})` : 'free space unavailable in browser mode'
    : `${formatBytes(state.storage.diskFreeBytes)} free${state.storage.diskTotalBytes == null ? '' : ` of ${formatBytes(state.storage.diskTotalBytes)}`} on the selected drive`;
  return `Readable folder size: ${folder}. ${free}.`;
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

function stopNativeStoragePolling() {
  if (nativeStoragePollTimer) window.clearInterval(nativeStoragePollTimer);
  nativeStoragePollTimer = null;
}

async function refreshNativeStorage(includeFolder = false) {
  if (!nativeAvailable || state.source !== 'native' || !state.nativeRoot) return;
  try {
    const folderQuery = includeFolder ? '&includeFolder=1' : '';
    const response = await fetch(`${NATIVE_SCANNER_URL}/storage?path=${encodeURIComponent(state.nativeRoot)}${folderQuery}`, { signal: AbortSignal.timeout(includeFolder ? 30000 : 1800) });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    state.storage.diskTotalBytes = result.diskTotalBytes ?? null;
    state.storage.diskFreeBytes = result.diskFreeBytes ?? null;
    if (includeFolder) {
      state.storage.folderBytes = result.folderBytes ?? state.storage.folderBytes;
      state.totalFilesFound = result.filesFound ?? state.totalFilesFound;
    }
    state.storage.error = result.storageError || '';
    updateStats();
    return result;
  } catch (error) {
    state.storage.error = error.message || 'storage information unavailable';
    updateStats();
    return null;
  }
}

function startNativeStoragePolling() {
  stopNativeStoragePolling();
  void refreshNativeStorage();
  nativeStoragePollTimer = window.setInterval(() => { void refreshNativeStorage(); }, 1500);
}

async function calculateBrowserFolderUsage(handle) {
  let folderBytes = 0;
  let filesFound = 0;
  let skipped = 0;
  const visit = async (directory) => {
    try {
      for await (const entry of directory.values()) {
        if (entry.kind === 'directory') {
          await visit(entry);
          continue;
        }
        if (isSystemMetadataFile(entry.name)) continue;
        try {
          const file = await entry.getFile();
          folderBytes += file.size;
          filesFound += 1;
        } catch (error) {
          skipped += 1;
        }
      }
    } catch (error) {
      skipped += 1;
    }
  };
  await visit(handle);
  return { folderBytes, filesFound, skipped };
}

async function refreshStorageSnapshot() {
  if (state.scanning) return;
  if (!state.source) {
    setToast('Choose a folder or drive before refreshing storage.', true);
    return;
  }
  refreshStorageButton.disabled = true;
  refreshStorageButton.innerHTML = '<span class="refresh-icon spinning">↻</span> Refreshing…';
  try {
    if (state.source === 'native') {
      const result = await refreshNativeStorage(true);
      if (!result) throw new Error(state.storage.error || 'native storage information unavailable');
      setToast(result.folderError ? `Storage refreshed, but ${result.folderError}` : 'Drive space and folder size refreshed.');
    } else if (state.source === 'picker' && state.folderHandle) {
      const usage = await calculateBrowserFolderUsage(state.folderHandle);
      state.storage.folderBytes = usage.folderBytes;
      state.totalFilesFound = usage.filesFound;
      state.storage.error = usage.skipped ? `${usage.skipped} item${usage.skipped === 1 ? '' : 's'} could not be read` : '';
      updateStats();
      setToast(usage.skipped ? `Folder size refreshed with ${usage.skipped} unreadable item${usage.skipped === 1 ? '' : 's'}.` : 'Folder size refreshed.');
    } else {
      const files = state.inputFiles || state.records;
      state.storage.folderBytes = files.reduce((total, fileOrRecord) => total + (fileOrRecord.size || 0), 0);
      state.totalFilesFound = files.length;
      state.storage.error = '';
      updateStats();
      setToast('Folder size refreshed from the selected files.');
    }
  } catch (error) {
    setToast(`Could not refresh storage: ${error.message || 'access was interrupted'}`, true);
  } finally {
    refreshStorageButton.disabled = state.scanning || !state.source;
    refreshStorageButton.innerHTML = '<span class="refresh-icon">↻</span> Refresh space';
  }
}

function renderReport({ status, title, detail, filesFound, reusedHashes, hashedCandidates, skippedItems, ignoredSystem, skippedBranches, issues = [] }) {
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
  $('reportIgnored').textContent = Number(ignoredSystem || 0).toLocaleString();
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
  scanButton.innerHTML = source === 'native' ? '<span class="button-icon">⌕</span> Start native scan' : '<span class="button-icon">⌕</span> Start browser scan';
  helperText.textContent = source === 'native'
    ? 'Native scanner selected. Start scan to read this folder or drive with the Go backend.'
    : source === 'picker'
      ? 'Browser folder access is enabled for this session. Use the native helper for very large drives.'
      : 'Folder selected. Browser fallback results are read-only; choose the folder through the native helper for deletion.';
  if (source === 'native') void refreshNativeStorage();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function isSystemMetadataFile(name) {
  const lowerName = name.toLowerCase();
  return name.startsWith('._') || lowerName === '.ds_store' || lowerName === 'thumbs.db' || lowerName === 'desktop.ini';
}

function fileCategory(record) {
  const extension = (record.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const categories = {
    images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'svg'],
    videos: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'mpeg', 'mpg'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'aiff'],
    documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'],
    archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'iso'],
  };
  return Object.entries(categories).find(([, extensions]) => extensions.includes(extension))?.[0] || 'other';
}

function hasActiveFilters() {
  return typeFilter.value !== 'all' || locationFilter.value.trim() || cacheFilter.value !== 'all';
}

function groupSortValue(group) {
  if (state.sortBy === 'reclaimable') return group.files.slice(1).reduce((total, record) => total + record.size, 0);
  if (state.sortBy === 'copies') return group.files.length;
  if (state.sortBy === 'largest') return Math.max(...group.files.map((record) => record.size));
  if (state.sortBy === 'modified') return Math.max(...group.files.map((record) => record.modified || 0));
  if (state.sortBy === 'hash') return group.hash;
  return group.files[0]?.path.toLowerCase() || '';
}

function compareGroups(first, second) {
  const firstValue = groupSortValue(first);
  const secondValue = groupSortValue(second);
  let result = typeof firstValue === 'number' && typeof secondValue === 'number'
    ? firstValue - secondValue
    : String(firstValue).localeCompare(String(secondValue), undefined, { numeric: true, sensitivity: 'base' });
  if (!result) result = first.hash.localeCompare(second.hash);
  return state.sortDirection === 'desc' ? -result : result;
}

function getFilteredGroups() {
  const type = typeFilter.value;
  const location = locationFilter.value.trim().toLowerCase();
  const cacheStatus = cacheFilter.value;
  return state.groups.filter((group) => group.files.some((record) => {
    const matchesType = type === 'all' || fileCategory(record) === type;
    const matchesLocation = !location || `${record.path} ${record.name}`.toLowerCase().includes(location);
    const matchesCache = cacheStatus === 'all' || (cacheStatus === 'cached' ? record.cached : !record.cached);
    return matchesType && matchesLocation && matchesCache;
  })).sort(compareGroups);
}

function getAllDuplicateRecords() {
  return state.groups.flatMap((group) => group.files.slice(1));
}

function getVisibleDuplicateRecords() {
  return getFilteredGroups().flatMap((group) => group.files.slice(1));
}

function getSelectedRecords() {
  const recordsById = new Map(state.records.map((record) => [record.id, record]));
  return Array.from(state.selected).map((id) => recordsById.get(id)).filter(Boolean);
}

function renderSelectionSummary() {
  const allDuplicates = getAllDuplicateRecords();
  const visibleDuplicates = getVisibleDuplicateRecords();
  const selectedRecords = getSelectedRecords();
  const selectedBytes = selectedRecords.reduce((total, record) => total + record.size, 0);
  const visibleSelected = visibleDuplicates.filter((record) => state.selected.has(record.id));
  const allVisibleSelected = visibleDuplicates.length > 0 && visibleSelected.length === visibleDuplicates.length;

  selectionToolbar.hidden = state.groups.length === 0;
  selectionCount.textContent = `${selectedRecords.length.toLocaleString()} selected`;
  selectionSpace.textContent = `${formatBytes(selectedBytes)} to reclaim`;
  selectionScope.textContent = state.groups.length
    ? `${visibleDuplicates.length.toLocaleString()} visible copies · ${allDuplicates.length.toLocaleString()} total copies`
    : '';
  selectAllButton.textContent = allVisibleSelected && visibleDuplicates.length
    ? 'Deselect visible'
    : hasActiveFilters() ? 'Select visible copies' : 'Select all copies';
  selectAllButton.disabled = !visibleDuplicates.length || state.scanning;
  clearSelectionButton.disabled = selectedRecords.length === 0 || state.scanning;
  quickDeleteButton.disabled = selectedRecords.length === 0 || state.scanning;

  selectionPreview.hidden = selectedRecords.length === 0;
  selectionPreviewCount.textContent = `${selectedRecords.length.toLocaleString()} file${selectedRecords.length === 1 ? '' : 's'} · ${formatBytes(selectedBytes)}`;
  selectionPreviewList.innerHTML = '';
  selectedRecords.slice(0, 8).forEach((record) => {
    const item = document.createElement('span');
    item.className = 'selection-preview-item';
    item.title = record.path;
    item.textContent = record.path;
    selectionPreviewList.appendChild(item);
  });
  if (selectedRecords.length > 8) {
    const more = document.createElement('span');
    more.className = 'selection-preview-more';
    more.textContent = `+ ${selectedRecords.length - 8} more`;
    selectionPreviewList.appendChild(more);
  }
}

function selectRecords(records) {
  records.forEach((record) => state.selected.add(record.id));
  renderGroups();
}

function deselectRecords(records) {
  records.forEach((record) => state.selected.delete(record.id));
  renderGroups();
}

function toggleGroupSelection(group) {
  const duplicates = group.files.slice(1);
  if (!duplicates.length) return;
  const shouldSelect = duplicates.some((record) => !state.selected.has(record.id));
  if (shouldSelect) selectRecords(duplicates);
  else deselectRecords(duplicates);
}

async function chooseWithNativePicker() {
  const response = await fetch(`${NATIVE_SCANNER_URL}/pick`);
  if (response.status === 409) {
    setToast('Folder selection cancelled.');
    return true;
  }
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  state.folderHandle = null;
  state.inputFiles = [];
  state.source = 'native';
  resetStorageStats();
  state.nativeRoot = result.path;
  setFolderLabel(result.path, 'native');
  setToast('Native folder ready. Start the scan when you’re ready.');
  return true;
}

chooseButton.addEventListener('click', async () => {
  if (nativeAvailable) {
    try {
      await chooseWithNativePicker();
      return;
    } catch (error) {
      setToast('Native folder picker is unavailable. Using the browser picker instead.', true);
    }
  }
  if (supportsDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      state.folderHandle = handle;
      state.nativeRoot = '';
      state.source = 'picker';
      resetStorageStats();
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
  state.nativeRoot = '';
  state.inputFiles = files;
  resetStorageStats();
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
const LIVE_GROUP_LIMIT = 80;

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
      if (isSystemMetadataFile(entry.name)) {
        progress.ignored += 1;
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
          record.cached = true;
          progress.reusedHashes += 1;
        }
        records.push(record);
        progress.count += 1;
        progress.folderBytes += file.size;
        if (record.cached) publishPartialResults(records, progress);
        if (progress.count % 25 === 0 || performance.now() - progress.lastStoragePaintAt >= 350) {
          progress.lastStoragePaintAt = performance.now();
          state.records = records;
          state.totalFilesFound = progress.count;
          state.storage.folderBytes = progress.folderBytes;
          updateStats();
        }
        if (progress.count % 25 === 0) {
          setProgress(`Found ${progress.count.toLocaleString()} files…`, Math.min(42, 6 + Math.log10(progress.count + 1) * 14));
          await pauseForUsb();
        }
      } catch (error) {
        progress.skipped += 1;
        progress.skippedExamples.push(`${path}: ${error.message || error}`);
      }
    }
  } catch (error) {
    // USB drives often contain folders that disappear or deny access while the
    // drive is being read. Skip that branch and let the rest of the scan finish.
    progress.skippedDirectories += 1;
    progress.skippedExamples.push(`${parentPath || handle.name || 'selected folder'}: ${error.message || error}`);
  }
}

async function readInputFiles(files, records, progress) {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (isSystemMetadataFile(file.name)) {
      progress.ignored += 1;
      continue;
    }
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
      record.cached = true;
      progress.reusedHashes += 1;
    }
    records.push(record);
    progress.count += 1;
    progress.folderBytes += file.size;
    if (record.cached) publishPartialResults(records, progress);
    if (progress.count % 25 === 0 || performance.now() - progress.lastStoragePaintAt >= 350) {
      progress.lastStoragePaintAt = performance.now();
      state.records = records;
      state.totalFilesFound = progress.count;
      state.storage.folderBytes = progress.folderBytes;
      updateStats();
    }
    if (progress.count % 25 === 0) {
      await pauseForUsb();
    }
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
  const quickFailedSizes = new Set();
  const quickErrors = new Map();
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
      quickFailedSizes.add(record.size);
      quickErrors.set(record.id, error);
    }
  }

  const fullCandidateMap = new Map();
  Array.from(byQuickFingerprint.values()).filter((bucket) => bucket.length > 1).flat().forEach((record) => fullCandidateMap.set(record.id, record));
  if (quickFailedSizes.size) {
    candidates.filter((record) => quickFailedSizes.has(record.size)).forEach((record) => fullCandidateMap.set(record.id, record));
  }
  // A quick sample is only an optimization. New files sharing a size with a
  // cached file are full-hashed so they cannot be missed by a sample mismatch.
  const cachedSizes = new Set(candidates.filter((record) => record.hash).map((record) => record.size));
  candidates.filter((record) => !record.hash && cachedSizes.has(record.size)).forEach((record) => fullCandidateMap.set(record.id, record));
  const fullCandidates = Array.from(fullCandidateMap.values());
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
        hash: record.hash,
        savedAt: Date.now(),
      });
      publishPartialResults(records, progress);
    } catch (error) {
      progress.skipped += 1;
      const quickError = quickErrors.get(record.id);
      progress.skippedExamples.push(`${record.path}: ${quickError ? `quick fingerprint failed: ${quickError.message || quickError}; ` : ''}full hash failed: ${error.message || error}`);
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
    .map(([hash, files], index) => {
      const sortedFiles = files.sort((a, b) => a.path.localeCompare(b.path));
      const originalId = state.originals.get(hash);
      let originalReason = 'earliest modified';
      if (originalId) {
        const originalIndex = sortedFiles.findIndex((record) => record.id === originalId);
        if (originalIndex >= 0) {
          const [original] = sortedFiles.splice(originalIndex, 1);
          sortedFiles.unshift(original);
          originalReason = 'chosen by you';
        }
      }
      if (!originalId || originalReason !== 'chosen by you') {
        const choice = chooseOriginal(sortedFiles);
        const choiceIndex = sortedFiles.findIndex((record) => record.id === choice.record.id);
        if (choiceIndex > 0) {
          const [original] = sortedFiles.splice(choiceIndex, 1);
          sortedFiles.unshift(original);
        }
        originalReason = choice.reason;
      }
      return { id: `group-${index}`, hash, files: sortedFiles, originalReason };
    });
}

function analyzeDuplicateName(record) {
  const name = record.name || record.path.split(/[\\/]/).pop() || '';
  const extensionIndex = name.lastIndexOf('.');
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const patterns = [
    { regex: /\s*\(\s*(\d+)\s*\)$/i, kind: 'numbered copy' },
    { regex: /(?:\s+|[-_]\s*)copy(?:\s*\(\s*(\d+)\s*\)|\s+(\d+))?$/i, kind: 'copy suffix' },
    { regex: /\s+(\d+)$/i, kind: 'numbered copy' },
  ];
  for (const pattern of patterns) {
    const match = stem.match(pattern.regex);
    if (!match) continue;
    const base = stem.slice(0, match.index).trim();
    if (!base) continue;
    const number = Number(match.slice(1).find(Boolean) || 1);
    return { base: base.replace(/[\s_-]+/g, ' ').toLowerCase(), hasSuffix: true, rank: number, kind: pattern.kind };
  }
  const copyOf = stem.match(/^copy\s+of\s+(.+)$/i);
  if (copyOf) return { base: copyOf[1].replace(/[\s_-]+/g, ' ').toLowerCase(), hasSuffix: true, rank: 1, kind: 'copy prefix' };
  return { base: stem.replace(/[\s_-]+/g, ' ').toLowerCase(), hasSuffix: false, rank: 0, kind: 'clean filename' };
}

function chooseOriginal(files) {
  const analyzed = files.map((record) => ({ record, analysis: analyzeDuplicateName(record) }));
  const familyCounts = new Map();
  analyzed.forEach(({ analysis }) => familyCounts.set(analysis.base, (familyCounts.get(analysis.base) || 0) + 1));
  analyzed.sort((first, second) => {
    const firstVariant = first.analysis.hasSuffix && familyCounts.get(first.analysis.base) > 1;
    const secondVariant = second.analysis.hasSuffix && familyCounts.get(second.analysis.base) > 1;
    if (firstVariant !== secondVariant) return firstVariant ? 1 : -1;
    if (firstVariant && first.analysis.rank !== second.analysis.rank) return first.analysis.rank - second.analysis.rank;
    const firstModified = first.record.modified || Number.MAX_SAFE_INTEGER;
    const secondModified = second.record.modified || Number.MAX_SAFE_INTEGER;
    if (firstModified !== secondModified) return firstModified - secondModified;
    const firstDepth = first.record.path.split(/[\\/]/).length;
    const secondDepth = second.record.path.split(/[\\/]/).length;
    if (firstDepth !== secondDepth) return firstDepth - secondDepth;
    return first.record.path.localeCompare(second.record.path, undefined, { numeric: true, sensitivity: 'base' });
  });
  const chosen = analyzed[0];
  const familyHasCleanName = familyCounts.get(chosen.analysis.base) > 1 && !chosen.analysis.hasSuffix;
  return {
    record: chosen.record,
    reason: familyHasCleanName ? 'clean filename' : chosen.analysis.hasSuffix ? chosen.analysis.kind : 'earliest modified',
  };
}

function updateStats() {
  const visibleGroups = getFilteredGroups();
  const duplicateRecords = visibleGroups.flatMap((group) => group.files.slice(1));
  const selectedBytes = getSelectedRecords().reduce((total, record) => total + record.size, 0);
  const filesFound = state.totalFilesFound ?? state.records.length;
  const folderBytes = state.storage.folderBytes ?? (state.source && state.source !== 'native' ? state.records.reduce((total, record) => total + record.size, 0) : null);
  $('filesStat').textContent = filesFound ? filesFound.toLocaleString() : '—';
  $('folderSizeStat').textContent = folderBytes == null ? (state.scanning && state.source === 'native' ? '…' : '—') : formatBytes(folderBytes);
  $('folderSizeFoot').textContent = state.scanning ? 'updating live' : folderBytes == null ? 'after scan' : 'readable files';
  $('freeSpaceStat').textContent = state.storage.diskFreeBytes == null
    ? (state.storage.error ? 'N/A' : state.source === 'input' || state.source === 'picker' ? 'N/A' : '—')
    : formatBytes(state.storage.diskFreeBytes);
  $('freeSpaceFoot').textContent = state.scanning && state.source === 'native'
    ? 'refreshing live'
    : state.storage.diskFreeBytes == null
    ? (state.storage.error ? 'storage info unavailable' : state.source ? 'browser mode' : 'selected drive')
    : state.storage.diskTotalBytes == null ? 'available on selected drive' : `available of ${formatBytes(state.storage.diskTotalBytes)}`;
  $('duplicatesStat').textContent = state.groups.length ? duplicateRecords.length.toLocaleString() : '—';
  $('duplicateFoot').textContent = state.groups.length ? `${visibleGroups.length}${hasActiveFilters() ? ` of ${state.groups.length}` : ''} matching group${visibleGroups.length === 1 ? '' : 's'}` : 'waiting for scan';
  $('spaceStat').textContent = state.groups.length ? formatBytes(selectedBytes) : '—';
  $('groupCount').textContent = hasActiveFilters() ? `${visibleGroups.length}/${state.groups.length}` : state.groups.length;
  $('filterSummary').textContent = state.groups.length ? `${visibleGroups.length} of ${state.groups.length} groups` : '';
  deleteButton.disabled = getSelectedRecords().length === 0 || state.scanning;
  clearCacheButton.disabled = state.scanning;
  refreshStorageButton.disabled = state.scanning || !state.source;
  renderSelectionSummary();
}

function publishPartialResults(records, progress, force = false) {
  const now = performance.now();
  if (!force && now - progress.lastPublishAt < 250) return;
  const nextGroups = makeGroups(records);
  const signature = nextGroups.map((group) => `${group.hash}:${group.files.length}`).join('|');
  if (!force && signature === progress.lastGroupSignature) return;
  state.records = records;
  state.groups = nextGroups;
  state.selected.clear();
  state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
  progress.lastGroupSignature = signature;
  progress.lastPublishAt = now;
  renderGroups();
}

async function openRecord(record) {
  let openedTab = null;
  let objectUrl = '';
  try {
    openedTab = window.open('about:blank', '_blank');
    if (!openedTab) throw new Error('The browser blocked the new tab. Allow pop-ups for this app.');
    if (state.source === 'native') {
      openedTab.location.href = `${NATIVE_SCANNER_URL}/file?path=${encodeURIComponent(record.absolutePath)}`;
      setToast(`Opened ${record.name} in a new tab.`);
      return;
    }
    const file = record.file || await record.fileHandle.getFile();
    objectUrl = URL.createObjectURL(file);
    openedTab.location.href = objectUrl;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    setToast(`Opened ${record.name} in a new tab.`);
  } catch (error) {
    if (openedTab && !openedTab.closed) openedTab.close();
    setToast(`Could not open ${record.name}: ${error.message || 'file access failed'}`, true);
  }
}

async function openNativeRecord(record) {
  try {
    const response = await fetch(`${NATIVE_SCANNER_URL}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: record.absolutePath }),
    });
    if (!response.ok) throw new Error(await response.text());
    setToast(`Opened ${record.name} in the native app.`);
  } catch (error) {
    setToast(`Could not open ${record.name} in the native app: ${error.message || 'native open failed'}`, true);
  }
}

function createFileRow(record, isKeep, keepReason = '') {
  const row = document.createElement('div');
  row.className = `file-row${isKeep ? ' is-keep' : ''}`;
  const hashLabel = record.hash ? `${record.hash.slice(0, 18)}…` : 'hash pending';
  const cachedClass = record.cached ? ' cached' : '';
  row.innerHTML = `
    <input class="file-check" type="checkbox" ${isKeep || state.scanning ? 'disabled' : ''} ${state.selected.has(record.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(record.name)}" />
    <div class="file-main"><span class="file-icon">▧</span><div><div class="file-name" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</div><span class="file-path" title="${escapeHtml(record.path)}">${escapeHtml(record.path)}</span><span class="file-hash${cachedClass}" title="${record.hash || ''}">sha256 ${hashLabel}</span></div></div>
    <span class="file-size">${formatBytes(record.size)}</span>
    <span class="file-date">${formatDate(record.modified)}</span>
    <div class="file-actions"><button class="open-one" type="button" aria-label="Open ${escapeHtml(record.name)} in a new tab" ${state.scanning && state.source === 'native' ? 'disabled' : ''}>Open tab</button>${state.source === 'native' ? `<button class="open-native" type="button" aria-label="Open ${escapeHtml(record.name)} in the native app" ${state.scanning ? 'disabled' : ''}>Open app</button>` : ''}${isKeep ? `<span class="keep-label" title="${escapeHtml(keepReason || 'Smart filename and timestamp match')}">Keep original</span>` : `<button class="set-original" type="button" aria-label="Set ${escapeHtml(record.name)} as original" ${state.scanning ? 'disabled' : ''}>Set original</button><button class="delete-one" type="button" ${state.scanning ? 'disabled' : ''}>Delete</button>`}</div>
  `;
  row.querySelector('.open-one').addEventListener('click', () => openRecord(record));
  row.querySelector('.open-native')?.addEventListener('click', () => openNativeRecord(record));
  if (!isKeep) {
    const checkbox = row.querySelector('.file-check');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(record.id); else state.selected.delete(record.id);
      renderGroups();
    });
    row.querySelector('.set-original').addEventListener('click', () => setOriginalForRecord(record));
    row.querySelector('.delete-one').addEventListener('click', () => deleteRecords([record]));
  }
  return row;
}

function setOriginalForRecord(record) {
  const group = state.groups.find((candidate) => candidate.hash === record.hash);
  if (!group || group.files[0]?.id === record.id) return;
  state.originals.set(group.hash, record.id);
  group.files = [record, ...group.files.filter((item) => item.id !== record.id)];
  group.originalReason = 'chosen by you';
  group.files.forEach((item) => state.selected.delete(item.id));
  group.files.slice(1).forEach((item) => state.selected.add(item.id));
  renderGroups();
  setToast(`${record.name} is now the original. Other copies remain selected for deletion.`);
}

function compareTreeRecords(first, second) {
  let result = 0;
  if (state.sortBy === 'largest') result = first.size - second.size;
  else if (state.sortBy === 'modified') result = (first.modified || 0) - (second.modified || 0);
  else if (state.sortBy === 'hash') result = String(first.hash || '').localeCompare(String(second.hash || ''));
  else result = first.path.localeCompare(second.path, undefined, { numeric: true, sensitivity: 'base' });
  if (!result) result = first.path.localeCompare(second.path, undefined, { numeric: true, sensitivity: 'base' });
  return state.sortDirection === 'desc' ? -result : result;
}

function renderTreeView(visibleGroups, totalGroups = visibleGroups.length) {
  const root = { name: 'Selected location', children: new Map(), files: [] };
  visibleGroups.forEach((group, groupIndex) => {
    group.files.forEach((record, fileIndex) => {
      const parts = record.path.split(/[\\/]/).filter(Boolean);
      const fileName = parts.pop() || record.name;
      let node = root;
      parts.forEach((part) => {
        if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), files: [] });
        node = node.children.get(part);
      });
      node.files.push({ record: { ...record, name: fileName }, isKeep: fileIndex === 0, groupIndex, originalReason: group.originalReason });
    });
  });

  const renderNode = (node, container, isRoot = false) => {
    if (isRoot) {
      const rootLabel = document.createElement('div');
      rootLabel.className = 'tree-root-label';
      rootLabel.innerHTML = `<span class="tree-folder-icon">⌂</span><strong>${escapeHtml(node.name)}</strong><span class="tree-count">${visibleGroups.length}${totalGroups > visibleGroups.length ? ` of ${totalGroups}` : ''} duplicate groups</span>`;
      container.appendChild(rootLabel);
    }
    Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name)).forEach((child) => {
      const details = document.createElement('details');
      details.className = 'tree-node';
      details.open = true;
      const summary = document.createElement('summary');
      const fileCount = child.files.length;
      const childCount = child.children.size;
      summary.innerHTML = `<span class="tree-folder-icon">⌂</span><span class="tree-folder-name">${escapeHtml(child.name)}</span><span class="tree-count">${fileCount + childCount} item${fileCount + childCount === 1 ? '' : 's'}</span>`;
      const branch = document.createElement('div');
      branch.className = 'tree-branch';
      details.append(summary, branch);
      container.appendChild(details);
      renderNode(child, branch);
    });
    node.files.sort((a, b) => compareTreeRecords(a.record, b.record)).forEach(({ record, isKeep, groupIndex, originalReason }) => {
      const row = createFileRow(record, isKeep, originalReason);
      row.classList.add('tree-file-row');
      const match = document.createElement('span');
      match.className = 'tree-match';
      match.textContent = `M${String(groupIndex + 1).padStart(2, '0')}`;
      row.querySelector('.file-main').prepend(match);
      container.appendChild(row);
    });
  };

  renderNode(root, groupsList, true);
}

function renderGroups() {
  groupsList.innerHTML = '';
  groupsList.classList.toggle('tree-results', state.viewMode === 'tree');
  const visibleGroups = getFilteredGroups();
  filtersBar.hidden = state.groups.length === 0;
  if (!state.groups.length || !visibleGroups.length) {
    groupsList.hidden = true;
    emptyState.hidden = false;
    $('emptyTitle').textContent = !state.groups.length && state.scanning ? 'Scanning for duplicates…' : !state.groups.length ? 'No duplicate groups yet' : 'No groups match these filters';
    $('emptyCopy').textContent = !state.groups.length && state.scanning ? 'Results will appear here as files finish their checks.' : !state.groups.length ? 'Select a folder above and start a scan. Identical files will be grouped by content, not just filename.' : 'Try clearing a filter or searching for another folder, filename, or file type.';
    updateStats();
    return;
  }
  emptyState.hidden = true;
  groupsList.hidden = false;
  const renderedGroups = state.scanning ? visibleGroups.slice(0, LIVE_GROUP_LIMIT) : visibleGroups;
  if (renderedGroups.length < visibleGroups.length) {
    const note = document.createElement('div');
    note.className = 'live-preview-note';
    note.textContent = `Live preview: showing ${renderedGroups.length} of ${visibleGroups.length} groups. The complete result will appear when the scan finishes.`;
    groupsList.appendChild(note);
  }
  if (state.viewMode === 'tree') {
    renderTreeView(renderedGroups, visibleGroups.length);
  } else {
    renderedGroups.forEach((group, groupIndex) => {
      const duplicateFiles = group.files.slice(1);
      const reclaimable = duplicateFiles.reduce((sum, file) => sum + file.size, 0);
      const card = document.createElement('article');
      card.className = 'group-card';
      card.innerHTML = `
        <div class="group-header">
          <div class="group-title"><strong>Match ${String(groupIndex + 1).padStart(2, '0')}</strong><span class="hash">${group.hash.slice(0, 14)}…</span></div>
          <div class="group-header-right"><div class="group-meta">${group.files.length} copies · ${formatBytes(reclaimable)} reclaimable · keep: ${escapeHtml(group.originalReason || 'smart match')}</div><button class="group-select" type="button">Select copies</button></div>
        </div>
      `;
      const groupSelect = card.querySelector('.group-select');
      const groupDuplicates = group.files.slice(1);
      const groupFullySelected = groupDuplicates.length > 0 && groupDuplicates.every((record) => state.selected.has(record.id));
      groupSelect.textContent = groupFullySelected ? 'Deselect copies' : 'Select copies';
      groupSelect.disabled = state.scanning;
      groupSelect.addEventListener('click', () => toggleGroupSelection(group));
      group.files.forEach((record, fileIndex) => card.appendChild(createFileRow(record, fileIndex === 0, group.originalReason)));
      groupsList.appendChild(card);
    });
  }
  updateStats();
}

async function runScan() {
  if (state.scanning) return;
  state.scanning = true;
  state.records = [];
  state.groups = [];
  state.selected.clear();
  state.originals.clear();
  state.totalFilesFound = null;
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
  const progress = { count: 0, folderBytes: 0, lastStoragePaintAt: 0, skipped: 0, ignored: 0, skippedDirectories: 0, skippedExamples: [], directories: 0, quickCandidates: 0, quickIndex: 0, quickBytes: 0, fullHashCandidates: 0, hashCandidates: 0, hashIndex: 0, hashedCandidates: 0, hashTotalBytes: 0, hashedBytes: 0, cache: new Map(), rootId: rootCacheId(), lastPublishAt: 0, lastGroupSignature: '' };
  try {
    try {
      progress.cache = await loadHashCache(progress.rootId);
    } catch (cacheError) {
      progress.cacheWarning = cacheError?.message || 'Saved hash history was unavailable for this scan.';
    }
    if (state.source === 'picker' && state.folderHandle) await readDirectory(state.folderHandle, '', records, progress);
    if (state.source === 'input') await readInputFiles(state.inputFiles, records, progress);
    state.storage.folderBytes = records.reduce((total, record) => total + record.size, 0);
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
    const filterSummary = `${progress.reusedHashes.toLocaleString()} unchanged hashes were reused. ${progress.quickCandidates ? `${progress.quickCandidates.toLocaleString()} same-size files were quick-checked; ${progress.fullHashCandidates.toLocaleString()} needed full hashing.` : 'No new same-size candidates needed hashing.'}${progress.ignored ? ` ${progress.ignored.toLocaleString()} OS metadata files were ignored.` : ''}`;
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
        detail: `The readable portion of the location was checked. ${storageDetail()} ${filterSummary} Some files or folder branches could not be opened, so duplicate results may be partial. No files were changed during the scan.`,
        filesFound: records.length,
        reusedHashes: progress.reusedHashes,
        hashedCandidates: progress.hashedCandidates,
        skippedItems: progress.skipped,
        ignoredSystem: progress.ignored,
        skippedBranches: progress.skippedDirectories,
        issues,
      });
      setToast(`${state.groups.length ? `Found ${state.groups.length} duplicate group${state.groups.length === 1 ? '' : 's'}. ` : ''}${skipped} unreadable item${skipped === 1 ? '' : 's'} skipped.`);
    } else {
      renderReport({
        status: 'complete',
        title: 'Scan completed successfully',
        detail: `All readable files were checked for exact content matches. ${storageDetail()} ${filterSummary} No files were changed during the scan.`,
        filesFound: records.length,
        reusedHashes: progress.reusedHashes,
        hashedCandidates: progress.hashedCandidates,
        skippedItems: 0,
        ignoredSystem: progress.ignored,
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
      ignoredSystem: progress.ignored,
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

function nativeRecordFromEvent(event) {
  return {
    id: `native:${event.absolutePath}`,
    name: event.path.split('/').pop() || event.path,
    path: event.path,
    absolutePath: event.absolutePath,
    size: event.size,
    modified: event.modified,
    hash: event.hash,
    quickHash: null,
    cached: Boolean(event.cached),
    fileHandle: null,
    parentHandle: null,
  };
}

async function runNativeScan() {
  const requestedPath = state.nativeRoot.trim();
  if (!requestedPath) {
    setToast('Choose a folder or drive first.', true);
    return;
  }
  if (state.scanning) return;
  state.source = 'native';
  state.folderHandle = null;
  resetStorageStats();
  state.totalFilesFound = null;
  state.scanning = true;
  state.records = [];
  state.groups = [];
  state.storage.folderBytes = 0;
  state.selected.clear();
  state.originals.clear();
  state.nativeRecords = new Map();
  clearButton.hidden = true;
  locationText.textContent = requestedPath;
  locationDisplay.classList.add('selected');
  helperText.textContent = 'The native scanner is reading the drive directly. Duplicate groups will appear as soon as hashes arrive.';
  $('liveStatus').hidden = false;
  $('liveStatus').innerHTML = '<i></i> Live native results';
  emptyState.hidden = false;
  groupsList.hidden = true;
  progressWrap.hidden = false;
  reportPanel.hidden = true;
  scanButton.disabled = true;
  deleteButton.disabled = true;
  nativeStatus.textContent = 'Scanning…';
  nativeStatus.className = 'native-status connected';
  startNativeStoragePolling();
  setProgress('Connecting to native scanner…', 3);

  const records = [];
  const progress = { lastPublishAt: 0, lastGroupSignature: '', lastProgressPaintAt: 0, skipped: 0, ignored: 0, skippedExamples: [], reusedHashes: 0, quickCandidates: 0, fullHashCandidates: 0, hashedCandidates: 0 };
  let doneEvent = null;
  try {
    const response = await fetch(`${NATIVE_SCANNER_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: requestedPath }),
    });
    if (!response.ok || !response.body) {
      const message = await response.text();
      throw new Error(message || `Native scanner returned HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handleEvent = (event) => {
      if (event.type === 'start') {
        setProgress('Native scan started…', 5);
      } else if (event.type === 'file') {
        const record = nativeRecordFromEvent(event);
        const existing = state.nativeRecords.get(record.id);
        if (!existing) {
          state.nativeRecords.set(record.id, record);
          records.push(record);
        } else {
          Object.assign(existing, record);
        }
        publishPartialResults(records, progress);
      } else if (event.type === 'progress') {
        const phaseLabel = event.phase === 'quick' ? 'Quick-checking' : 'Full-hashing';
        const base = event.phase === 'quick' ? 8 : 52;
        const range = event.phase === 'quick' ? 40 : 43;
        const now = performance.now();
        if (now - progress.lastProgressPaintAt >= 100 || event.current === event.total) {
          setProgress(`${phaseLabel} ${event.current || 0} of ${event.total || 0}…`, base + ((event.current || 0) / Math.max(event.total || 1, 1)) * range);
          progress.lastProgressPaintAt = now;
        }
      } else if (event.type === 'storage') {
        state.storage.folderBytes = event.folderBytes ?? state.storage.folderBytes;
        state.storage.diskTotalBytes = event.diskTotalBytes ?? state.storage.diskTotalBytes;
        state.storage.diskFreeBytes = event.diskFreeBytes ?? state.storage.diskFreeBytes;
        state.storage.error = event.storageError || '';
        if (event.filesFound != null) state.totalFilesFound = event.filesFound;
        updateStats();
      } else if (event.type === 'warning') {
        progress.skipped += 1;
        progress.skippedExamples.push(event.path ? `${event.path}: ${event.message}` : event.message);
      } else if (event.type === 'done') {
        doneEvent = event;
      }
    };
    const processEventLines = async (lines) => {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        try { handleEvent(JSON.parse(line)); } catch (parseError) { progress.skipped += 1; progress.skippedExamples.push(`Invalid native scanner event: ${parseError.message}`); }
        if (index > 0 && index % 100 === 0) await pauseForUsb();
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      await processEventLines(lines);
      if (done) break;
    }
    if (buffer.trim()) handleEvent(JSON.parse(buffer));
    if (!doneEvent) throw new Error('Native scanner ended before sending a completion report.');
    progress.reusedHashes = doneEvent.reusedHashes || 0;
    progress.quickCandidates = doneEvent.quickCandidates || 0;
    progress.fullHashCandidates = doneEvent.fullCandidates || 0;
    progress.hashedCandidates = doneEvent.fullHashes || 0;
    progress.ignored = doneEvent.ignored || 0;
    state.storage.folderBytes = doneEvent.folderBytes ?? state.storage.folderBytes;
    state.storage.diskTotalBytes = doneEvent.diskTotalBytes ?? state.storage.diskTotalBytes;
    state.storage.diskFreeBytes = doneEvent.diskFreeBytes ?? state.storage.diskFreeBytes;
    state.storage.error = doneEvent.storageError || state.storage.error;
    state.totalFilesFound = doneEvent.filesFound || 0;
    state.records = records;
    state.groups = makeGroups(records);
    state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
    publishPartialResults(records, progress, true);
    setProgress(`Native scan complete · ${state.totalFilesFound.toLocaleString()} files checked`, 100);
    clearButton.hidden = false;
    const skipped = doneEvent.skipped || progress.skipped;
    const issues = progress.skippedExamples.slice(0, 10);
    renderReport({
      status: skipped ? 'warning' : 'complete',
      title: skipped ? 'Native scan completed with warnings' : 'Native scan completed successfully',
      detail: `${storageDetail()} ${progress.reusedHashes.toLocaleString()} unchanged hashes were reused. ${progress.quickCandidates.toLocaleString()} same-size files were quick-checked; ${progress.hashedCandidates.toLocaleString()} full hashes were performed.${progress.ignored ? ` ${progress.ignored.toLocaleString()} OS metadata files were ignored.` : ''} ${skipped ? 'Some items could not be read, so results may be partial.' : 'All readable files were checked.'} No files were changed during the scan.`,
      filesFound: state.totalFilesFound,
      reusedHashes: progress.reusedHashes,
      hashedCandidates: progress.hashedCandidates,
      skippedItems: skipped,
      ignoredSystem: progress.ignored,
      skippedBranches: 0,
      issues,
    });
    nativeStatus.textContent = 'Native helper connected · ready';
    nativeStatus.className = 'native-status connected';
    setToast(state.groups.length ? `Found ${state.groups.length} duplicate group${state.groups.length === 1 ? '' : 's'} with the native scanner.` : 'No exact duplicates found. Nice and tidy.');
  } catch (error) {
    state.records = records;
    state.groups = makeGroups(records);
    state.groups.forEach((group) => group.files.slice(1).forEach((record) => state.selected.add(record.id)));
    renderGroups();
    clearButton.hidden = false;
    renderReport({
      status: 'error',
      title: 'Native scan stopped before completion',
      detail: `${error.message || 'The native helper could not read the requested path.'} Partial results are still shown below when available.`,
      filesFound: state.totalFilesFound || 0,
      reusedHashes: progress.reusedHashes,
      hashedCandidates: progress.hashedCandidates,
      skippedItems: progress.skipped,
      ignoredSystem: progress.ignored,
      skippedBranches: 0,
      issues: [error.message || 'Native scanner connection failed.', ...progress.skippedExamples.slice(0, 8)],
    });
    nativeStatus.textContent = 'Native scanner error';
    nativeStatus.className = 'native-status error';
    setToast('The native scan stopped. See the Scan Report below.', true);
  } finally {
    stopNativeStoragePolling();
    state.scanning = false;
    $('liveStatus').innerHTML = '<i></i> Final results';
    renderGroups();
    updateStats();
    setTimeout(() => { progressWrap.hidden = true; }, 900);
  }
}

async function deleteNativeRecords(records) {
  if (!records.length) return;
  const confirmed = window.confirm(`Delete ${records.length} selected duplicate${records.length === 1 ? '' : 's'}? This permanently removes them from the drive.`);
  if (!confirmed) return;
  let deleted = 0;
  for (const record of records) {
    try {
      const response = await fetch(`${NATIVE_SCANNER_URL}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: record.absolutePath }) });
      if (!response.ok) throw new Error(await response.text());
      state.records = state.records.filter((item) => item.id !== record.id);
      state.selected.delete(record.id);
      deleted += 1;
    } catch (error) {
      setToast(`Could not delete ${record.path}: ${error.message || 'native delete failed'}`, true);
    }
  }
  state.groups = makeGroups(state.records);
  const remainingDuplicateIds = new Set(getAllDuplicateRecords().map((record) => record.id));
  state.selected.forEach((id) => { if (!remainingDuplicateIds.has(id)) state.selected.delete(id); });
  renderGroups();
  setToast(deleted ? `${deleted} duplicate${deleted === 1 ? '' : 's'} deleted.` : 'No files were deleted.', deleted === 0);
}

async function deleteRecords(records) {
  if (!records.length) return;
  if (state.source === 'native') {
    await deleteNativeRecords(records);
    return;
  }
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
  const remainingDuplicateIds = new Set(getAllDuplicateRecords().map((record) => record.id));
  state.selected.forEach((id) => { if (!remainingDuplicateIds.has(id)) state.selected.delete(id); });
  renderGroups();
  setToast(deleted ? `${deleted} duplicate${deleted === 1 ? '' : 's'} deleted.` : 'No files were deleted.', deleted === 0);
}

async function checkNativeScanner() {
  try {
    const response = await fetch(`${NATIVE_SCANNER_URL}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error('offline');
    const info = await response.json();
    nativeAvailable = true;
    nativeStatus.textContent = `Native helper connected · ${info.workers || 1} workers`;
    nativeStatus.className = 'native-status connected';
    cacheStatus.textContent = 'Every scan enumerates current files; only verified SHA-256 hashes are reused.';
    chooseButton.innerHTML = 'Choose folder / drive <span>↗</span>';
    if (!state.source) helperText.textContent = 'Native backend active. Choose a folder or whole drive; the Go backend will scan the selection.';
  } catch (error) {
    nativeAvailable = false;
    nativeStatus.textContent = 'Native helper not connected · start it from README';
    nativeStatus.className = 'native-status';
    cacheStatus.textContent = 'Every scan enumerates current files; browser mode reuses only verified SHA-256 hashes.';
    chooseButton.innerHTML = 'Choose folder <span>↗</span>';
  }
}

typeFilter.addEventListener('change', renderGroups);
cacheFilter.addEventListener('change', renderGroups);
locationFilter.addEventListener('input', renderGroups);
sortFilter.addEventListener('change', () => {
  state.sortBy = sortFilter.value;
  renderGroups();
});
sortDirection.addEventListener('click', () => {
  state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  sortDirection.textContent = state.sortDirection === 'asc' ? '↑ Ascending' : '↓ Descending';
  sortDirection.setAttribute('aria-label', `Sort ${state.sortDirection === 'asc' ? 'ascending' : 'descending'}`);
  renderGroups();
});
clearFilters.addEventListener('click', () => {
  typeFilter.value = 'all';
  locationFilter.value = '';
  cacheFilter.value = 'all';
  renderGroups();
});
clearCacheButton.addEventListener('click', clearHashCache);
selectAllButton.addEventListener('click', () => {
  const visibleDuplicates = getVisibleDuplicateRecords();
  if (!visibleDuplicates.length) return;
  const allVisibleSelected = visibleDuplicates.every((record) => state.selected.has(record.id));
  if (allVisibleSelected) deselectRecords(visibleDuplicates);
  else selectRecords(visibleDuplicates);
});
clearSelectionButton.addEventListener('click', () => {
  state.selected.clear();
  renderGroups();
  setToast('Selection cleared. No files will be deleted.');
});
quickDeleteButton.addEventListener('click', () => deleteRecords(getSelectedRecords()));
function setViewMode(mode) {
  state.viewMode = mode;
  listViewButton.classList.toggle('active', mode === 'list');
  treeViewButton.classList.toggle('active', mode === 'tree');
  listViewButton.setAttribute('aria-pressed', mode === 'list');
  treeViewButton.setAttribute('aria-pressed', mode === 'tree');
  renderGroups();
}
listViewButton.addEventListener('click', () => setViewMode('list'));
treeViewButton.addEventListener('click', () => setViewMode('tree'));
scanButton.addEventListener('click', () => state.source === 'native' ? runNativeScan() : runScan());
refreshStorageButton.addEventListener('click', refreshStorageSnapshot);
deleteButton.addEventListener('click', () => deleteRecords(getSelectedRecords()));
clearButton.addEventListener('click', () => {
  state.records = [];
  state.groups = [];
  state.selected.clear();
  state.originals.clear();
  state.inputFiles = [];
  state.nativeRoot = '';
  state.totalFilesFound = null;
  resetStorageStats();
  reportPanel.hidden = true;
  $('liveStatus').hidden = true;
  clearButton.hidden = true;
  progressWrap.hidden = true;
  renderGroups();
  setToast('Results cleared. Your folder was not changed.');
});

updateStats();
sortFilter.value = state.sortBy;
sortDirection.textContent = '↑ Ascending';
checkNativeScanner();
