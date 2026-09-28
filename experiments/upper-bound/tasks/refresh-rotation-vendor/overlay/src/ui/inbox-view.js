/**
 * InboxView: view model. Holds state for the screen and exposes actions.
 * Rendering lives in the framework layer; this file has no DOM access.
 */
export class InboxView {
  constructor({ services, onChange = () => {} }) {
    this.services = services;
    this.onChange = onChange;
    this.state = { loading: false, error: null, data: null };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async load(loader) {
    this.set({ loading: true, error: null });
    try {
      this.set({ loading: false, data: await loader(this.services) });
    } catch (err) {
      this.set({ loading: false, error: err?.message ?? String(err) });
    }
  }
}
