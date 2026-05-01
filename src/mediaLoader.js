import { mimeFromPath } from './utils.js';

// Caches object URLs created from in-memory ZIP bytes so the same media element
// reused across virtual-list re-renders doesn't allocate fresh URLs each time.
export class MediaLoader {
  constructor(zip) {
    this.zip = zip;
    this.cache = new Map(); // path -> object URL
  }

  resolve(path) {
    if (!path) return null;
    if (this.cache.has(path)) return this.cache.get(path);

    let bytes = this.zip.getBytes(path);
    // Instagram sometimes puts a leading slash on uri or escapes it.
    if (!bytes && path.startsWith('/')) bytes = this.zip.getBytes(path.slice(1));
    if (!bytes) {
      // Try basename fallback against any messages/inbox path.
      const base = path.split('/').pop();
      if (base) {
        for (const candidate of this.zip.paths()) {
          if (candidate.endsWith('/' + base)) {
            bytes = this.zip.getBytes(candidate);
            break;
          }
        }
      }
    }
    if (!bytes) return null;

    const blob = new Blob([bytes], { type: mimeFromPath(path) });
    const url = URL.createObjectURL(blob);
    this.cache.set(path, url);
    return url;
  }

  // Free every object URL we've handed out — called when leaving a thread.
  releaseAll() {
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
  }
}
