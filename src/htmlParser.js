// Parses Instagram's HTML export format and normalizes it to the same record
// shape the JSON path produces, so ChatViewer / ConversationList don't need
// to care which format the user downloaded.
//
// IG's HTML structure (relevant bits):
//   <title>Conversation Name</title>
//   <header><h1>Conversation Name</h1></header>
//   <main>
//     <div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">      ← one per message
//       <h2 class="_3-95 _2pim _a6-h _a6-i">Sender</h2>
//       <div class="_3-95 _a6-p">
//         <div>
//           <div></div>                                              ← reply slot (often empty)
//           <div>Text content</div>
//           <div>… <img>/<video>/<audio>/<a> for attachments …</div>
//           <div></div>
//           <div><ul class="_a6-q"><li>reactions</li></ul></div>     ← optional
//         </div>
//       </div>
//       <div class="_3-94 _a6-o">May 01, 2026 5:10 pm</div>          ← timestamp
//     </div>
//     …more messages, newest first…
//   </main>

const META_PREFIX_BYTES = 256 * 1024;
const META_DECODER = new TextDecoder('utf-8', { fatal: false });
const FULL_DECODER = new TextDecoder('utf-8', { fatal: false });
const MSG_OPENER = '<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">';
const CONTENT_OPENER = '<div class="_3-95 _a6-p">';
const TS_OPENER = '<div class="_3-94 _a6-o">';

export function parseConvoMetaHtml(bytes) {
  const result = { title: null, participants: [], lastTimestamp: 0, preview: '', threadType: 'Regular' };
  if (!bytes) return result;

  const head = bytes.length > META_PREFIX_BYTES ? bytes.subarray(0, META_PREFIX_BYTES) : bytes;
  const text = META_DECODER.decode(head);

  const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1]).trim();

  // First message block = newest message in the file. Use it for preview +
  // last-active timestamp.
  const start = text.indexOf(MSG_OPENER);
  if (start !== -1) {
    let end = text.indexOf(MSG_OPENER, start + MSG_OPENER.length);
    if (end === -1) {
      const mainEnd = text.indexOf('</main>', start);
      end = mainEnd === -1 ? text.length : mainEnd;
    }
    const block = text.slice(start, end);
    const ts = lastTimestampInBlock(block);
    if (ts) result.lastTimestamp = ts;
    result.preview = previewFromBlock(block);
  }

  // Collect distinct sender names from the prefix as participants. We stop
  // once we have a small handful — for a 1:1 thread this finds both names
  // quickly; for groups we cap at 20 to keep indexing fast.
  const seen = new Set();
  const senderRe = /<h2 class="_3-95 _2pim _a6-h _a6-i">([\s\S]*?)<\/h2>/g;
  let m;
  while ((m = senderRe.exec(text)) !== null && seen.size < 20) {
    const name = decodeHtmlEntities(stripTags(m[1])).trim();
    if (name && !seen.has(name)) seen.add(name);
  }
  result.participants = [...seen];
  if (result.participants.length > 2) result.threadType = 'RegularGroup';

  if (!result.title && result.participants.length > 0) {
    result.title = result.participants.join(', ');
  }

  return result;
}

export function parseMessagesHtml(bytes) {
  if (!bytes) return [];
  const text = FULL_DECODER.decode(bytes);
  const out = [];

  let cursor = text.indexOf(MSG_OPENER);
  while (cursor !== -1) {
    let next = text.indexOf(MSG_OPENER, cursor + MSG_OPENER.length);
    if (next === -1) {
      const mainEnd = text.indexOf('</main>', cursor);
      next = mainEnd === -1 ? text.length : mainEnd;
    }
    const block = text.slice(cursor, next);
    const msg = parseMessageBlock(block);
    if (msg) out.push(msg);
    if (next >= text.length) break;
    cursor = next === text.length ? -1 : text.indexOf(MSG_OPENER, next);
  }
  return out;
}

function parseMessageBlock(block) {
  const senderMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const sender = senderMatch ? decodeHtmlEntities(stripTags(senderMatch[1])).trim() : '';

  const timestamp_ms = lastTimestampInBlock(block);

  const contentHtml = extractContentHtml(block);
  const photos = extractMediaUris(contentHtml, /<img\s+[^>]*src="([^"]+)"/g);
  const videos = extractMediaUris(contentHtml, /<video[^>]*\s+src="([^"]+)"/g);
  const audios = extractMediaUris(contentHtml, /<audio[^>]*\s+src="([^"]+)"/g);
  const reactions = extractReactions(contentHtml);

  // Strip media + reactions and turn link tags into their hrefs so the plain
  // text we keep matches what a human reading the chat would see. Adjacent
  // <div>s often hold separate text fragments ("Afroz sent an attachment."
  // then the actual caption) — we treat each </div> as a soft break so the
  // stripped text doesn't smash them together.
  let textHtml = contentHtml;
  textHtml = textHtml.replace(/<img[^>]*\/?>/g, '');
  textHtml = textHtml.replace(/<video[^>]*>[\s\S]*?<\/video>/g, '');
  textHtml = textHtml.replace(/<audio[^>]*>[\s\S]*?<\/audio>/g, '');
  textHtml = textHtml.replace(/<ul class="_a6-q">[\s\S]*?<\/ul>/g, '');
  textHtml = textHtml.replace(/<br\s*\/?>/gi, '\n');
  textHtml = textHtml.replace(/<a [^>]*href="(https?:[^"]*)"[^>]*>[\s\S]*?<\/a>/g, ' $1 ');
  textHtml = textHtml.replace(/<\/div>/g, '\n');
  const content = decodeHtmlEntities(stripTags(textHtml))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!sender && !content && !photos.length && !videos.length && !audios.length) return null;

  return {
    sender_name: sender,
    timestamp_ms,
    content: content || null,
    photos: photos.length ? photos : undefined,
    videos: videos.length ? videos : undefined,
    audio_files: audios.length ? audios : undefined,
    reactions: reactions.length ? reactions : undefined,
  };
}

