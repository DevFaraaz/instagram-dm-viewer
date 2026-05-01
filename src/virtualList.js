// Variable-height virtual list. Uses estimated heights up front, replaces them
// with measured ones after each render, and keeps a prefix-sum of offsets so
// `findFirstVisible` is a binary search instead of a linear scan. Items are
// rendered into a sandwiched <div>, with two spacer divs that account for the
// items above/below the rendered window.
const OVERSCAN = 6;

export class VirtualList {
  constructor({ viewport, spacerTop, spacerBottom, itemsContainer, items, renderItem, estimateHeight, onRender }) {
    this.viewport = viewport;
    this.spacerTop = spacerTop;
    this.spacerBottom = spacerBottom;
    this.itemsContainer = itemsContainer;
    this.renderItem = renderItem;
    this.estimateHeight = estimateHeight || (() => 60);
    this.onRender = onRender || null;

    this.items = items;
    this.heights = items.map((it, i) => this.estimateHeight(it, i));
    this.offsets = computeOffsets(this.heights);
    this.measured = new Uint8Array(items.length);

    this.start = 0;
    this.end = 0;
    this.rendered = new Map(); // index -> element
    this.pendingFrame = null;
    this.suppressScroll = false;

    this._onScroll = () => {
      if (this.pendingFrame) return;
      this.pendingFrame = requestAnimationFrame(() => {
        this.pendingFrame = null;
        this.render();
      });
    };
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });

    this._onResize = () => this.render();
    window.addEventListener('resize', this._onResize);

    this.updateSpacers();
    this.render();
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame);
    this.itemsContainer.replaceChildren();
    this.rendered.clear();
  }

  get totalHeight() {
    return this.offsets[this.items.length] || 0;
  }

  scrollToIndex(index, position = 'start') {
    const i = Math.max(0, Math.min(this.items.length - 1, index));
    const top = this.offsets[i];
    const itemHeight = this.heights[i];
    const viewportHeight = this.viewport.clientHeight;
    let target = top;
    if (position === 'center') target = top - (viewportHeight - itemHeight) / 2;
    else if (position === 'end') target = top - viewportHeight + itemHeight;
    this.viewport.scrollTop = Math.max(0, target);
    this.render();
  }

  scrollToBottom() {
    this.viewport.scrollTop = this.totalHeight;
    this.render();
  }

  isPinnedToBottom(threshold = 80) {
    const { scrollTop, clientHeight, scrollHeight } = this.viewport;
    return scrollHeight - (scrollTop + clientHeight) < threshold;
  }

  invalidateHeight(index) {
    if (index < 0 || index >= this.items.length) return;
    this.measured[index] = 0;
    this.render();
  }

  // Drop the rendered element for this index so the next render call rebuilds
  // it with current item data (used when search highlight changes).
  invalidateItem(index) {
    if (index < 0 || index >= this.items.length) return;
    const el = this.rendered.get(index);
    if (el) {
      el.remove();
      this.rendered.delete(index);
    }
    this.measured[index] = 0;
    this.render();
  }

  findFirstVisible(scrollTop) {
    const offsets = this.offsets;
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, this.items.length - 1);
  }

  updateSpacers() {
    const total = this.totalHeight;
    const topHeight = this.offsets[this.start] || 0;
    const bottomHeight = Math.max(0, total - (this.offsets[this.end] || 0));
    this.spacerTop.style.height = topHeight + 'px';
    this.spacerBottom.style.height = bottomHeight + 'px';
  }

  render() {
    if (this.items.length === 0) {
      this.itemsContainer.replaceChildren();
      this.rendered.clear();
      this.start = 0;
      this.end = 0;
      this.updateSpacers();
      return;
    }

    const scrollTop = this.viewport.scrollTop;
    const viewportHeight = this.viewport.clientHeight;
    const visibleStart = this.findFirstVisible(scrollTop);
    let start = Math.max(0, visibleStart - OVERSCAN);
    let end = start;
    const target = scrollTop + viewportHeight;
    while (end < this.items.length && this.offsets[end] < target) end++;
    end = Math.min(this.items.length, end + OVERSCAN);

    // Drop elements that have left the window.
    for (const [idx, el] of this.rendered) {
      if (idx < start || idx >= end) {
        el.remove();
        this.rendered.delete(idx);
      }
    }

    // Render new elements in order so DOM order matches index order.
    const frag = document.createDocumentFragment();
    let inserted = false;
    let firstNew = -1;
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.renderItem(this.items[i], i);
      el.dataset.idx = String(i);
      this.rendered.set(i, el);
      if (firstNew === -1) firstNew = i;
      inserted = true;
      // Insert in correct position relative to existing rendered items.
    }

    if (inserted) {
      // Rebuild children in numeric order. Cheap because rendered set is small.
      const ordered = [...this.rendered.entries()].sort((a, b) => a[0] - b[0]);
      this.itemsContainer.replaceChildren(...ordered.map((e) => e[1]));
    }

    this.start = start;
    this.end = end;
    this.updateSpacers();

    // Measure heights AFTER positioning. If they differ from estimate, update
    // offsets and adjust scrollTop so the visible content doesn't jump.
    let dirty = false;
    let scrollAdjust = 0;
    for (let i = start; i < end; i++) {
      if (this.measured[i]) continue;
      const el = this.rendered.get(i);
      if (!el) continue;
      const h = el.offsetHeight;
      if (h && Math.abs(h - this.heights[i]) > 0.5) {
        if (i < visibleStart) scrollAdjust += h - this.heights[i];
        this.heights[i] = h;
        dirty = true;
      }
      this.measured[i] = 1;
    }
    if (dirty) {
      this.offsets = computeOffsets(this.heights);
      this.updateSpacers();
      if (scrollAdjust !== 0) {
        this.suppressScroll = true;
        this.viewport.scrollTop = scrollTop + scrollAdjust;
        this.suppressScroll = false;
      }
    }

    if (this.onRender) this.onRender(start, end);
  }
}

function computeOffsets(heights) {
  const offsets = new Float64Array(heights.length + 1);
  let acc = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = acc;
    acc += heights[i];
  }
  offsets[heights.length] = acc;
  return offsets;
}
