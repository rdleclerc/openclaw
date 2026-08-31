// Tests atomic file replacement helpers and permission handling.
import { execFileSync, spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ReplaceFileAtomicFileSystem,
  ReplaceFileAtomicSyncFileSystem,
} from "@openclaw/fs-safe/atomic";
import { replaceFileAtomic, replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { movePathWithCopyFallback } from "./replace-file.js";

type AtomicApi = "async" | "sync";
type CollisionKind = "regular" | "hardlink";
type SpecialCollisionKind = "fifo" | "symlink";
type DestinationKind = "symlink" | "hardlink-alias" | "fifo";
type InterruptStage = "remove" | "open" | "partial" | "after-write";

type Stat = Awaited<ReturnType<typeof fs.lstat>>;
type PathSnapshot = { kind: string; bytes?: Buffer } & Partial<
  Pick<Stat, "mode" | "uid" | "gid" | "ino" | "nlink">
>;

type ChildResult = { code: number | null; stderr: string };

function makeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function makeAsyncFs(
  overrides: Partial<ReplaceFileAtomicFileSystem["promises"]> = {},
): ReplaceFileAtomicFileSystem {
  return { promises: { ...fs, ...overrides } };
}

function makeSyncFs(
  overrides: Partial<ReplaceFileAtomicSyncFileSystem> = {},
): ReplaceFileAtomicSyncFileSystem {
  return { ...fsSync, ...overrides };
}

function makeRenameFailureFs(
  api: AtomicApi,
  renameError: NodeJS.ErrnoException,
  capture?: (source: string) => void,
): ReplaceFileAtomicFileSystem | ReplaceFileAtomicSyncFileSystem {
  const fail = (source: unknown): never => {
    capture?.(String(source));
    throw renameError;
  };
  return api === "async"
    ? makeAsyncFs({ rename: async (source) => fail(source) })
    : makeSyncFs({ renameSync: (source) => fail(source) });
}

function makeCleanupFailureFs(
  api: AtomicApi,
  renameError: NodeJS.ErrnoException,
  cleanupError: NodeJS.ErrnoException,
  capture: (source: string) => void,
) {
  let tempPath: string | undefined;
  const fileSystem = makeRenameFailureFs(api, renameError, (source) => {
    tempPath = source;
    capture(source);
  });
  if (api === "async") {
    (fileSystem as ReplaceFileAtomicFileSystem).promises.rm = async (entry, options) => {
      if (String(entry) === tempPath) throw cleanupError;
      return fs.rm(entry, options);
    };
  } else {
    (fileSystem as ReplaceFileAtomicSyncFileSystem).rmSync = (entry) => {
      if (String(entry) === tempPath) throw cleanupError;
      return fsSync.rmSync(entry, { force: true });
    };
  }
  return fileSystem;
}

function makeBusyRetryFs(api: AtomicApi, attempts: { value: number }) {
  const update = () => {
    attempts.value += 1;
    if (attempts.value === 1) throw makeError("EBUSY");
  };
  return api === "async"
    ? makeAsyncFs({
        rename: async (source, destination) => (update(), fs.rename(source, destination)),
      })
    : makeSyncFs({
        renameSync: (source, destination) => (update(), fsSync.renameSync(source, destination)),
      });
}

type AtomicCall = {
  api: AtomicApi;
  fileSystem: ReplaceFileAtomicFileSystem | ReplaceFileAtomicSyncFileSystem;
  options: {
    filePath: string;
    content: string;
    copyFallbackOnPermissionError?: boolean;
    throwOnCleanupError?: boolean;
    tempPrefix?: string;
    renameMaxRetries?: number;
    renameRetryBaseDelayMs?: number;
  };
};

async function callAtomic(params: AtomicCall): Promise<unknown> {
  if (params.api === "async") {
    return replaceFileAtomic({
      ...params.options,
      fileSystem: params.fileSystem as ReplaceFileAtomicFileSystem,
    });
  }
  return replaceFileAtomicSync({
    ...params.options,
    fileSystem: params.fileSystem as ReplaceFileAtomicSyncFileSystem,
  });
}

async function snapshot(filePath: string): Promise<PathSnapshot> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
  const kind = stat.isFile()
    ? "file"
    : stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFIFO()
          ? "fifo"
          : "other";
  return {
    kind,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    ino: stat.ino,
    nlink: stat.nlink,
    ...(stat.isFile() ? { bytes: await fs.readFile(filePath) } : {}),
  };
}

