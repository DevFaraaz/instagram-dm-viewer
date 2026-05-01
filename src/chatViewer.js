import { VirtualList } from './virtualList.js';
import { MediaLoader } from './mediaLoader.js';
import { parseMessagesHtml } from './htmlParser.js';
import {
  fixEncoding,
  formatTime,
  formatDateLabel,
  escapeHtml,
  linkify,
  kindFromPath,
  debounce,
} from './utils.js';

// Loads every message_*.json for a thread, normalizes records into a flat
// chronological list, sprinkles in date-separator items, and feeds the result
// to the variable-height VirtualList.
export class ChatViewer {
  constructor({ root, headerEl, viewport, spacerTop, spacerBottom, itemsContainer, searchInput, searchMeta, searchPrev, searchNext, zip }) {
    this.root = root;
    this.headerEl = headerEl;
    this.viewport = viewport;
    this.spacerTop = spacerTop;
    this.spacerBottom = spacerBottom;
    this.itemsContainer = itemsContainer;
    this.searchInput = searchInput;
    this.searchMeta = searchMeta;
    this.searchPrev = searchPrev;
    this.searchNext = searchNext;
    this.zip = zip;

    this.media = null;
    this.list = null;
    this.items = [];
    this.matches = [];
    this.matchIndex = -1;
    this.currentConvo = null;

    this._onSearchInput = debounce((e) => this.runSearch(e.target.value), 120);
    this._onPrev = () => this.gotoMatch(this.matchIndex - 1);
    this._onNext = () => this.gotoMatch(this.matchIndex + 1);
    this._onSearchKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.gotoMatch(this.matchIndex - 1);
        else this.gotoMatch(this.matchIndex + 1);
      }
    };

    this.searchInput.addEventListener('input', this._onSearchInput);
    this.searchInput.addEventListener('keydown', this._onSearchKey);
    this.searchPrev.addEventListener('click', this._onPrev);
    this.searchNext.addEventListener('click', this._onNext);

    this.itemsContainer.addEventListener('click', (e) => this.onItemClick(e));
  }

  open(convo) {
    this.close();
    this.currentConvo = convo;
    this.media = new MediaLoader(this.zip);

    const messages = readAllMessages(this.zip, convo.paths, convo.format || 'json');
    const items = buildItems(messages, convo, convo.format || 'json');
    this.items = items;

    this.renderHeader(convo);

    this.searchInput.value = '';
    this.matches = [];
    this.matchIndex = -1;
    this.updateSearchMeta();

    this.root.hidden = false;

    this.list = new VirtualList({
      viewport: this.viewport,
      spacerTop: this.spacerTop,
      spacerBottom: this.spacerBottom,
      itemsContainer: this.itemsContainer,
      items,
      estimateHeight: estimateItemHeight,
      renderItem: (item, idx) => this.renderItem(item, idx),
    });
    // Jump to the bottom: latest message is at the end since we sort ascending.
    requestAnimationFrame(() => this.list.scrollToBottom());
  }

  close() {
    if (this.list) {
      this.list.destroy();
      this.list = null;
    }
    if (this.media) {
      this.media.releaseAll();
      this.media = null;
    }
    this.items = [];
    this.matches = [];
    this.matchIndex = -1;
    this.currentConvo = null;
    this.itemsContainer.replaceChildren();
    this.root.hidden = true;
  }

  renderHeader(convo) {
    const subtitle = convo.participants.length > 2
      ? `${convo.participants.length} people`
      : convo.participants.join(' · ');
    this.headerEl.innerHTML = `
      <div class="chat-header__avatar" aria-hidden="true">${makeInitials(convo.title)}</div>
      <div class="chat-header__body">
        <div class="chat-header__title">${escapeHtml(convo.title)}</div>
        <div class="chat-header__subtitle">${escapeHtml(subtitle)}</div>
      </div>`;
  }

  renderItem(item, idx) {
    if (item.type === 'date') {
      const el = document.createElement('div');
      el.className = 'date-sep';
      el.innerHTML = `<span>${escapeHtml(item.label)}</span>`;
      return el;
    }
    return this.renderMessage(item, idx);
  }

  renderMessage(msg, idx) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${msg.isMe ? 'msg--me' : 'msg--them'}${msg.isGroup ? ' msg--group' : ''}`;
    wrap.dataset.idx = String(idx);

    const showSender = msg.isGroup && !msg.isMe && msg.showSender;
    let html = '';

    if (showSender) {
      html += `<div class="msg__sender">${escapeHtml(msg.sender)}</div>`;
    }

    html += '<div class="msg__bubble-wrap">';
    if (msg.replyTo) {
      html += `<div class="msg__reply">${escapeHtml(msg.replyTo)}</div>`;
    }
    if (msg.shared) {
      const link = msg.shared.link ? escapeHtml(msg.shared.link) : '';
      const sharedText = msg.shared.share_text ? fixEncoding(msg.shared.share_text) : '';
      html += `<div class="msg__shared">
        <div class="msg__shared-label">Shared</div>
        ${link ? `<a class="msg__shared-link" href="${link}" target="_blank" rel="noopener noreferrer">${link}</a>` : ''}
        ${sharedText ? `<div class="msg__shared-text">${escapeHtml(sharedText)}</div>` : ''}
      </div>`;
    }

    if (msg.media && msg.media.length) {
      html += `<div class="msg__media msg__media--n${Math.min(msg.media.length, 4)}">`;
      for (const m of msg.media) {
        if (m.kind === 'image') {
          html += `<div class="media-tile" data-uri="${escapeHtml(m.uri)}" data-kind="image"><div class="media-placeholder">Loading…</div></div>`;
        } else if (m.kind === 'video') {
          html += `<div class="media-tile" data-uri="${escapeHtml(m.uri)}" data-kind="video"><div class="media-placeholder">▶ Video</div></div>`;
        } else if (m.kind === 'audio') {
          html += `<div class="media-tile media-tile--audio" data-uri="${escapeHtml(m.uri)}" data-kind="audio"><div class="media-placeholder">🎙 Voice message</div></div>`;
        } else {
          html += `<div class="media-tile media-tile--file" data-uri="${escapeHtml(m.uri)}" data-kind="file"><div class="media-placeholder">📎 ${escapeHtml(m.uri.split('/').pop() || 'File')}</div></div>`;
        }
      }
      html += '</div>';
    }

    if (msg.content) {
      const content = msg.matchTerm
        ? highlightAndLinkify(msg.content, msg.matchTerm)
        : linkify(msg.content);
      html += `<div class="msg__bubble"><div class="msg__text">${content}</div></div>`;
    }

    html += `<div class="msg__time">${escapeHtml(formatTime(msg.timestamp))}</div>`;

    if (msg.reactions && msg.reactions.length) {
      const counts = new Map();
      for (const r of msg.reactions) {
        counts.set(r.reaction, (counts.get(r.reaction) || 0) + 1);
      }
      html += '<div class="msg__reactions">';
      for (const [r, n] of counts) {
        html += `<span class="msg__reaction">${escapeHtml(r)}${n > 1 ? `<small>${n}</small>` : ''}</span>`;
      }
      html += '</div>';
    }
    html += '</div>'; // bubble-wrap

    wrap.innerHTML = html;

    // Lazy-resolve media now (cheap: just looks up bytes already in memory).
    for (const tile of wrap.querySelectorAll('.media-tile')) {
      this.hydrateMediaTile(tile);
    }

    return wrap;
  }

  hydrateMediaTile(tile) {
    const uri = tile.dataset.uri;
    const kind = tile.dataset.kind;
    const url = this.media.resolve(uri);
    if (!url) {
      tile.innerHTML = `<div class="media-placeholder media-placeholder--missing">Missing media<br><small>${escapeHtml(uri.split('/').pop() || '')}</small></div>`;
      return;
    }
    if (kind === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = url;
      img.alt = '';
      img.addEventListener('load', () => {
        // Heights may grow once the image loads; ask the list to remeasure.
        const idxAttr = tile.closest('[data-idx]')?.dataset.idx;
        if (idxAttr != null && this.list) this.list.invalidateHeight(parseInt(idxAttr, 10));
      });
      tile.replaceChildren(img);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = url;
      tile.replaceChildren(video);
    } else if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      tile.replaceChildren(audio);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = uri.split('/').pop() || 'file';
      a.textContent = `📎 ${a.download}`;
      tile.replaceChildren(a);
    }
  }

  onItemClick(e) {
    const img = e.target.closest('.msg__media img');
    if (!img) return;
    e.preventDefault();
    openLightbox(img.src);
  }

  // ---- search ----
  runSearch(query) {
    const q = (query || '').trim();
    if (!q) {
      this.matches = [];
      this.matchIndex = -1;
      this.clearMatchHighlights();
      this.updateSearchMeta();
      return;
    }
    const lc = q.toLowerCase();
    const matches = [];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.type !== 'message' || !it.content) continue;
      if (it.content.toLowerCase().includes(lc)) matches.push(i);
    }
    this.matches = matches;
    this.matchIndex = matches.length ? 0 : -1;
    this.activeQuery = q;
    this.searchPrev.disabled = matches.length === 0;
    this.searchNext.disabled = matches.length === 0;
    this.updateSearchMeta();
    if (matches.length > 0) this.highlightAndScroll();
  }

  gotoMatch(i) {
    if (this.matches.length === 0) return;
    const next = (i + this.matches.length) % this.matches.length;
    this.matchIndex = next;
    this.updateSearchMeta();
    this.highlightAndScroll();
  }

  highlightAndScroll() {
    const itemIdx = this.matches[this.matchIndex];
    // Tag the item with a transient match marker so renderItem highlights it,
    // and remember which indexes need DOM rebuilds (the previous highlighted
    // one + the new one).
    const dirtyIndexes = new Set();
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.type === 'message' && it.matchTerm) {
        it.matchTerm = null;
        dirtyIndexes.add(i);
      }
    }
    const target = this.items[itemIdx];
    if (target) {
      target.matchTerm = this.activeQuery;
      dirtyIndexes.add(itemIdx);
    }
    for (const i of dirtyIndexes) this.list.invalidateItem(i);
    this.list.scrollToIndex(itemIdx, 'center');
  }

  clearMatchHighlights() {
    if (!this.list) return;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.type === 'message' && it.matchTerm) {
        it.matchTerm = null;
        this.list.invalidateItem(i);
      }
    }
  }

  updateSearchMeta() {
    if (this.matches.length === 0) {
      this.searchMeta.textContent = this.searchInput.value ? '0' : '';
    } else {
      this.searchMeta.textContent = `${this.matchIndex + 1} / ${this.matches.length}`;
    }
  }
}

// ---- helpers ----

function readAllMessages(zip, paths, format) {
  // paths is sorted by trailing number (message_1, message_2, ...); messages
  // within each are newest-first. We concatenate then sort ascending by
  // timestamp so the order is correct regardless of file naming.
  const all = [];
  for (const path of paths) {
    if (format === 'html') {
      const bytes = zip.getBytes(path);
      const msgs = parseMessagesHtml(bytes);
      for (const m of msgs) all.push(m);
      continue;
    }
    const text = zip.getText(path);
    if (!text) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(data.messages)) continue;
    for (const m of data.messages) all.push(m);
  }
  all.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));
  return all;
}

const identity = (s) => s;

function buildItems(messages, convo, format) {
  // The mojibake fix is only needed for IG's JSON exports — HTML files store
  // strings in proper UTF-8 already, so applying it would corrupt names like
  // "résumé" (single-byte é gets misinterpreted as a UTF-8 byte sequence).
  const enc = format === 'html' ? identity : fixEncoding;
  const out = [];
  let lastDate = '';
  let lastSender = null;
  const isGroup = convo.threadType === 'RegularGroup' || convo.participants.length > 2;
  // The "me" account is the participant who actually sends messages — find by
  // counting; whichever name shows up most often as sender_name is the user.
  const senderCounts = new Map();
  for (const m of messages) {
    const name = m.sender_name;
    if (name) senderCounts.set(name, (senderCounts.get(name) || 0) + 1);
  }
  // For 1:1, "me" is the sender that *isn't* the other participant.
  let meName = null;
  if (!isGroup && convo.participants.length === 2) {
    // The "me" name appears in messages but is also typically last in
    // participants[]. Instagram's export puts the owner last. Falls back to most common.
    const fixedParticipants = convo.participants;
    meName = fixedParticipants[fixedParticipants.length - 1];
  }
  if (!meName) {
    // Default to most prolific sender — accurate for the user's own export.
    let max = -1;
    for (const [name, n] of senderCounts) {
      if (n > max) {
        max = n;
        meName = name;
      }
    }
  }

  for (const m of messages) {
    const ts = m.timestamp_ms || 0;
    const dateLabel = formatDateLabel(ts);
    if (dateLabel !== lastDate) {
      out.push({ type: 'date', label: dateLabel, timestamp: ts });
      lastDate = dateLabel;
      lastSender = null;
    }

    const senderRaw = m.sender_name || '';
    const sender = enc(senderRaw);
    const isMe = senderRaw === meName;
    const showSender = lastSender !== senderRaw;
    lastSender = senderRaw;

    const media = [];
    if (Array.isArray(m.photos)) {
      for (const p of m.photos) media.push({ kind: 'image', uri: p.uri });
    }
    if (Array.isArray(m.videos)) {
      for (const v of m.videos) media.push({ kind: 'video', uri: v.uri });
    }
    if (Array.isArray(m.audio_files)) {
      for (const a of m.audio_files) media.push({ kind: 'audio', uri: a.uri });
    }
    if (Array.isArray(m.gifs)) {
      for (const g of m.gifs) media.push({ kind: kindFromPath(g.uri), uri: g.uri });
    }
    if (Array.isArray(m.files)) {
      for (const f of m.files) media.push({ kind: kindFromPath(f.uri), uri: f.uri });
    }

    out.push({
      type: 'message',
      timestamp: ts,
      sender,
      isMe,
      isGroup,
      showSender,
      content: m.content ? enc(m.content) : '',
      media,
      reactions: Array.isArray(m.reactions)
        ? m.reactions.map((r) => ({
            actor: enc(r.actor || ''),
            reaction: enc(r.reaction || ''),
          }))
        : [],
      shared: m.share || null,
      replyTo: null,
      matchTerm: null,
    });
  }
  return out;
}

function estimateItemHeight(item) {
  if (item.type === 'date') return 44;
  let h = 12;
  if (item.showSender) h += 18;
  if (item.media && item.media.length) {
    h += item.media.length === 1 ? 240 : 180;
  }
  if (item.content) {
    const len = item.content.length;
    h += 32 + Math.ceil(len / 40) * 18;
  } else if (!item.media?.length) {
    h += 24;
  }
  if (item.reactions && item.reactions.length) h += 22;
  h += 18; // time
  return h;
}

function highlightAndLinkify(text, term) {
  // Escape HTML, then replace term with mark, then linkify URLs that are
  // already escaped so we don't accidentally cut into <mark> tags.
  const escaped = escapeHtml(text);
  const safeTerm = escapeHtml(term);
  const re = new RegExp(escapeRegex(safeTerm), 'gi');
  const marked = escaped.replace(re, (m) => `<mark>${m}</mark>`);
  return marked.replace(
    /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeInitials(title) {
  if (!title) return '?';
  const parts = title.split(/[\s,]+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || title[0].toUpperCase();
}

// ---- lightbox ----
let lightboxEl = null;
function openLightbox(src) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.innerHTML = '<img alt="" />';
    lightboxEl.addEventListener('click', () => {
      lightboxEl.classList.remove('lightbox--open');
    });
    document.body.appendChild(lightboxEl);
  }
  lightboxEl.querySelector('img').src = src;
  lightboxEl.classList.add('lightbox--open');
}
