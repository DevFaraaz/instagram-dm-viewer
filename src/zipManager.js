import { Unzip, UnzipInflate, AsyncUnzipInflate } from 'fflate';

// Streams a ZIP through fflate's Unzip class, decompressing each entry as it
// arrives so the original ZIP buffer never needs to live fully in memory.
// Decompressed entries are stored as Uint8Arrays for random access by path.
//
// Two callbacks let the UI separate the "still reading bytes" phase from the
// "still finalizing entries" phase that runs after the file stream ends:
//   onProgress(readBytes, totalBytes)
//   onEntry(entriesDoneSoFar, lastPath)
export class ZipManager {
  constructor() {
    this.files = new Map();
    this.totalBytes = 0;
  }

  has(path) {
    return this.files.has(path);
  }

  get size() {
    return this.files.size;
  }

  paths() {
    return this.files.keys();
  }

  getBytes(path) {
    return this.files.get(path) ?? null;
  }

  getText(path) {
    const data = this.files.get(path);
    if (!data) return null;
    return new TextDecoder('utf-8').decode(data);
  }

  getBlob(path, mimeType) {
    const data = this.files.get(path);
    if (!data) return null;
    return new Blob([data], { type: mimeType || 'application/octet-stream' });
  }

  pathsWithPrefix(prefix) {
    const out = [];
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) out.push(path);
    }
    return out;
  }

  async load(file, onProgress, onEntry) {
    return new Promise((resolve, reject) => {
      const unzipper = new Unzip();
      // AsyncUnzipInflate runs deflate inside a worker, keeping the UI thread
      // free for progress redraws. UnzipInflate is registered as a fallback
      // for environments where workers aren't available (some tests).
      try {
        unzipper.register(AsyncUnzipInflate);
      } catch (_e) {
        unzipper.register(UnzipInflate);
      }

      let pendingEntries = 0;
      let entriesDone = 0;
      let streamDone = false;
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(this);
      };

      unzipper.onfile = (entry) => {
        // Skip directory placeholders without registering them as pending; in
        // streaming Unzip you just don't call start() for entries you don't
        // want to read.
        if (entry.name.endsWith('/')) return;

        pendingEntries++;
        const chunks = [];
        let length = 0;
        entry.ondata = (err, data, final) => {
          if (err) {
            pendingEntries--;
            return finish(err);
          }
          if (data && data.length) {
            chunks.push(data);
            length += data.length;
          }
          if (final) {
            const merged = mergeChunks(chunks, length);
            this.files.set(entry.name, merged);
            this.totalBytes += merged.length;
            pendingEntries--;
            entriesDone++;
            if (onEntry) onEntry(entriesDone, entry.name);
            if (streamDone && pendingEntries === 0) finish(null);
          }
        };
        try {
          entry.start();
        } catch (e) {
          pendingEntries--;
          finish(e);
        }
      };

      const reader = file.stream().getReader();
      let read = 0;
      const total = file.size || 0;

      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (settled) return;
            if (done) {
              try {
                unzipper.push(new Uint8Array(0), true);
              } catch (e) {
                return finish(e);
              }
              streamDone = true;
              if (pendingEntries === 0) finish(null);
              return;
            }
            read += value.length;
            if (onProgress && total) onProgress(read, total);
            try {
              unzipper.push(value, false);
            } catch (e) {
              return finish(e);
            }
            pump();
          })
          .catch((err) => finish(err));
      };
      pump();
    });
  }
}

function mergeChunks(chunks, length) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
