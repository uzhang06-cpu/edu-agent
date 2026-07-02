/**
 * services/cache.js
 * ──────────────────────────────────────────────────────────────────
 *  轻量 LRU 缓存 + TTL —— P1-3 用于工具结果去重（web_search 等重复问题）
 * ──────────────────────────────────────────────────────────────────
 */

class LRU {
  constructor({ max = 200, ttlMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttl = ttlMs;
    this.store = new Map();   // key → { value, expireAt }
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return undefined;
    if (item.expireAt && item.expireAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU：命中即移到末尾
    this.store.delete(key);
    this.store.set(key, item);
    return item.value;
  }

  set(key, value, ttlMs) {
    const expireAt = ttlMs ? Date.now() + ttlMs : (this.ttl ? Date.now() + this.ttl : 0);
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expireAt });
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  clear() { this.store.clear(); }
  size()  { return this.store.size; }
}

module.exports = { LRU };
