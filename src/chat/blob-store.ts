import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";

export type StoredBlob = {
  storagePath: string;
  sha256: string;
  sizeBytes: number;
};

export class ChatBlobStore {
  private readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = join(dataDir, "chat-blobs");
  }

  async write(id: string, content: Buffer): Promise<StoredBlob> {
    await mkdir(this.rootDir, { recursive: true });
    const storagePath = `${id}.blob`;
    await writeFile(join(this.rootDir, storagePath), content);
    return {
      storagePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength
    };
  }

  async read(storagePath: string): Promise<Buffer> {
    return readFile(join(this.rootDir, safeStoragePath(storagePath)));
  }
}

function safeStoragePath(storagePath: string): string {
  const normalized = normalize(storagePath);
  if (normalized !== basename(normalized)) {
    throw new Error("Invalid storage path");
  }
  return normalized;
}
