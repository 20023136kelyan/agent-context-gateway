/** P3 mDNS discovery tests — loopback announce/browse round-trip. */
import { describe, it, expect } from "vitest";
import { announce, discover } from "../src/discovery/mdns.js";

describe("mDNS discovery", () => {
  it("announced gateway is discoverable on loopback", async () => {
    const handle = announce(34971, { backend: "tantivy", docCount: 42 });
    try {
      const found = await discover(4000);
      const match = found.find((f) => f.port === 34971);
      expect(match).toBeTruthy();
      expect(match?.backend).toBe("tantivy");
      expect(match?.docCount).toBe(42);
    } finally {
      handle.stop();
    }
  }, 15000);
});