async function makeTarget(root: string): Promise<{ filePath: string; before: PathSnapshot }> {
  const filePath = path.join(root, "target.txt");
  await fs.writeFile(filePath, "old");
  await fs.chmod(filePath, 0o640);
  return { filePath, before: await snapshot(filePath) };
}

function makeFifo(filePath: string): void {
  execFileSync("mkfifo", ["-m", "0640", filePath]);
}

function makeSpecialCollision(
  filePath: string,
  entry: string,
  kind: SpecialCollisionKind,
): PathSnapshot {
  if (kind === "fifo") makeFifo(entry);
  else fsSync.symlinkSync(filePath, entry);
  const stat = fsSync.lstatSync(entry);
  return {
    kind,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    ino: stat.ino,
    nlink: stat.nlink,
  };
}

type DestinationFixture = {
  filePath: string;
  before: PathSnapshot;
  aliasPath?: string;
  targetPath?: string;
};

async function makeDestinationFixture(
  root: string,
  kind: DestinationKind,
): Promise<DestinationFixture> {
  const filePath = path.join(root, "target.txt");
  let aliasPath: string | undefined;
  let targetPath: string | undefined;
  if (kind === "symlink") {
    targetPath = path.join(root, "outside.txt");
    await fs.writeFile(targetPath, "outside");
    await fs.symlink(targetPath, filePath);
  } else if (kind === "hardlink-alias") {
    aliasPath = path.join(root, "target-alias.txt");
    await fs.writeFile(filePath, "old");
    await fs.chmod(filePath, 0o640);
    await fs.link(filePath, aliasPath);
  } else {
    makeFifo(filePath);
  }
  return { filePath, before: await snapshot(filePath), aliasPath, targetPath };
}

function expectStableIdentity(before: PathSnapshot, after: PathSnapshot): void {
  expect(after.kind).toBe(before.kind);
  expect(after.bytes).toEqual(before.bytes);
  expect(after.mode).toBe(before.mode);
  expect(after.uid).toBe(before.uid);
  expect(after.gid).toBe(before.gid);
  expect(after.ino).toBe(before.ino);
}

function makeSyncCollision(
  filePath: string,
  entry: string,
  collision: CollisionKind | SpecialCollisionKind,
): PathSnapshot {
  if (collision === "regular") {
    fsSync.writeFileSync(entry, "foreign", { flag: "wx", mode: 0o640 });
  } else if (collision === "hardlink") {
    fsSync.linkSync(filePath, entry);
  } else {
    return makeSpecialCollision(filePath, entry, collision);
  }
  const stat = fsSync.lstatSync(entry);
  return {
    kind: "file",
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    ino: stat.ino,
    nlink: stat.nlink,
    bytes: fsSync.readFileSync(entry),
  };
}

