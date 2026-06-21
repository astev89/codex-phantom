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
import {
  parseUnifiedProjectFilePatch,
  type ProjectFileParsedFilePatch,
} from "./patches.ts";

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

export type ProjectFilePatchApplyItem = {
  path: string;
  before: ProjectFileApplyBeforeSnapshot;
  after: {
    path: string;
    sizeBytes: number;
    sha256: string;
  };
};

export type ProjectFilePatchApplyResult = {
  files: ProjectFilePatchApplyItem[];
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

  applyPatch(input: { patch: string }): ProjectFilePatchApplyResult {
    const parsed = parseUnifiedProjectFilePatch(input.patch);
    const planned = parsed.files.map((filePatch) =>
      this.planPatchFile(filePatch)
    );
    const files: ProjectFilePatchApplyItem[] = [];
    try {
      for (const item of planned) {
        const result = this.apply({
          path: item.path,
          content: item.afterContent,
        });
        files.push({
          path: item.path,
          before: result.before,
          after: result.after,
        });
      }
    } catch (error) {
      for (const file of files.slice().reverse()) {
        this.rollback(file.before);
      }
      throw error;
    }
    return { files };
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

  assertRollbackSafe(snapshot: ProjectFileApplyBeforeSnapshot): void {
    const path = normalizeProjectFilePath(snapshot.path);
    this.resolveProjectPath(path);
    this.assertNoSymlinkSegments(path);
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

  private planPatchFile(filePatch: ProjectFileParsedFilePatch): {
    path: string;
    before: ProjectFileApplyBeforeSnapshot;
    afterContent: string;
  } {
    const path = normalizeProjectFilePath(filePatch.path);
    const absolutePath = this.resolveProjectPath(path);
    this.assertNoSymlinkSegments(path);
    const before = this.snapshot(path, absolutePath);
    const beforeContent = before.existed
      ? readTextProjectFile(absolutePath, path)
      : "";
    if (!before.existed && filePatch.oldPath) {
      throw new Error(`projectFilePatch.path does not exist: ${path}`);
    }
    return {
      path,
      before,
      afterContent: applyParsedFilePatch(beforeContent, filePatch),
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

function readTextProjectFile(absolutePath: string, path: string): string {
  const content = readFileSync(absolutePath);
  if (content.includes(0)) {
    throw new Error(`projectFilePatch.path must be text: ${path}`);
  }
  return content.toString("utf8");
}

function applyParsedFilePatch(
  content: string,
  filePatch: ProjectFileParsedFilePatch
): string {
  const originalLines = splitPatchContentLines(content);
  const originalEndsWithNewline = content.endsWith("\n");
  const output: string[] = [];
  let originalIndex = 0;
  for (const hunk of filePatch.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < originalIndex || hunkStart > originalLines.length) {
      throw new Error(
        `projectFilePatch.context does not match for ${filePatch.path}`
      );
    }
    output.push(...originalLines.slice(originalIndex, hunkStart));
    originalIndex = hunkStart;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }
      if (originalLines[originalIndex] !== line.text) {
        throw new Error(
          `projectFilePatch.context does not match for ${filePatch.path}`
        );
      }
      if (line.kind === "context") {
        output.push(line.text);
      }
      originalIndex += 1;
    }
  }
  output.push(...originalLines.slice(originalIndex));
  let result = output.join("\n");
  const finalHunk = filePatch.hunks.at(-1);
  const finalHunkTouchesEnd =
    finalHunk !== undefined &&
    finalHunk.newStart + finalHunk.newCount - 1 >= output.length;
  if (
    filePatch.newEndsWithNewline &&
    result !== "" &&
    !result.endsWith("\n") &&
    (originalEndsWithNewline || finalHunkTouchesEnd)
  ) {
    result += "\n";
  }
  return result;
}

function splitPatchContentLines(content: string): string[] {
  if (content === "") {
    return [];
  }
  if (!content.endsWith("\n")) {
    return content.split("\n");
  }
  const withoutFinalNewline = content.slice(0, -1);
  return withoutFinalNewline === "" ? [""] : withoutFinalNewline.split("\n");
}
