import { ZipManager } from './zipManager.js';
import { ConversationList } from './conversationList.js';
import { ChatViewer } from './chatViewer.js';
import { formatBytes, debounce } from './utils.js';

const dom = {
  uploadScreen: document.getElementById('upload-screen'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  chooseFileBtn: document.getElementById('choose-file'),
  loadProgress: document.getElementById('load-progress'),
  loadProgressFill: document.getElementById('load-progress-fill'),
  loadProgressLabel: document.getElementById('load-progress-label'),
  loadProgressList: document.getElementById('load-progress-list'),

  viewer: document.getElementById('viewer'),
  backBtn: document.getElementById('back-btn'),
  convoSearch: document.getElementById('convo-search'),
  convoList: document.getElementById('conversation-list'),

  chatRoot: document.getElementById('chat'),
  chatEmpty: document.getElementById('chat-empty'),
  chatActive: document.getElementById('chat-active'),
  chatHeader: document.getElementById('chat-header'),
  chatViewport: document.getElementById('chat-viewport'),
  chatSpacerTop: document.getElementById('chat-spacer-top'),
  chatSpacerBottom: document.getElementById('chat-spacer-bottom'),
  chatItems: document.getElementById('chat-items'),
  chatSearch: document.getElementById('chat-search'),
  chatSearchMeta: document.getElementById('chat-search-meta'),
  chatSearchPrev: document.getElementById('chat-search-prev'),
  chatSearchNext: document.getElementById('chat-search-next'),
};

let zip = null;
let convoList = null;
let chatViewer = null;

function isZipFile(file) {
  if (!file) return false;
  if (/\.zip$/i.test(file.name)) return true;
  return file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

function renderPartList(parts) {
  dom.loadProgressList.innerHTML = parts
    .map((p, i) => {
      const status = p.done ? 'done' : p.read > 0 ? 'active' : 'pending';
      const pct = p.total ? Math.round((p.read / p.total) * 100) : 0;
      return `
        <li class="load-part load-part--${status}">
          <span class="load-part__name">${escapeAttr(p.name)}</span>
          <span class="load-part__size">${pct}% · ${formatBytes(p.read)} / ${formatBytes(p.total)}</span>
        </li>`;
    })
    .join('');
}

function escapeAttr(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

async function handleFiles(files) {
  const list = [...files].filter(isZipFile);
  if (list.length === 0) {
    alert('Please choose one or more .zip files (your Instagram data export).');
    return;
  }
  // Sort by name so multi-part exports load in order (part_1, part_2, …).
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  dom.dropZone.classList.add('drop-zone--loading');
  dom.loadProgress.hidden = false;
  dom.loadProgressFill.style.width = '0%';
  dom.loadProgressLabel.textContent = list.length > 1 ? `Reading ${list.length} ZIPs…` : 'Reading ZIP…';

  const totalBytes = list.reduce((sum, f) => sum + (f.size || 0), 0);
  const parts = list.map((f) => ({ name: f.name, total: f.size || 0, read: 0, done: false }));
  renderPartList(parts);

  let bytesBefore = 0;
  let phase = 'reading';
  let entriesTotal = 0;
  let lastEntryUiAt = 0;
  let indexed = 0;
  let indexTotal = 0;

  const updateLabel = () => {
    if (phase === 'reading') {
      const overall = bytesBefore + (parts[currentPartIdx]?.read || 0);
      const pct = totalBytes ? Math.round((overall / totalBytes) * 100) : 0;
      dom.loadProgressFill.style.width = pct + '%';
      dom.loadProgressLabel.textContent =
        `${list.length > 1 ? 'Reading ZIPs… ' : 'Reading ZIP… '}` +
        `${formatBytes(overall)} / ${formatBytes(totalBytes)} (${pct}%)`;
    } else if (phase === 'processing') {
      dom.loadProgressFill.style.width = '100%';
      dom.loadProgressLabel.textContent =
        `Decompressing… ${entriesTotal.toLocaleString()} files processed`;
    } else if (phase === 'indexing') {
      const pct = indexTotal ? Math.round((indexed / indexTotal) * 100) : 0;
      dom.loadProgressFill.style.width = (pct || 100) + '%';
      dom.loadProgressLabel.textContent = indexTotal
        ? `Indexing conversations… ${indexed} / ${indexTotal}`
        : 'Indexing conversations…';
    }
  };

  let currentPartIdx = 0;

  const tStart = performance.now();
  try {
    zip = new ZipManager();
    for (let i = 0; i < list.length; i++) {
      currentPartIdx = i;
      const file = list[i];
      const part = parts[i];
      const tPartStart = performance.now();
      console.log(`[zip] loading part ${i + 1}/${list.length}: ${file.name} (${formatBytes(file.size)})`);

      await zip.load(
        file,
        (read, total) => {
          part.read = read;
          part.total = total;
          if (read >= total && total > 0) phase = 'processing';
          renderPartList(parts);
          updateLabel();
        },
        (count) => {
          entriesTotal = zip.size;
          const now = performance.now();
          if (phase === 'processing' && now - lastEntryUiAt > 80) {
            lastEntryUiAt = now;
            updateLabel();
          }
        }
      );
      part.done = true;
      part.read = part.total;
      bytesBefore += part.total;
      console.log(`[zip] part ${i + 1} done in ${((performance.now() - tPartStart) / 1000).toFixed(1)}s — total entries so far: ${zip.size.toLocaleString()}`);
      phase = i < list.length - 1 ? 'reading' : 'indexing';
      renderPartList(parts);
      updateLabel();
      await new Promise((r) => setTimeout(r, 0));
    }
    console.log(`[zip] all parts loaded in ${((performance.now() - tStart) / 1000).toFixed(1)}s — ${zip.size.toLocaleString()} files, ${formatBytes(zip.totalBytes)} decompressed`);

    if (zip.size === 0) {
      throw new Error('ZIPs appear empty.');
    }

    const tInbox = performance.now();
    const inboxCount = countInboxFolders(zip);
    console.log(`[scan] found ${inboxCount} inbox folders in ${(performance.now() - tInbox).toFixed(0)}ms`);
    if (inboxCount === 0) {
      throw new Error('No messages/inbox folder found. Make sure you included the parts that contain your messages.');
    }

    chatViewer = new ChatViewer({
      root: dom.chatActive,
      headerEl: dom.chatHeader,
      viewport: dom.chatViewport,
      spacerTop: dom.chatSpacerTop,
      spacerBottom: dom.chatSpacerBottom,
      itemsContainer: dom.chatItems,
      searchInput: dom.chatSearch,
      searchMeta: dom.chatSearchMeta,
      searchPrev: dom.chatSearchPrev,
      searchNext: dom.chatSearchNext,
      zip,
    });

    convoList = new ConversationList({
      root: dom.convoList,
      zip,
      onSelect: (convo) => {
        dom.chatEmpty.hidden = true;
        chatViewer.open(convo);
      },
    });

    await convoList.discover((done, total) => {
      indexed = done;
      indexTotal = total;
      updateLabel();
    });

    dom.uploadScreen.hidden = true;
    dom.viewer.hidden = false;
  } catch (err) {
    console.error(err);
    alert(`Could not read ZIP: ${err.message}`);
    dom.dropZone.classList.remove('drop-zone--loading');
    dom.loadProgress.hidden = true;
  }
}

function countInboxFolders(zip) {
  const seen = new Set();
  for (const path of zip.paths()) {
    const m = /^(?:.*\/)?messages\/inbox\/([^/]+)\//.exec(path);
    if (m) seen.add(m[1]);
  }
  return seen.size;
}

function reset() {
  if (chatViewer) chatViewer.close();
  chatViewer = null;
  convoList = null;
  zip = null;
  dom.convoList.replaceChildren();
  dom.chatHeader.replaceChildren();
  dom.chatActive.hidden = true;
  dom.chatEmpty.hidden = false;
  dom.viewer.hidden = true;
  dom.uploadScreen.hidden = false;
  dom.dropZone.classList.remove('drop-zone--loading');
  dom.loadProgress.hidden = true;
  dom.loadProgressFill.style.width = '0%';
  dom.fileInput.value = '';
  dom.convoSearch.value = '';
}

dom.chooseFileBtn.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (files && files.length) handleFiles(files);
});

['dragenter', 'dragover'].forEach((ev) => {
  dom.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dom.dropZone.classList.add('drop-zone--hover');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dom.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ev === 'dragleave' && dom.dropZone.contains(e.relatedTarget)) return;
    dom.dropZone.classList.remove('drop-zone--hover');
  });
});
dom.dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  if (files && files.length) handleFiles(files);
});

// Prevent the browser from navigating away when files are dropped outside the
// drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

dom.backBtn.addEventListener('click', reset);

dom.convoSearch.addEventListener(
  'input',
  debounce((e) => convoList?.setQuery(e.target.value), 100)
);
