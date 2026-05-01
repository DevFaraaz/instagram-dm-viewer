// Builds public/sample-export.zip — a tiny fake Instagram data export with
// a handful of conversations, used so the live demo can be tried instantly
// without finding a real export. Runs as part of `npm run build` via the
// `prebuild` script in package.json.
//
// Output mirrors IG's actual HTML export layout:
//   your_instagram_activity/messages/inbox/<folder>/message_1.html
//   your_instagram_activity/messages/inbox/<folder>/photos/<file>.png
//
// All people, messages, and images are fictional.

import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------- PNG synthesis ----------
// We need real bitmap bytes so the demo's photos render rather than showing
// "missing media" placeholders. Hand-rolling a tiny solid-color PNG keeps the
// bundle small and avoids any image-library dependency.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Generates a width × height PNG that's a solid background with a colored
// stripe across the middle — just enough variation that two sample images
// look distinct in the chat thumbnails.
function makePng(width, height, bg, stripe) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: RGB
  // remaining bytes (compression, filter, interlace) are 0 by default

  // Each scanline is `1 filter byte + width*3 RGB bytes`.
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  const stripeStart = Math.floor(height * 0.4);
  const stripeEnd = Math.floor(height * 0.6);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter type "none"
    const c = y >= stripeStart && y < stripeEnd ? stripe : bg;
    for (let x = 0; x < width; x++) {
      const o = y * rowBytes + 1 + x * 3;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  // PNG IDAT must hold a zlib stream. deflateRawSync gives raw deflate; wrap
  // with the 2-byte zlib header + 4-byte Adler-32 trailer.
  const deflated = deflateRawSync(raw);
  const adler = adler32(raw);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler, 0);
  const idatPayload = Buffer.concat([Buffer.from([0x78, 0x9c]), deflated, adlerBuf]);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatPayload),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- HTML helpers ----------
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmtDate(d) {
  // "May 01, 2026 2:34 pm" — IG's exact format, lowercase am/pm.
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  let h = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${mm} ${dd}, ${yyyy} ${h}:${mins} ${ap}`;
}

function buildMessageBlock(msg) {
  const sender = escapeHtml(msg.sender);
  let mediaHtml = '';
  if (msg.photos) {
    mediaHtml = msg.photos
      .map(
        (uri) =>
          `<div><div><a target="_blank" href="${escapeHtml(uri)}"><img src="${escapeHtml(uri)}" class="_a6_o _3-96"/></a></div></div>`
      )
      .join('');
  }

  const reactionsHtml = (msg.reactions || []).length
    ? `<div><ul class="_a6-q">${msg.reactions
        .map(
          (r) =>
            `<li><span>${escapeHtml(r.emoji + r.actor)}<span> (${escapeHtml(fmtDate(new Date(msg.ts.getTime() + 60_000)))})</span></span></li>`
        )
        .join('')}</ul></div>`
    : '';

  return `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${sender}</h2><div class="_3-95 _a6-p"><div><div></div><div>${escapeHtml(msg.text || '')}</div><div>${mediaHtml}</div><div></div>${reactionsHtml}</div></div><div class="_3-94 _a6-o">${fmtDate(msg.ts)}</div></div>`;
}

function buildHtml(convo) {
  // IG writes messages newest-first inside the file; sort accordingly.
  const sorted = [...convo.messages].sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const title = escapeHtml(convo.title);
  const head = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><base href="../../../../"/><title>${title}</title></head><body class="_5vb_ _2yq _a7o5"><div class="_li"><div class="_a705"><header class="_as-_ _a70a" aria-labelledby="t"><div class="_a70d"><h1 id="t">${title}</h1></div></header><main class="_a706" role="main">`;
  const tail = `</main></div></div></body></html>`;
  return head + sorted.map(buildMessageBlock).join('') + tail;
}

// ---------- Sample data ----------
function ts(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi);
}

const ME = 'You';

