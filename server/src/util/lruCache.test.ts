import { describe, test, expect } from 'bun:test';
import { LRUCache } from './lruCache';

describe('LRUCache', () => {
  function makeCache(maxEntries: number) {
    const evicted: Array<[string, number]> = [];
    const cache = new LRUCache<number>({
      maxEntries,
      maxBytes: Infinity,
      estimateSize: () => 1,
      onEvict(key, value) { evicted.push([key, value]); },
    });
    return { cache, evicted };
  }

  test('get() updates recency — accessed entry is not evicted', () => {
    const { cache, evicted } = makeCache(3);

    // Fill to capacity: a=1, b=2, c=3 (a is oldest)
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Access 'a' — should move it to most-recent
    const val = cache.get('a');
    expect(val).toBe(1);

    // Insert 'd' — evicts the true LRU, which is now 'b' (not 'a')
    cache.set('d', 4);

    expect(evicted).toEqual([['b', 2]]);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.get('b')).toBeUndefined();
  });

  test('set() evicts least-recently-used entry', () => {
    const { cache, evicted } = makeCache(2);

    cache.set('x', 10);
    cache.set('y', 20);

    // x is oldest; insert z to force eviction of x
    cache.set('z', 30);

    expect(evicted).toEqual([['x', 10]]);
    expect(cache.get('x')).toBeUndefined();
    expect(cache.get('y')).toBe(20);
    expect(cache.get('z')).toBe(30);
  });

  test('has() does not update recency', () => {
    const { cache, evicted } = makeCache(2);

    cache.set('x', 10);
    cache.set('y', 20);

    // has() should not promote x
    expect(cache.has('x')).toBe(true);

    cache.set('z', 30);

    // x should be evicted despite has() call
    expect(evicted).toEqual([['x', 10]]);
  });

  test('delete() removes entry and calls onEvict', () => {
    const { cache, evicted } = makeCache(5);
    cache.set('a', 1);

    const result = cache.delete('a');

    expect(result).toBe(true);
    expect(evicted).toEqual([['a', 1]]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('clear() evicts all entries', () => {
    const { cache, evicted } = makeCache(5);
    cache.set('a', 1);
    cache.set('b', 2);

    cache.clear();

    expect(evicted).toEqual([['a', 1], ['b', 2]]);
    expect(cache.size).toBe(0);
  });

  test('byte ceiling eviction', () => {
    const evicted: Array<[string, number]> = [];
    const cache = new LRUCache<number>({
      maxEntries: 10,
      maxBytes: 100,
      estimateSize: (v) => v,
      onEvict(key, value) { evicted.push([key, value]); },
    });

    cache.set('a', 60);
    cache.set('b', 50); // evicts a (60 + 50 > 100)

    expect(evicted).toEqual([['a', 60]]);
    expect(cache.bytes).toBe(50);
  });
});
