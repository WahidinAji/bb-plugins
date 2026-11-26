// Live Editor backend. Resolves a file opener's source to a host path,
// reads and CAS-saves it through bb.sdk.files, and polls every file an editor
// tab has open so on-disk changes (an agent's edit, a git checkout) reach the
// editor within a poll interval over bb.realtime.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const sourceSchema = z.object({
  kind: z.enum(["host", "thread-storage", "workspace"]),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  projectId: z.string().nullable(),
  experimental_hostId: z.string().optional(),
});
export type FileSource = z.infer<typeof sourceSchema>;

const fileRefSchema = z.object({
  source: sourceSchema,
  path: z.string().min(1).max(4096),
});

const readOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("text"),
    key: z.string(),
    content: z.string(),
    sha256: z.string(),
  }),
  z.object({ status: z.literal("binary"), key: z.string() }),
  z.object({ status: z.literal("too-large"), key: z.string(), sizeBytes: z.number() }),
  z.object({ status: z.literal("missing"), key: z.string() }),
]);
export type ReadResult = z.infer<typeof readOutputSchema>;

export const rpcContract = defineRpcContract({
  file_read: { input: fileRefSchema, output: readOutputSchema },
  file_watch: { input: fileRefSchema, output: z.object({ key: z.string() }) },
  file_save: {
    input: fileRefSchema.extend({
      content: z.string(),
      expectedSha256: z.string().nullable(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
});

type SaveResult = z.infer<(typeof rpcContract)["file_save"]["output"]>;

export const FILE_CHANGED = "file-changed";
export interface FileChangedPayload {
  key: string;
  sha256: string | null;
}

/** Larger files go to BB's own preview; CodeMirror stays responsive below this. */
const MAX_EDITABLE_BYTES = 10 * 1024 * 1024;
/** A tab renews its lease well inside this window while it is visible. */
const LEASE_MS = 45_000;

interface ResolvedFile {
  hostId: string | undefined;
  rootPath: string | undefined;
  absPath: string;
  key: string;
}

interface Watch {
  file: ResolvedFile;
  sha256: string | null | undefined;
  leaseUntil: number;
}

function fileKey(hostId: string | undefined, absPath: string): string {
  return createHash("sha256")
    .update(`${hostId ?? ""}\n${absPath}`)
    .digest("hex")
    .slice(0, 32);
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /not_?found|enoent/i.test(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such file|enoent|does not exist/i.test(message);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autosave: {
      type: "boolean",
      label: "Autosave",
      description: "Save about a second after you stop typing. When off, save with Ctrl/Cmd+S.",
      default: true,
    },
    replaceViewer: {
      type: "boolean",
      label: "Replace BB's code viewer",
      description:
        "Render read-only code (BB's file preview and plugins such as Files) with CodeMirror instead of BB's built-in renderer.",
      default: true,
    },
    pollIntervalMs: {
      type: "number",
      label: "Change check interval (ms)",
      description: "How often open files are checked for changes made outside the editor.",
      default: 1000,
    },
  });
  const { pollIntervalMs } = await settings.get();
  const pollMs = Math.min(Math.max(pollIntervalMs, 250), 60_000);

  async function resolve(source: FileSource, path: string): Promise<ResolvedFile> {
    let hostId = source.experimental_hostId;
    let rootPath: string | undefined;

    if (source.kind === "thread-storage") {
      if (!source.threadId) throw new Error("Thread storage file has no thread");
      const location = await bb.sdk.threads.storageLocation({ threadId: source.threadId });
      hostId = location.hostId;
      rootPath = location.storageRootPath;
    } else {
      let environmentId = source.environmentId;
      if (!environmentId && source.threadId) {
        environmentId = (await bb.sdk.threads.get({ threadId: source.threadId })).environmentId ?? null;
      }
      if (environmentId) {
        const environment = await bb.sdk.environments.get({ environmentId });
        hostId ??= environment.hostId;
        if (source.kind === "workspace") rootPath = environment.path ?? undefined;
      } else if (source.kind === "workspace" && source.projectId) {
        const project = await bb.sdk.projects.get({ projectId: source.projectId });
        const sources = project.sources ?? [];
        const match =
          sources.find((candidate) => candidate.hostId === hostId) ??
          sources.find((candidate) => candidate.isDefault) ??
          sources[0];
        if (match) {
          hostId = match.hostId;
          rootPath = match.path;
        }
      }
    }

    let absPath: string;
    if (source.kind === "host") {
      if (!posix.isAbsolute(path)) throw new Error(`Host file path must be absolute: ${path}`);
      absPath = posix.normalize(path);
    } else {
      if (!rootPath) throw new Error(`Could not find the workspace for ${path}`);
      absPath = posix.join(rootPath, path);
      if (absPath !== rootPath && !absPath.startsWith(rootPath.replace(/\/?$/, "/"))) {
        throw new Error(`Path escapes its workspace: ${path}`);
      }
    }
    return { hostId, rootPath, absPath, key: fileKey(hostId, absPath) };
  }

  /** The file as stored on its host, or null when it does not exist. */
  async function readFile(file: ResolvedFile) {
    try {
      return await bb.sdk.files.read({
        hostId: file.hostId,
        rootPath: file.rootPath,
        path: file.absPath,
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  const watches = new Map<string, Watch>();

  function lease(file: ResolvedFile) {
    const leaseUntil = Date.now() + LEASE_MS;
    const existing = watches.get(file.key);
    if (existing) existing.leaseUntil = leaseUntil;
    else watches.set(file.key, { file, sha256: undefined, leaseUntil });
  }

  function noteSha(key: string, sha256: string | null) {
    const watch = watches.get(key);
    if (!watch || watch.sha256 === sha256) return;
    watch.sha256 = sha256;
    bb.realtime.publish(FILE_CHANGED, { key, sha256 } satisfies FileChangedPayload);
  }

  async function pollOnce() {
    const now = Date.now();
    await Promise.all(
      [...watches.entries()].map(async ([key, watch]) => {
        if (watch.leaseUntil < now) {
          watches.delete(key);
          return;
        }
        try {
          const file = await readFile(watch.file);
          noteSha(key, file?.sha256 ?? null);
        } catch (error) {
          bb.log.warn(`poll failed for ${watch.file.absPath}: ${String(error)}`);
        }
      }),
    );
  }

  bb.background.service("watch", {
    async start(signal) {
      while (!signal.aborted) {
        await pollOnce();
        await new Promise<void>((done) => {
          const timer = setTimeout(done, pollMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
        });
      }
    },
  });

  bb.rpc.register(rpcContract, {
    async file_read({ source, path }): Promise<ReadResult> {
      const file = await resolve(source, path);
      const read = await readFile(file);
      lease(file);
      noteSha(file.key, read?.sha256 ?? null);
      if (read === null) return { status: "missing", key: file.key };
      if (read.sizeBytes > MAX_EDITABLE_BYTES) {
        return { status: "too-large", key: file.key, sizeBytes: read.sizeBytes };
      }
      if (read.contentEncoding !== "utf8") return { status: "binary", key: file.key };
      return { status: "text", key: file.key, content: read.content, sha256: read.sha256 };
    },

    async file_watch({ source, path }) {
      const file = await resolve(source, path);
      lease(file);
      return { key: file.key };
    },

    async file_save({ source, path, content, expectedSha256 }): Promise<SaveResult> {
      const file = await resolve(source, path);
      const saved = await bb.sdk.files.write({
        hostId: file.hostId,
        rootPath: file.rootPath,
        path: file.absPath,
        content,
        expectedSha256,
      });
      if (saved.outcome === "conflict") {
        return { outcome: "conflict", currentSha256: saved.currentSha256 };
      }
      lease(file);
      noteSha(file.key, saved.sha256);
      return { outcome: "written", sha256: saved.sha256 };
    },
  });

  bb.onDispose(() => watches.clear());
}
