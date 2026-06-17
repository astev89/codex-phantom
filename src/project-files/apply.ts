import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { normalizeProjectFilePath } from "./drafts.ts";

export type ProjectFileApplyBeforeSnapshot = {
  path: string;
  existed: boolean;
  contentBase64?: string;
  /** Legacy rollback evidence shape from the first project-file apply slice. */
  content?: string;
  sizeBytes?: number;
  sha256?: string;
};

export type ProjectFileApplyResult = {
  path: string;
  before: ProjectFileApplyBeforeSnapshot;
  after: {
    path: string;
    sizeBytes: number;
    sha256: string;
  };
};

export class ProjectFileApplyService {
  private readonly repoRoot: string;

  constructor(input: { repoRoot: string }) {
    this.repoRoot = realpathSync(resolve(input.repoRoot));
  }

  apply(input: { path: string; content: string }): ProjectFileApplyResult {
    const path = normalizeProjectFilePath(input.path);
    const absolutePath = this.resolveProjectPath(path);
    this.assertNoSymlinkSegments(path);
    const before = this.snapshot(path, absolutePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.assertNoSymlinkSegments(path);
    writeFileSync(absolutePath, input.content, "utf8");
    const afterContent = readFileSync(absolutePath);
    return {
      path,
      before,
      after: {
        path,
        sizeBytes: afterContent.byteLength,
        sha256: sha256(afterContent),
      },
    };
  }

  rollback(snapshot: ProjectFileApplyBeforeSnapshot): void {
    const path = normalizeProjectFilePath(snapshot.path);
    const absolutePath = this.resolveProjectPath(path);
    this.assertNoSymlinkSegments(path);
    if (!snapshot.existed) {
      if (existsSync(absolutePath)) {
        unlinkSync(absolutePath);
      }
      return;
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.assertNoSymlinkSegments(path);
    writeFileSync(absolutePath, snapshotBytes(snapshot));
  }

  private snapshot(
    path: string,
    absolutePath: string
  ): ProjectFileApplyBeforeSnapshot {
    if (!existsSync(absolutePath)) {
      return { path, existed: false };
    }
    const content = readFileSync(absolutePath);
    return {
      path,
      existed: true,
      contentBase64: content.toString("base64"),
      sizeBytes: content.byteLength,
      sha256: sha256(content),
    };
  }

  private resolveProjectPath(path: string): string {
    const absolutePath = resolve(this.repoRoot, path);
    if (
      absolutePath !== this.repoRoot &&
      !absolutePath.startsWith(`${this.repoRoot}${sep}`)
    ) {
      throw new Error("projectFileApply.path must stay inside the repository");
    }
    return absolutePath;
  }

  private assertNoSymlinkSegments(path: string): void {
    const segments = path.split("/");
    let currentPath = this.repoRoot;
    for (const segment of segments) {
      currentPath = resolve(currentPath, segment);
      if (existsSync(currentPath) && lstatSync(currentPath).isSymbolicLink()) {
        throw new Error("projectFileApply.path cannot target symlinked paths");
      }
    }
  }
}

function snapshotBytes(snapshot: ProjectFileApplyBeforeSnapshot): Buffer {
  if (typeof snapshot.contentBase64 === "string") {
    return Buffer.from(snapshot.contentBase64, "base64");
  }
  return Buffer.from(snapshot.content ?? "", "utf8");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
