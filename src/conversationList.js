import { fixEncoding, formatRelative, escapeHtml } from './utils.js';
import { parseConvoMetaHtml } from './htmlParser.js';

// Discovers conversations by scanning ZIP paths for messages/inbox/<folder>/
// entries. Each folder needs a small amount of metadata (title, participants,
// most-recent timestamp + preview) for the sidebar — but the underlying JSON
// can be 10–30 MB per active thread, so we DO NOT JSON.parse the whole thing
// during indexing. Instead we string-extract just the bits we need:
//   - "title" + "thread_type" via regex
//   - "participants" array, then a name-regex over its slice
//   - the FIRST element of the "messages" array via brace-matching, which we
//     parse on its own (a few hundred bytes — instant).
// Full parsing happens lazily when a thread is actually opened in ChatViewer.
export class ConversationList {
  constructor({ root, zip, onSelect }) {
    this.root = root;
    this.zip = zip;
    this.onSelect = onSelect;
    this.conversations = [];
    this.filtered = [];
    this.activeKey = null;
  }

  async discover(onProgress) {
    const t0 = performance.now();
    console.log('[index] discover() started');

    // Match any .json or .html file living directly inside an inbox
    // subfolder. IG ships either format depending on what the user requested
    // when they triggered the export.
    const inboxRe = /^(?:.*\/)?messages\/inbox\/([^/]+)\/([^/]+\.(?:json|html))$/i;

    const folderPaths = new Map();
    const samplePaths = [];
    let totalPaths = 0;
    for (const path of this.zip.paths()) {
      totalPaths++;
      const m = inboxRe.exec(path);
      if (!m) continue;
      const folder = m[1];
      if (!folderPaths.has(folder)) folderPaths.set(folder, []);
      folderPaths.get(folder).push(path);
      if (samplePaths.length < 5) samplePaths.push(path);
    }

    if (folderPaths.size === 0) {
      // Dump a few sample inbox-prefixed paths so we can see what IG actually
      // shipped this time and adjust the matcher.
      const inboxPrefixed = [];
      for (const path of this.zip.paths()) {
        if (/messages\/inbox\//i.test(path)) inboxPrefixed.push(path);
        if (inboxPrefixed.length >= 15) break;
      }
      console.warn('[index] no conversation JSONs found. First 15 inbox-prefixed paths:');
      for (const p of inboxPrefixed) console.warn('  ', p);
    } else {
      console.log('[index] sample matched paths:', samplePaths);
    }

    const folders = [...folderPaths.entries()];
    const total = folders.length;
    const t1 = performance.now();
    console.log(`[index] scanned ${totalPaths.toLocaleString()} paths in ${(t1 - t0).toFixed(0)}ms — found ${total} conversations`);

    if (onProgress) onProgress(0, total);
    // Yield once before the loop so the initial "0 / N" label paints — without
    // this the browser shows "Indexing conversations…" with no counter for as
    // long as the first batch of iterations takes.
    await yieldToBrowser();

    const conversations = [];
    const YIELD_EVERY = 4;
    let slowest = { ms: 0, folder: '', size: 0 };
    for (let i = 0; i < folders.length; i++) {
      const [folder, paths] = folders[i];
      paths.sort((a, b) => {
        // Sort by trailing number when present (message_1.json, message_2.json
        // …); fall back to natural lexical order otherwise.
        const an = /(\d+)\.(?:json|html)$/i.exec(a);
        const bn = /(\d+)\.(?:json|html)$/i.exec(b);
        if (an && bn) return parseInt(an[1], 10) - parseInt(bn[1], 10);
        return a.localeCompare(b);
      });
      const format = paths[0].toLowerCase().endsWith('.html') ? 'html' : 'json';
      const ts = performance.now();
      const meta = readConvoMeta(this.zip, paths[0], format);
      const elapsed = performance.now() - ts;
      if (elapsed > 50) {
        const bytes = this.zip.getBytes(paths[0])?.length || 0;
        console.warn(`[index] slow convo ${folder}: ${elapsed.toFixed(0)}ms (${(bytes / 1024 / 1024).toFixed(1)}MB ${format})`);
      }
      if (elapsed > slowest.ms) {
        slowest = { ms: elapsed, folder, size: this.zip.getBytes(paths[0])?.length || 0 };
      }
      conversations.push({
        key: folder,
        folder,
        paths,
        format,
        title: meta.title || folder.replace(/_\d+$/, '').replace(/_[a-z0-9]+$/i, '') || folder,
        participants: meta.participants,
        lastTimestamp: meta.lastTimestamp,
        preview: meta.preview,
        threadType: meta.threadType,
      });

      if ((i + 1) % YIELD_EVERY === 0) {
        if (onProgress) onProgress(i + 1, total);
        await yieldToBrowser();
      }
    }
    if (onProgress) onProgress(total, total);

    const t2 = performance.now();
    console.log(`[index] processed ${total} conversations in ${(t2 - t1).toFixed(0)}ms (avg ${((t2 - t1) / total).toFixed(1)}ms/convo)`);
    if (slowest.ms > 50) {
      console.log(`[index] slowest: ${slowest.folder} ${slowest.ms.toFixed(0)}ms ${(slowest.size / 1024 / 1024).toFixed(1)}MB`);
    }

    conversations.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
    this.conversations = conversations;
    this.filtered = conversations;
    this.render();
    console.log(`[index] discover() done in ${(performance.now() - t0).toFixed(0)}ms total`);
    return conversations;
  }

  setQuery(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      this.filtered = this.conversations;
    } else {
      this.filtered = this.conversations.filter((c) => {
        if (c.title.toLowerCase().includes(q)) return true;
        if (c.preview && c.preview.toLowerCase().includes(q)) return true;
        for (const p of c.participants) {
          if (p.toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }
    this.render();
  }

  setActive(key) {
    this.activeKey = key;
    for (const el of this.root.querySelectorAll('.convo-row')) {
      el.classList.toggle('convo-row--active', el.dataset.key === key);
    }
  }

  render() {
    if (this.filtered.length === 0) {
      this.root.innerHTML = `
        <div class="convo-empty">
          <p>No conversations found.</p>
          <p class="hint">Make sure your ZIP contains <code>messages/inbox/</code>.</p>
        </div>`;
      return;
    }

    const html = this.filtered
      .map((c) => {
        const title = escapeHtml(c.title);
        const preview = escapeHtml(c.preview || '');
        const time = c.lastTimestamp ? formatRelative(c.lastTimestamp) : '';
        const initials = makeInitials(c.title);
        const isActive = c.key === this.activeKey ? ' convo-row--active' : '';
        const isGroup = c.threadType === 'RegularGroup' || c.participants.length > 2;
        return `
          <button type="button" class="convo-row${isActive}" data-key="${escapeHtml(c.key)}">
            <div class="convo-row__avatar" aria-hidden="true">
              ${isGroup ? groupSvg() : escapeHtml(initials)}
            </div>
            <div class="convo-row__body">
              <div class="convo-row__top">
                <span class="convo-row__title">${title}</span>
                <span class="convo-row__time">${escapeHtml(time)}</span>
              </div>
              <div class="convo-row__preview">${preview || '&nbsp;'}</div>
            </div>
          </button>`;
      })
      .join('');

    this.root.innerHTML = html;

    this.root.querySelectorAll('.convo-row').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        const convo = this.conversations.find((c) => c.key === key);
        if (convo) {
          this.setActive(key);
          this.onSelect?.(convo);
        }
      });
    });
  }
}