const convos = [
  {
    folder: 'mia_chen_148291',
    title: 'Mia Chen',
    photos: {
      'IMG_4821.png': makePng(280, 180, [255, 220, 235], [212, 110, 165]),
      'IMG_4822.png': makePng(280, 180, [220, 235, 255], [80, 130, 220]),
    },
    messages: [
      { sender: 'Mia Chen', text: "did you see what jess posted??", ts: ts(2026, 4, 28, 22, 14) },
      { sender: ME, text: 'wait what 👀', ts: ts(2026, 4, 28, 22, 16) },
      { sender: 'Mia Chen', text: 'one sec sending', ts: ts(2026, 4, 28, 22, 16) },
      {
        sender: 'Mia Chen',
        text: '',
        photos: ['your_instagram_activity/messages/inbox/mia_chen_148291/photos/IMG_4821.png'],
        ts: ts(2026, 4, 28, 22, 17),
      },
      { sender: ME, text: 'WHAT 😭😭', ts: ts(2026, 4, 28, 22, 18), reactions: [{ emoji: '😂', actor: 'Mia Chen' }] },
      { sender: ME, text: 'literally crying', ts: ts(2026, 4, 28, 22, 18) },
      { sender: 'Mia Chen', text: 'i KNOW', ts: ts(2026, 4, 28, 22, 19) },
      { sender: 'Mia Chen', text: 'are you free saturday btw', ts: ts(2026, 4, 29, 9, 2) },
      { sender: ME, text: 'i think yeah, brunch?', ts: ts(2026, 4, 29, 9, 14) },
      { sender: 'Mia Chen', text: 'yes pls. that place with the matcha pancakes', ts: ts(2026, 4, 29, 9, 15) },
      {
        sender: ME,
        text: 'sold',
        photos: ['your_instagram_activity/messages/inbox/mia_chen_148291/photos/IMG_4822.png'],
        ts: ts(2026, 4, 29, 9, 16),
      },
      { sender: 'Mia Chen', text: '11am ok?', ts: ts(2026, 4, 30, 10, 30) },
      { sender: ME, text: '11am works', ts: ts(2026, 4, 30, 10, 31), reactions: [{ emoji: '❤️', actor: 'Mia Chen' }] },
    ],
  },
  {
    folder: 'roadtrip_squad_902341',
    title: 'roadtrip squad 🚐',
    messages: [
      { sender: 'Alex Park', text: 'ok so airbnb or motel?', ts: ts(2026, 4, 27, 19, 45) },
      { sender: 'Jordan Rivera', text: 'airbnb. motel = horror movie', ts: ts(2026, 4, 27, 19, 46) },
      { sender: 'Sam Wu', text: 'lol jordan', ts: ts(2026, 4, 27, 19, 46) },
      { sender: ME, text: 'airbnb +1', ts: ts(2026, 4, 27, 19, 48) },
      { sender: 'Mia Chen', text: 'alex u driving right', ts: ts(2026, 4, 27, 19, 49) },
      { sender: 'Alex Park', text: 'ya i got the car. need 2 cosign on aux tho', ts: ts(2026, 4, 27, 19, 50) },
      { sender: 'Sam Wu', text: 'bold of you to assume there will be aux democracy', ts: ts(2026, 4, 27, 19, 51) },
      { sender: 'Jordan Rivera', text: 'i call dibs on the playlist for the first 3 hours', ts: ts(2026, 4, 27, 19, 52) },
      { sender: ME, text: 'splitting cost 5 ways?', ts: ts(2026, 4, 28, 8, 2) },
      { sender: 'Alex Park', text: 'yes. ill venmo request after', ts: ts(2026, 4, 28, 8, 4) },
      { sender: 'Mia Chen', text: 'leaving friday 6am sharp', ts: ts(2026, 4, 29, 21, 11) },
      { sender: 'Sam Wu', text: 'sharp. mhm.', ts: ts(2026, 4, 29, 21, 12), reactions: [{ emoji: '😂', actor: 'Jordan Rivera' }] },
    ],
  },
  {
    folder: 'mom_4920183',
    title: 'Mom',
    messages: [
      { sender: 'Mom', text: 'Did you eat?', ts: ts(2026, 4, 30, 13, 12) },
      { sender: ME, text: 'yes mom', ts: ts(2026, 4, 30, 13, 14) },
      { sender: 'Mom', text: 'What did you eat?', ts: ts(2026, 4, 30, 13, 14) },
      { sender: ME, text: 'leftover pasta', ts: ts(2026, 4, 30, 13, 15) },
      { sender: 'Mom', text: 'Good ❤️', ts: ts(2026, 4, 30, 13, 16) },
      { sender: 'Mom', text: 'Call when you can', ts: ts(2026, 4, 30, 13, 16) },
    ],
  },
  {
    folder: 'priya_38271',
    title: 'Priya Nair',
    messages: [
      { sender: 'Priya Nair', text: 'hey! it has been forever', ts: ts(2026, 4, 25, 17, 22) },
      { sender: 'Priya Nair', text: 'how have you been', ts: ts(2026, 4, 25, 17, 22) },
      { sender: ME, text: 'priya!! holy crap', ts: ts(2026, 4, 26, 11, 8) },
      { sender: ME, text: 'good actually. moved to a new place last month', ts: ts(2026, 4, 26, 11, 9) },
      { sender: 'Priya Nair', text: 'oh nice where', ts: ts(2026, 4, 26, 11, 14) },
      { sender: ME, text: 'east side. tiny apt but sunlight is unreal', ts: ts(2026, 4, 26, 11, 15) },
      { sender: 'Priya Nair', text: 'omg send pics', ts: ts(2026, 4, 26, 11, 16) },
    ],
  },
  {
    folder: 'devon_hartley_22910',
    title: 'Devon Hartley',
    messages: [
      { sender: 'Devon Hartley', text: 'send the doc when you get a sec', ts: ts(2026, 4, 24, 14, 30) },
      { sender: ME, text: 'on it. give me 20', ts: ts(2026, 4, 24, 14, 33) },
      { sender: ME, text: 'sent', ts: ts(2026, 4, 24, 14, 56) },
      { sender: 'Devon Hartley', text: 'ty', ts: ts(2026, 4, 24, 14, 58), reactions: [{ emoji: '👍', actor: ME }] },
    ],
  },
];

// ---------- Build & write ----------
const files = {};
for (const c of convos) {
  files[`your_instagram_activity/messages/inbox/${c.folder}/message_1.html`] = strToU8(buildHtml(c));
  if (c.photos) {
    for (const [name, bytes] of Object.entries(c.photos)) {
      files[`your_instagram_activity/messages/inbox/${c.folder}/photos/${name}`] = new Uint8Array(bytes);
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const outPath = resolve(repoRoot, 'public', 'sample-export.zip');
mkdirSync(dirname(outPath), { recursive: true });

const zipped = zipSync(files);
writeFileSync(outPath, zipped);

const totalMsgs = convos.reduce((n, c) => n + c.messages.length, 0);
console.log(
  `Wrote ${outPath.replace(repoRoot + '/', '')} — ${(zipped.length / 1024).toFixed(0)}KB, ${convos.length} conversations, ${totalMsgs} messages`
);
