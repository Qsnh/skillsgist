import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { S3Config } from "../src/config";
import { S3Storage, StorageError } from "../src/storage";

const CONFIG: S3Config = {
  endpoint: "http://s3.test:8333",
  region: "us-east-1",
  bucket: "skillsgist",
  accessKeyId: "key",
  secretAccessKey: "secret",
  forcePathStyle: true,
};

function answering(...responses: Response[]) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request) => {
    requests.push(input);
    return responses.shift() ?? new Response(null, { status: 500 });
  });
  return requests;
}

const xmlError = (status: number, code: string, message: string) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status });

describe("S3Storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs path-style requests to a custom endpoint", async () => {
    const requests = answering(new Response(null, { status: 200 }));
    await new S3Storage(CONFIG).put("skills/s1/abc.zip", new Uint8Array([1, 2, 3]), "application/zip");
    const [request] = requests;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("http://s3.test:8333/skillsgist/skills/s1/abc.zip");
    expect(request.headers.get("content-type")).toBe("application/zip");
    expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/us-east-1\/s3\/aws4_request/);
  });

  it("uses virtual-hosted addresses on AWS, in the configured region", async () => {
    const requests = answering(new Response(null, { status: 200 }));
    await new S3Storage({ ...CONFIG, endpoint: "", region: "eu-west-1", forcePathStyle: false }).head("skills/s1/abc.zip");
    expect(requests[0].url).toBe("https://skillsgist.s3.eu-west-1.amazonaws.com/skills/s1/abc.zip");
    expect(requests[0].method).toBe("HEAD");
  });

  it("reads an object as a stream with its size or as bytes, and a missing one as null", async () => {
    answering(
      new Response("zip-bytes", { headers: { "Content-Length": "9" } }),
      new Response("zip-bytes"),
      xmlError(404, "NoSuchKey", "gone"),
    );
    const storage = new S3Storage(CONFIG);
    const object = (await storage.get("a"))!;
    expect(object.size).toBe(9);
    expect(await new Response(object.body).text()).toBe("zip-bytes");
    expect(new TextDecoder().decode(await (await storage.get("a"))!.bytes())).toBe("zip-bytes");
    expect(await storage.get("missing")).toBeNull();
  });

  it("reads an object's size without its body, and a missing one as null", async () => {
    answering(new Response(null, { status: 200, headers: { "Content-Length": "1234" } }), new Response(null, { status: 404 }));
    const storage = new S3Storage(CONFIG);
    expect(await storage.head("a")).toEqual({ size: 1234 });
    expect(await storage.head("b")).toBeNull();
  });

  it("gives up on a store that does not answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (input: Request) =>
      new Promise((_, reject) => {
        if (input.signal.aborted) reject(input.signal.reason);
        input.signal.addEventListener("abort", () => reject(input.signal.reason));
      }),
    );
    try {
      const pending = expect(new S3Storage(CONFIG).get("a")).rejects.toThrow(/sent no response within 30000 ms/);
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats deleting a missing object as done", async () => {
    answering(new Response(null, { status: 204 }), new Response(null, { status: 404 }));
    const storage = new S3Storage(CONFIG);
    await expect(storage.delete("a")).resolves.toBeUndefined();
    await expect(storage.delete("b")).resolves.toBeUndefined();
  });

  it("reports S3's error code and message", async () => {
    answering(xmlError(403, "AccessDenied", "Access Denied"));
    const failure = new S3Storage(CONFIG).put("a", new Uint8Array([1]), "application/zip");
    await expect(failure).rejects.toBeInstanceOf(StorageError);
    answering(xmlError(403, "AccessDenied", "Access Denied"));
    await expect(new S3Storage(CONFIG).put("a", new Uint8Array([1]), "application/zip")).rejects.toThrow(
      "S3 PUT a failed with 403: AccessDenied Access Denied",
    );
  });

  it("creates a missing bucket, with a location constraint outside us-east-1 on AWS", async () => {
    const requests = answering(new Response(null, { status: 404 }), new Response(null, { status: 200 }));
    expect(await new S3Storage({ ...CONFIG, endpoint: "", region: "eu-west-1", forcePathStyle: false }).ensureBucket()).toBe("created");
    expect(requests.map((r) => r.method)).toEqual(["HEAD", "PUT"]);
    expect(await requests[1].text()).toContain("<LocationConstraint>eu-west-1</LocationConstraint>");
  });

  it("uses an existing bucket and stops on a bucket it may not read", async () => {
    answering(new Response(null, { status: 200 }));
    expect(await new S3Storage(CONFIG).ensureBucket()).toBe("exists");
    answering(new Response(null, { status: 403 }));
    await expect(new S3Storage(CONFIG).ensureBucket()).rejects.toThrow(/HEAD skillsgist failed with 403/);
  });
});

const live = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!live)("S3Storage against a real S3 service", () => {
  const storage = new S3Storage({
    endpoint: live ?? "",
    region: process.env.S3_TEST_REGION ?? "us-east-1",
    bucket: process.env.S3_TEST_BUCKET ?? "skillsgist-test",
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });

  it("creates the bucket, then stores, reads and deletes an object", async () => {
    await storage.ensureBucket();
    expect(await storage.ensureBucket()).toBe("exists");
    const key = `skills/test/${randomBytes(8).toString("hex")}.zip`;
    const data = new Uint8Array(randomBytes(64 * 1024));
    await storage.put(key, data, "application/zip");
    expect(await storage.head(key)).toEqual({ size: data.byteLength });
    expect(await (await storage.get(key))!.bytes()).toEqual(data);
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.get(key)).toBeNull();
  });
});
