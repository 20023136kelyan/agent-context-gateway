/** Avatar and attachment uploads via pre-signed URLs. */
export class UploadsApi {
  constructor(api) {
    this.api = api;
  }

  /** Returns { uploadUrl, fileId }. The browser PUTs the bytes to uploadUrl directly. */
  begin({ name, size, contentType }) {
    if (size > 20 * 1024 * 1024) throw new Error("file too large (max 20 MB)");
    return this.api.post("/uploads", { name, size, contentType });
  }

  complete(fileId) {
    return this.api.post(`/uploads/${encodeURIComponent(fileId)}/complete`, {}, { idempotent: true });
  }
}
