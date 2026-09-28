import { Emitter } from "./lib/events.js";

/** Remote feature flags, refreshed every few minutes. Unknown flags are off. */
export class FeatureFlags extends Emitter {
  constructor({ fetchFlags, defaults = {} }) {
    super();
    this.fetchFlags = fetchFlags;
    this.flags = { ...defaults };
  }

  isOn(name) {
    return this.flags[name] === true;
  }

  async refresh() {
    try {
      const next = await this.fetchFlags();
      const changed = Object.keys({ ...this.flags, ...next }).filter((k) => this.flags[k] !== next[k]);
      this.flags = { ...next };
      if (changed.length) this.emit("change", changed);
    } catch {
      // keep the last known flags
    }
  }
}