function runNodeChild(source: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

type ChildScriptParams = {
  api: AtomicApi;
  filePath: string;
  stage?: InterruptStage;
  collision?: CollisionKind;
  cleanupReuse?: CollisionKind;
  reuseAfterSuccess?: boolean;
  markerPath?: string;
  tempPrefix?: string;
};

function makeChildScript(params: ChildScriptParams): string {
  const filePath = JSON.stringify(params.filePath);
  const stage = JSON.stringify(params.stage ?? "");
  const collision = JSON.stringify(params.collision ?? "");
  const cleanupReuse = JSON.stringify(params.cleanupReuse ?? "");
  const reuseAfterSuccess = params.reuseAfterSuccess ? "true" : "false";
  const markerPath = JSON.stringify(params.markerPath ?? "");
  const tempPrefix = params.tempPrefix ? `tempPrefix,` : "";
  const beforeRename = params.reuseAfterSuccess
    ? "beforeRename: ({ tempPath }) => fsSync.writeFileSync(markerPath, tempPath),"
    : "";
  const cleanupOption = params.cleanupReuse ? "throwOnCleanupError: true," : "";
  const call =
    params.api === "async"
      ? `await replaceFileAtomic({ filePath, content: "new", ${tempPrefix} ${beforeRename} ${cleanupOption} copyFallbackOnPermissionError: true, fileSystem: { promises } });`
      : `replaceFileAtomicSync({ filePath, content: "new", ${tempPrefix} ${beforeRename} ${cleanupOption} copyFallbackOnPermissionError: true, fileSystem: syncFileSystem });`;
  return `
import * as fsPromises from "node:fs/promises";
import * as fsSync from "node:fs";
import { replaceFileAtomic, replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
const filePath = ${filePath};
const stage = ${stage};
const collision = ${collision};
const cleanupReuse = ${cleanupReuse};
const reuseAfterSuccess = ${reuseAfterSuccess};
const markerPath = ${markerPath};
${params.tempPrefix ? `const tempPrefix = ${JSON.stringify(params.tempPrefix)};` : ""}
const renameError = () => Object.assign(new Error("EPERM"), { code: "EPERM" });
const cleanupError = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const createCollision = async (entry, kind = collision) => kind === "regular"
  ? fsPromises.writeFile(entry, "foreign", { flag: "wx", mode: 0o640 })
  : fsPromises.link(filePath, entry);
let destinationFd;
const promises = {
  ...fsPromises,
  rename: async (source, destination) => {
    if (reuseAfterSuccess) return fsPromises.rename(source, destination);
    throw renameError();
  },
  chmod: async (entry, mode) => {
    if (reuseAfterSuccess && entry === filePath) {
      const reusedPath = fsSync.readFileSync(markerPath, "utf8");
      fsSync.writeFileSync(reusedPath, "foreign", { flag: "wx" });
      process.exit(0);
    }
    return fsPromises.chmod(entry, mode);
  },
  rm: async (entry, options) => {
    const result = await fsPromises.rm(entry, options);
    if (cleanupReuse && entry !== filePath) {
      await createCollision(entry, cleanupReuse);
      throw cleanupError();
    }
    if (stage === "remove" && entry === filePath) process.exit(0);
    return result;
  },
  open: async (entry, ...args) => {
    const handle = await fsPromises.open(entry, ...args);
    if (entry === filePath && stage === "open") process.exit(0);
    if (entry === filePath && stage === "partial") {
      return {
        writeFile: async () => { await handle.writeFile("partial"); process.exit(0); },
        close: handle.close.bind(handle),
      };
    }
    return handle;
  },
  writeFile: async (entry, ...args) => {
    if (collision) {
      await createCollision(entry);
      process.exit(0);
    }
    const result = await fsPromises.writeFile(entry, ...args);
    if (stage === "after-write") process.exit(0);
    return result;
  },
};
const syncFileSystem = {
  ...fsSync,
  renameSync: (source, destination) => {
    if (reuseAfterSuccess) return fsSync.renameSync(source, destination);
    throw renameError();
  },
  chmodSync: (entry, mode) => {
    if (reuseAfterSuccess && entry === filePath) {
      const reusedPath = fsSync.readFileSync(markerPath, "utf8");
      fsSync.writeFileSync(reusedPath, "foreign", { flag: "wx" });
      process.exit(0);
    }
    return fsSync.chmodSync(entry, mode);
  },
  rmSync: (entry, options) => {
    const result = fsSync.rmSync(entry, options);
    if (cleanupReuse && entry !== filePath) {
      if (cleanupReuse === "regular") {
        fsSync.writeFileSync(entry, "foreign", { flag: "wx", mode: 0o640 });
      } else {
        fsSync.linkSync(filePath, entry);
      }
      throw cleanupError();
    }
    if (stage === "remove" && entry === filePath) process.exit(0);
    return result;
  },
  openSync: (entry, ...args) => {
    const fd = fsSync.openSync(entry, ...args);
    if (entry === filePath) {
      destinationFd = fd;
      if (stage === "open") process.exit(0);
    }
    return fd;
  },
  writeFileSync: (entry, ...args) => {
    if (collision && typeof entry === "string") {
      if (collision === "regular") fsSync.writeFileSync(entry, "foreign", { flag: "wx", mode: 0o640 });
      else fsSync.linkSync(filePath, entry);
      process.exit(0);
    }
    if (stage === "partial" && entry === destinationFd) {
      fsSync.writeFileSync(entry, "partial");
      process.exit(0);
    }
    const result = fsSync.writeFileSync(entry, ...args);
    if (stage === "after-write") process.exit(0);
    return result;
  },
};
try {
  ${call}
} catch {}
process.exit(0);
`;
}

async function findTempPaths(root: string, tempPrefix: string): Promise<string[]> {
  const entries = await fs.readdir(root);
  return entries
    .filter((entry) => entry.startsWith(`${tempPrefix}.`) && entry.endsWith(".tmp"))
    .map((entry) => path.join(root, entry));
}

async function runChildWithTemp(
  root: string,
  params: ChildScriptParams & { tempPrefix: string },
): Promise<{ result: ChildResult; tempPaths: string[] }> {
  const result = await runNodeChild(makeChildScript(params));
  return { result, tempPaths: await findTempPaths(root, params.tempPrefix) };
}

describe.runIf(process.platform !== "win32")("replaceFileAtomic", () => {
  const renameFailures = [
    { name: "async EPERM", api: "async" as const, code: "EPERM" },
    { name: "async EEXIST", api: "async" as const, code: "EEXIST" },
    { name: "sync EPERM", api: "sync" as const, code: "EPERM" },
    { name: "sync EEXIST", api: "sync" as const, code: "EEXIST" },
  ];

  it.each(renameFailures)(
    "propagates $name and preserves destination metadata",
    async ({ api, code }) => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const { filePath, before } = await makeTarget(root);
        const renameError = makeError(code);
        const fileSystem = makeRenameFailureFs(api, renameError);
        await expect(
          callAtomic({
            api,
            fileSystem,
            options: { filePath, content: "new", copyFallbackOnPermissionError: true },
          }),
        ).rejects.toBe(renameError);
        expect(await snapshot(filePath)).toEqual(before);
      });
    },
  );

  const collisionCases = [
    { name: "async regular collision", api: "async" as const, collision: "regular" as const },
    { name: "async hardlink collision", api: "async" as const, collision: "hardlink" as const },
    { name: "sync regular collision", api: "sync" as const, collision: "regular" as const },
    { name: "sync hardlink collision", api: "sync" as const, collision: "hardlink" as const },
    { name: "async FIFO collision", api: "async" as const, collision: "fifo" as const },
    { name: "async symlink collision", api: "async" as const, collision: "symlink" as const },
    { name: "sync FIFO collision", api: "sync" as const, collision: "fifo" as const },
    { name: "sync symlink collision", api: "sync" as const, collision: "symlink" as const },
  ];

  it.each(collisionCases)("preserves $name", async ({ api, collision }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const { filePath, before } = await makeTarget(root);
      let tempPath: string | undefined;
      let collisionBefore: PathSnapshot | undefined;
      const capture = async (entry: string): Promise<void> => {
        tempPath = entry;
        if (collision === "regular") {
          await fs.writeFile(entry, "foreign", { flag: "wx", mode: 0o640 });
        } else if (collision === "hardlink") {
          await fs.link(filePath, entry);
        } else {
          makeSpecialCollision(filePath, entry, collision);
        }
        collisionBefore = await snapshot(entry);
      };

      if (api === "async") {
        const fileSystem = makeAsyncFs({
          writeFile: async (entry, data, options) => {
            await capture(String(entry));
            return fs.writeFile(entry, data, options);
          },
        });
        await expect(
          callAtomic({ api, fileSystem, options: { filePath, content: "new" } }),
        ).rejects.toMatchObject({
          code: "EEXIST",
        });
      } else {
        const fileSystem = makeSyncFs({
          writeFileSync: (entry, data, options) => {
            const entryPath = String(entry);
            tempPath = entryPath;
            collisionBefore = makeSyncCollision(filePath, entryPath, collision);
            return fsSync.writeFileSync(entry, data, options);
          },
        });
        await expect(
          callAtomic({ api, fileSystem, options: { filePath, content: "new" } }),
        ).rejects.toMatchObject({
          code: "EEXIST",
        });
      }

      expect(tempPath).toBeDefined();
      expect(collisionBefore).toBeDefined();
      const expectedDestination = await snapshot(filePath);
      expectStableIdentity(before, expectedDestination);
      expect(await snapshot(tempPath!)).toEqual(collisionBefore);
      if (collision === "hardlink") {
        expect(expectedDestination.ino).toBe(collisionBefore?.ino);
        expect(expectedDestination.nlink).toBe(2);
      } else {
        expect(expectedDestination.nlink).toBe(before.nlink);
      }
      if (collision === "symlink") expect(await fs.readlink(tempPath!)).toBe(filePath);
    });
  });

  const fallbackInterruptions = [
    { name: "async after destination removal", api: "async" as const, stage: "remove" as const },
    { name: "async after destination open", api: "async" as const, stage: "open" as const },
    { name: "async after strict partial write", api: "async" as const, stage: "partial" as const },
    { name: "sync after destination removal", api: "sync" as const, stage: "remove" as const },
    { name: "sync after destination open", api: "sync" as const, stage: "open" as const },
    { name: "sync after strict partial write", api: "sync" as const, stage: "partial" as const },
  ];

  it.each(fallbackInterruptions)(
    "real child preserves destination $name",
    async ({ api, stage }) => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const { filePath, before } = await makeTarget(root);
        const result = await runNodeChild(makeChildScript({ api, filePath, stage }));
        expect(result.code, result.stderr).toBe(0);
        expect(await snapshot(filePath)).toEqual(before);
      });
    },
  );

  const collisionExitCases = [
    { name: "async regular collision", api: "async" as const, collision: "regular" as const },
    { name: "async hardlink collision", api: "async" as const, collision: "hardlink" as const },
    { name: "sync regular collision", api: "sync" as const, collision: "regular" as const },
    { name: "sync hardlink collision", api: "sync" as const, collision: "hardlink" as const },
  ];

  it.each(collisionExitCases)(
    "real child keeps $name after exit cleanup",
    async ({ api, collision }) => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const { filePath, before } = await makeTarget(root);
        const tempPrefix = `collision-${api}-${collision}`;
        const result = await runNodeChild(
          makeChildScript({ api, collision, filePath, tempPrefix }),
        );
        expect(result.code, result.stderr).toBe(0);
        const tempPaths = await findTempPaths(root, tempPrefix);
        expect(tempPaths).toHaveLength(1);
        const foreign = await snapshot(tempPaths[0]);
        const after = await snapshot(filePath);
        expectStableIdentity(before, after);
        expect(foreign.kind).toBe("file");
        expect(foreign.mode).toBe(before.mode);
        expect(foreign.uid).toBe(before.uid);
        expect(foreign.gid).toBe(before.gid);
        if (collision === "regular") {
          expect(after.nlink).toBe(before.nlink);
          expect(foreign.bytes?.toString()).toBe("foreign");
        } else {
          expect(after.nlink).toBe((before.nlink ?? 0) + 1);
          expect(foreign.ino).toBe(after.ino);
          expect(foreign.nlink).toBe(after.nlink);
        }
      });
    },
  );

  const apiCases = [
    { name: "async", api: "async" as const },
    { name: "sync", api: "sync" as const },
  ];

  it.each(apiCases)("$name exits after writing before temp registration", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const { filePath, before } = await makeTarget(root);
      const { result, tempPaths } = await runChildWithTemp(root, {
        api,
        filePath,
        stage: "after-write",
        tempPrefix: `before-register-${api}`,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(await snapshot(filePath)).toEqual(before);
      expect(tempPaths).toHaveLength(1);
      expect((await snapshot(tempPaths[0])).bytes?.toString()).toBe("new");
    });
  });

  const cleanupReuseCases = apiCases.flatMap(({ api }) =>
    (["regular", "hardlink"] as const).map((cleanupReuse) => ({
      api,
      cleanupReuse,
    })),
  );

  it.each(cleanupReuseCases)(
    "$api $cleanupReuse keeps cleanup name reuse foreign",
    async ({ api, cleanupReuse }) => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const { filePath, before } = await makeTarget(root);
        const { result, tempPaths } = await runChildWithTemp(root, {
          api,
          cleanupReuse,
          filePath,
          tempPrefix: `cleanup-reuse-${api}-${cleanupReuse}`,
        });
        expect(result.code, result.stderr).toBe(0);
        expect(tempPaths).toHaveLength(1);
        const foreign = await snapshot(tempPaths[0]);
        const after = await snapshot(filePath);
        const { mode, uid, gid } = before;
        expectStableIdentity(before, after);
        expect(foreign).toMatchObject({ kind: "file", mode, uid, gid });
        if (cleanupReuse === "regular") {
          expect(foreign).toMatchObject({ bytes: Buffer.from("foreign"), nlink: 1 });
          expect(after.nlink).toBe(before.nlink);
        } else {
          expect(foreign).toMatchObject({
            bytes: before.bytes,
            ino: after.ino,
            nlink: after.nlink,
          });
          expect(after.nlink).toBe((before.nlink ?? 0) + 1);
        }
      });
    },
  );

  const destinationCollisionCases = apiCases.flatMap(({ api }) =>
    (["symlink", "hardlink-alias", "fifo"] as const).map((kind) => ({
      api,
      kind,
    })),
  );

  it.each(destinationCollisionCases)(
    "$api $kind destination survives terminal rename failure",
    async ({ api, kind }) => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const fixture = await makeDestinationFixture(root, kind);
        const renameError = makeError("EPERM");
        await expect(
          callAtomic({
            api,
            fileSystem: makeRenameFailureFs(api, renameError),
            options: { filePath: fixture.filePath, content: "new" },
          }),
        ).rejects.toBe(renameError);
        expect(await snapshot(fixture.filePath)).toEqual(fixture.before);
        if (kind === "symlink") {
          expect(await fs.readlink(fixture.filePath)).toBe(fixture.targetPath);
          expect(await fs.readFile(fixture.targetPath!, "utf8")).toBe("outside");
        } else if (kind === "hardlink-alias") {
          expect(await snapshot(fixture.aliasPath!)).toEqual(fixture.before);
        }
      });
    },
  );

  it.each(apiCases)("$name unregisters before former temp name reuse", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const filePath = path.join(root, "target.txt");
      const tempPrefix = `reuse-after-success-${api}`;
      const markerPath = path.join(root, `${api}.marker`);
      const { result, tempPaths } = await runChildWithTemp(root, {
        api,
        filePath,
        markerPath,
        reuseAfterSuccess: true,
        tempPrefix,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(await fs.readFile(filePath, "utf8")).toBe("new");
      expect(tempPaths).toHaveLength(1);
      expect((await snapshot(tempPaths[0])).bytes?.toString()).toBe("foreign");
    });
  });

  it.each(apiCases)("$name removes only an owned temp after rename failure", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const { filePath } = await makeTarget(root);
      const renameError = makeError("EIO");
      let tempPath: string | undefined;
      const fileSystem = makeRenameFailureFs(api, renameError, (entry) => {
        tempPath = entry;
      });
      await expect(
        callAtomic({ api, fileSystem, options: { filePath, content: "new" } }),
      ).rejects.toBe(renameError);
      expect(tempPath).toBeDefined();
      expect((await snapshot(tempPath!)).kind).toBe("absent");
      expect((await snapshot(filePath)).bytes?.toString()).toBe("old");
    });
  });

  it.each(apiCases)(
    "$name preserves the original error when owned-temp cleanup fails",
    async ({ api }) => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const { filePath } = await makeTarget(root);
        const renameError = makeError("EIO");
        const cleanupError = makeError("EACCES");
        let tempPath: string | undefined;
        const fileSystem = makeCleanupFailureFs(api, renameError, cleanupError, (entry) => {
          tempPath = entry;
        });
        const caught = await callAtomic({
          api,
          fileSystem,
          options: { filePath, content: "new", throwOnCleanupError: true },
        }).catch((error) => error);
        expect(caught).toMatchObject({ cause: renameError });
        expect(tempPath).toBeDefined();
        expect((await snapshot(tempPath!)).kind).toBe("file");
        expect((await snapshot(filePath)).bytes?.toString()).toBe("old");
      });
    },
  );

  it.each(apiCases)("$name leaves a missing destination absent after failure", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const filePath = path.join(root, "missing.txt");
      const renameError = makeError("EIO");
      const fileSystem = makeRenameFailureFs(api, renameError);
      await expect(
        callAtomic({ api, fileSystem, options: { filePath, content: "new" } }),
      ).rejects.toBe(renameError);
      expect(await snapshot(filePath)).toEqual({ kind: "absent" });
    });
  });

  it.each(apiCases)("$name preserves a lexical path alias on failure", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const targetPath = path.join(root, "target.txt");
      const filePath = `${root}/nested/../target.txt`;
      await fs.mkdir(path.join(root, "nested"));
      await fs.writeFile(targetPath, "old");
      const before = await snapshot(targetPath);
      const renameError = makeError("EIO");
      let renameSource: string | undefined;
      const fileSystem = makeRenameFailureFs(api, renameError, (source) => {
        renameSource = source;
      });
      await expect(
        callAtomic({ api, fileSystem, options: { filePath, content: "new" } }),
      ).rejects.toBe(renameError);
      expect(path.resolve(filePath)).toBe(targetPath);
      expect(path.resolve(renameSource ?? "")).not.toBe(path.resolve(filePath));
      expect(await snapshot(targetPath)).toEqual(before);
    });
  });

  it.each(apiCases)("$name replaces the destination through rename", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const filePath = path.join(root, "target.txt");
      const fileSystem = api === "async" ? makeAsyncFs() : makeSyncFs();
      const result = await callAtomic({ api, fileSystem, options: { filePath, content: "new" } });
      expect(result).toEqual({ method: "rename" });
      expect(await fs.readFile(filePath, "utf8")).toBe("new");
    });
  });

  it.each(apiCases)("$name retries EBUSY once and then renames", async ({ api }) => {
    await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
      const filePath = path.join(root, "target.txt");
      const attempts = { value: 0 };
      const fileSystem = makeBusyRetryFs(api, attempts);
      await expect(
        callAtomic({
          api,
          fileSystem,
          options: { filePath, content: "new", renameMaxRetries: 1, renameRetryBaseDelayMs: 0 },
        }),
      ).resolves.toEqual({ method: "rename" });
      expect(attempts.value).toBe(2);
      expect(await fs.readFile(filePath, "utf8")).toBe("new");
    });
  });
});

describe("movePathWithCopyFallback", () => {
  it.runIf(process.platform !== "win32")(
    "rejects hardlinked source files when requested",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "target");
        const sourceFile = path.join(sourceDir, "file.txt");
        const linkedFile = path.join(root, "linked.txt");
        await fs.mkdir(sourceDir);
        await fs.writeFile(sourceFile, "hello", "utf8");
        await fs.link(sourceFile, linkedFile);

        await expect(
          movePathWithCopyFallback({
            from: sourceDir,
            sourceHardlinks: "reject",
            to: targetDir,
          }),
        ).rejects.toThrow("Hardlinked source file is not allowed");

        await expect(fs.readFile(sourceFile, "utf8")).resolves.toBe("hello");
        let statError: NodeJS.ErrnoException | undefined;
        try {
          await fs.stat(targetDir);
        } catch (error) {
          statError = error as NodeJS.ErrnoException;
        }
        expect(statError).toBeInstanceOf(Error);
        expect(statError?.code).toBe("ENOENT");
        expect(statError?.path).toBe(targetDir);
        expect(statError?.syscall).toBe("stat");
      });
    },
  );
});
