import type { ObjectInfo, Storage, StoredObject } from "../src/storage";

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { data: Uint8Array<ArrayBuffer>; contentType: string }>();

  async get(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new Blob([object.data]).stream(), size: object.data.byteLength, bytes: async () => object.data.slice() };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const object = this.objects.get(key);
    return object ? { size: object.data.byteLength } : null;
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { data: new Uint8Array(data), contentType });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  clear(): void {
    this.objects.clear();
  }
}