function extractContentHtml(block) {
  const cStart = block.indexOf(CONTENT_OPENER);
  if (cStart === -1) return '';
  const innerStart = cStart + CONTENT_OPENER.length;
  const tsIdx = block.lastIndexOf(TS_OPENER);
  let inner = block.slice(innerStart, tsIdx === -1 ? block.length : tsIdx);
  // Drop the trailing </div> that closes the _a6-p wrapper.
  inner = inner.replace(/<\/div>\s*$/, '');
  return inner;
}

function extractMediaUris(html, regex) {
  const out = [];
  if (!html) return out;
  const re = new RegExp(regex.source, regex.flags);
  let m;
  while ((m = re.exec(html)) !== null) {
    const uri = m[1];
    if (!uri || uri.startsWith('files/')) continue;
    out.push({ uri });
  }
  return out;
}

function extractReactions(html) {
  const reactions = [];
  if (!html) return reactions;
  const ulRe = /<ul class="_a6-q">([\s\S]*?)<\/ul>/g;
  let u;
  while ((u = ulRe.exec(html)) !== null) {
    // Each <li> looks like:
    //   <li><span>😂Faraaz<span> (Aug 26, 2023 7:29 pm)</span></span></li>
    // The emoji + actor share one text node — we store the whole "EMOJI + Name"
    // string as the reaction display because there's no reliable boundary.
    const liRe = /<li><span>([^<]*)<span>\s*\(([^)]*)\)<\/span><\/span><\/li>/g;
    let l;
    while ((l = liRe.exec(u[1])) !== null) {
      const text = decodeHtmlEntities(l[1]).trim();
      reactions.push({ reaction: text, actor: '' });
    }
  }
  return reactions;
}

function lastTimestampInBlock(block) {
  // The timestamp div is the last `_3-94 _a6-o` div in the message block.
  let ts = 0;
  const re = /<div class="_3-94 _a6-o">([^<]+)<\/div>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const parsed = parseDateTime(m[1]);
    if (parsed) ts = parsed;
  }
  return ts;
}

function previewFromBlock(block) {
  const contentHtml = extractContentHtml(block);
  if (contentHtml) {
    let t = contentHtml;
    t = t.replace(/<img[^>]*\/?>/g, '');
    t = t.replace(/<video[^>]*>[\s\S]*?<\/video>/g, '');
    t = t.replace(/<audio[^>]*>[\s\S]*?<\/audio>/g, '');
    t = t.replace(/<ul class="_a6-q">[\s\S]*?<\/ul>/g, '');
    t = t.replace(/<a [^>]*href="(https?:[^"]*)"[^>]*>[\s\S]*?<\/a>/g, ' $1 ');
    t = t.replace(/<\/div>/g, ' ');
    const text = decodeHtmlEntities(stripTags(t)).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
  }
  if (/<img\s+[^>]*src="[^"]*\/photos\//.test(block)) return '📷 Photo';
  if (/<video[^>]*\s+src="[^"]*\/videos\//.test(block)) return '🎥 Video';
  if (/<audio[^>]*\s+src="[^"]*\/audio\//.test(block)) return '🎙 Voice message';
  if (/<a [^>]*href="https?:/.test(block)) return '🔗 Link';
  return '';
}

function parseDateTime(s) {
  if (!s) return 0;
  // IG formats look like "Nov 17, 2025 5:10 pm". V8's Date parser handles
  // this, but the lowercase am/pm is sometimes finicky on older engines so
  // we normalize it to uppercase.
  const cleaned = s.trim().replace(/\s+(am|pm)\b/i, (_m, ap) => ' ' + ap.toUpperCase());
  const t = Date.parse(cleaned);
  return Number.isFinite(t) ? t : 0;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

const ENT_RE = /&(?:#(\d+);|#x([0-9a-fA-F]+);|([a-zA-Z]+);)/g;
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeHtmlEntities(s) {
  if (!s) return '';
  return s.replace(ENT_RE, (_match, dec, hex, name) => {
    if (dec) return safeFromCodePoint(parseInt(dec, 10));
    if (hex) return safeFromCodePoint(parseInt(hex, 16));
    if (name && name in NAMED) return NAMED[name];
    return _match;
  });
}

function safeFromCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}
