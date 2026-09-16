import { openAsBlob } from 'node:fs';

type FetchLike = typeof fetch;
type BlobFactory = (path: string) => Promise<Blob>;

interface UploadResponse {
  code?: number;
  message?: string;
  data?: unknown;
}

export class CmccUploader {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly blobFactory: BlobFactory = openAsBlob
  ) {}

  async upload(apiKey: string, filePath: string, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('file', await this.blobFactory(filePath), fileName);
    form.append('apiKey', apiKey);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/upload`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new Error(`CMCC upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const raw = await response.text();
    let body: UploadResponse;
    try {
      body = JSON.parse(raw) as UploadResponse;
    } catch {
      throw new Error(`CMCC upload returned invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok || body.code !== 10200 || typeof body.data !== 'string' || !body.data) {
      throw new Error(body.message || `CMCC upload rejected (HTTP ${response.status}, code ${body.code ?? 'unknown'})`);
    }
    return body.data;
  }
}
