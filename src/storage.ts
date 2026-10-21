import { AwsClient } from "aws4fetch";
import type { S3Config } from "./config";

export interface ObjectInfo {
  size: number | null;
}

export interface StoredObject extends ObjectInfo {
  body: ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
}

export interface Storage {
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectInfo | null>;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    readonly operation: string,
    readonly key: string,
    readonly status: number,
    detail: string,
  ) {
    super(`S3 ${operation} ${key} failed with ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "StorageError";
  }
}

const AWS_DEFAULT = (region: string) => `https://s3.${region}.amazonaws.com`;

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;

const sizeOf = (res: Response) => {
  const length = Number(res.headers.get("Content-Length"));
  return Number.isSafeInteger(length) && length >= 0 && res.headers.has("Content-Length") ? length : null;
};

async function failure(operation: string, key: string, res: Response): Promise<StorageError> {
  const text = operation === "HEAD" ? "" : await res.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? "";
  return new StorageError(operation, key, res.status, [code, message].filter(Boolean).join(" "));
}

export class S3Storage implements Storage {
  private readonly client: AwsClient;
  private readonly bucketUrl: string;

  constructor(private readonly config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      retries: 3,
    });
    const base = new URL(config.endpoint || AWS_DEFAULT(config.region));
    this.bucketUrl = config.forcePathStyle
      ? `${base.origin}/${encodeURIComponent(config.bucket)}`
      : `${base.protocol}//${config.bucket}.${base.host}`;
  }

  private url(key: string): string {
    return `${this.bucketUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async get(key: string): Promise<StoredObject | null> {
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(new Error(`S3 GET ${key} sent no response within ${REQUEST_TIMEOUT_MS} ms`)), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.client.fetch(this.url(key), { signal: waiting.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) throw await failure("GET", key, res);
    return { body: res.body, size: sizeOf(res), bytes: async () => new Uint8Array(await res.arrayBuffer()) };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const res = await this.client.fetch(this.url(key), { method: "HEAD", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw await failure("HEAD", key, res);
    return { size: sizeOf(res) };
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: "PUT",
      body: data,
      headers: { "Content-Type": contentType, "Content-Length": String(data.byteLength) },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw await failure("PUT", key, res);
    await res.body?.cancel();
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: "DELETE", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok && res.status !== 404) throw await failure("DELETE", key, res);
    await res.body?.cancel();
  }

  async ensureBucket(): Promise<"exists" | "created"> {
    const head = await this.client.fetch(`${this.bucketUrl}/`, { method: "HEAD", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (head.ok) return "exists";
    if (head.status !== 404) throw await failure("HEAD", this.config.bucket, head);
    const body =
      this.config.endpoint === "" && this.config.region !== "us-east-1"
        ? `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.config.region}</LocationConstraint></CreateBucketConfiguration>`
        : undefined;
    const create = await this.client.fetch(`${this.bucketUrl}/`, { method: "PUT", body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!create.ok) throw await failure("CreateBucket", this.config.bucket, create);
    await create.body?.cancel();
    return "created";
  }
}