// Indexing budget per conversation. participants and the first message both
// sit near the top of an Instagram thread JSON, so we only decode this much —
// keeps per-conversation work O(constant) regardless of how chatty the thread
// is. Title lives at the END of the file (post-messages array), so we only
// recover it when the file fits inside the prefix; folder name is the fallback.
const META_PREFIX_BYTES = 256 * 1024;
const META_DECODER = new TextDecoder('utf-8', { fatal: false });

function readConvoMeta(zip, path, format) {
  if (format === 'html') {
    return parseConvoMetaHtml(zip.getBytes(path));
  }
  const result = { title: null, participants: [], lastTimestamp: 0, preview: '', threadType: null };
  const bytes = zip.getBytes(path);
  if (!bytes) return result;

  const head = bytes.length > META_PREFIX_BYTES ? bytes.subarray(0, META_PREFIX_BYTES) : bytes;
  const text = META_DECODER.decode(head);
  const fullFile = head.length === bytes.length;

  if (fullFile) {
    const titleMatch = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) {
      const raw = jsonUnescape(titleMatch[1]);
      if (raw !== null) result.title = fixEncoding(raw);
    }
  }

  const typeMatch = text.match(/"thread_type"\s*:\s*"([^"]*)"/);
  if (typeMatch) result.threadType = typeMatch[1];

  const partsMatch = text.match(/"participants"\s*:\s*\[([\s\S]*?)\]/);
  if (partsMatch) {
    const nameRe = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = nameRe.exec(partsMatch[1])) !== null) {
      const raw = jsonUnescape(m[1]);
      if (raw !== null) result.participants.push(fixEncoding(raw));
    }
  }

  const firstMsg = extractFirstMessage(text);
  if (firstMsg) {
    result.lastTimestamp = firstMsg.timestamp_ms || 0;
    result.preview = makePreview(firstMsg);
  }

  if (!result.title && result.participants.length > 0) {
    result.title = result.participants.join(', ');
  }
  return result;
}

