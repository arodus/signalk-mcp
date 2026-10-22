import type { NativeApi } from "./native-api.js";
import type { LocalGet } from "./http.js";

// The supported servers publish these seven built-in documents independently of
// the caller. Cache metadata only, never provider results, tokens or approvals.
// Plugin documents remain live: plugins may change their contracts at runtime.
export class DiscoveryCache {
  private readonly documents = new Map<NativeApi, Promise<unknown>>();
  clear(): void {
    this.documents.clear();
  }
  async nativeDocument(api: NativeApi, get: LocalGet): Promise<unknown> {
    let pending = this.documents.get(api);
    if (!pending) {
      pending = Promise.resolve().then(() => get(`/skServer/openapi/${api}`));
      this.documents.set(api, pending);
    }
    try {
      return await pending;
    } catch (error) {
      // A missing document during startup or a cancelled request must not poison
      // later discovery. Never delete a newer lifecycle's in-flight request.
      if (this.documents.get(api) === pending) this.documents.delete(api);
      throw error;
    }
  }
}
