/** LruCache: bounded by entries and weight, evicts least recently used first. */
import { describe, it, expect } from "vitest";
import { LruCache } from "../src/core/lru.js";

describe("LruCache", () => {
  it("evicts the least recently used entry past the entry limit", () => {
    const c = new LruCache<string, number>(2, Infinity, () => 1);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // a is now most recent
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });

  it("evicts by weight, but always keeps the newest entry", () => {
    const c = new LruCache<string, string>(10, 10, (v) => v.length);
    c.set("a", "xxxx");
    c.set("b", "xxxx");
    c.set("c", "xxxx"); // 12 > 10 -> drop a
    expect(c.get("a")).toBeUndefined();
    expect(c.weight).toBe(8);
    c.set("huge", "x".repeat(50));
    expect(c.size).toBe(1);
    expect(c.get("huge")).toHaveLength(50);
  });

  it("replacing a key updates its weight", () => {
    const c = new LruCache<string, string>(10, 100, (v) => v.length);
    c.set("a", "xxxx");
    c.set("a", "xx");
    expect(c.weight).toBe(2);
    expect(c.size).toBe(1);
  });
});