// Scan for the start of the messages array, find the first object literal in
// it via brace matching, then JSON.parse just that sub-string. Fast even when
// the surrounding file is tens of MB because we never decode the rest.
function extractFirstMessage(text) {
  const msgsIdx = text.indexOf('"messages"');
  if (msgsIdx === -1) return null;
  const arrStart = text.indexOf('[', msgsIdx);
  if (arrStart === -1) return null;

  let i = arrStart + 1;
  while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  if (text[i] !== '{') return null;

  const start = i;
  let depth = 1;
  let inString = false;
  let escape = false;
  i++;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  if (depth !== 0) return null;

  try {
    return JSON.parse(text.slice(start, i));
  } catch {
    return null;
  }
}

function jsonUnescape(captured) {
  // Captured strings come from the source JSON's quoted contents; re-quoting
  // and parsing handles \n, \", \uXXXX, etc. without writing our own decoder.
  try {
    return JSON.parse('"' + captured + '"');
  } catch {
    return captured;
  }
}

function makePreview(msg) {
  if (!msg) return '';
  if (msg.content) return fixEncoding(msg.content).split('\n')[0];
  if (Array.isArray(msg.photos) && msg.photos.length) return '📷 Photo';
  if (Array.isArray(msg.videos) && msg.videos.length) return '🎥 Video';
  if (Array.isArray(msg.audio_files) && msg.audio_files.length) return '🎙 Voice message';
  if (Array.isArray(msg.share) && msg.share.length) return '🔗 Shared post';
  if (msg.share) return '🔗 Shared post';
  if (Array.isArray(msg.gifs) && msg.gifs.length) return 'GIF';
  return '';
}

function makeInitials(title) {
  if (!title) return '?';
  const parts = title.split(/[\s,]+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || title[0].toUpperCase();
}

function groupSvg() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="10" r="3"/><path d="M2.5 19c.6-3 3.4-5 6.5-5s5.9 2 6.5 5"/><path d="M14 16.5c.6-1.7 2.3-3 4-3s3.4 1.3 4 3"/></svg>`;
}

function yieldToBrowser() {
  // Use scheduler.postTask if available so we cooperate with the browser's
  // priority system; fall back to a setTimeout(0) tick everywhere else.
  if (typeof globalThis.scheduler !== 'undefined' && typeof globalThis.scheduler.yield === 'function') {
    return globalThis.scheduler.yield();
  }
  return new Promise((r) => setTimeout(r, 0));
}
