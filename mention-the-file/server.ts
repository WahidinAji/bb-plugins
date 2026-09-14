// bb-plugin-mention-the-file — backend entry.
//
// Registers an @-mention provider so a file or directory from the thread's
// workspace can be referenced while composing a message. Picking a file
// attaches its contents as agent-visible (user-hidden) context; picking a
// directory attaches a listing of everything under it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const MAX_RESULTS = 20;
// Keep a single mention's context comfortably below typical model context
// budgets; a truncated file/listing is still more useful than a blocked send.
const MAX_CONTEXT_CHARS = 200_000;
const MAX_DIRECTORY_ENTRIES = 500;

type EntryKind = "file" | "directory";
interface IndexEntry {
  kind: EntryKind;
  name: string;
  path: string; // relative to the workspace root
}

// `search` is time-boxed to 2s by the host; a vendor-heavy monorepo (e.g. two
// Laravel apps' worth of `vendor/`/`node_modules/`) can take minutes to walk
// recursively, which would otherwise make every keystroke fail and the
// provider look permanently broken. So each workspace root gets an
// in-memory index built in the background (unbound by that 2s window) and
// `search` just filters it in-process. The very first call for a workspace
// waits a bounded slice of the budget for that build in case it's fast
// enough to finish inline; slower ones fall back to `[]` until a later
// keystroke lands after the background build has populated the cache.
const SEARCH_BUDGET_MS = 1_500;
const INDEX_TTL_MS = 5 * 60_000;
const INDEX_LIMIT = 20_000;

// Directories whose contents are rarely what someone means to mention and
// are the usual reason a workspace-wide scan is slow to begin with.
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "vendor",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => IGNORED_DIR_NAMES.has(segment));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The item id round-trips through the composer with no other context
// available at resolve time, so it carries everything needed to read it back.
const ID_SEPARATOR = "::";

function encodeItemId(
  kind: EntryKind,
  hostId: string,
  absolutePath: string,
): string {
  return `${kind}${ID_SEPARATOR}${hostId}${ID_SEPARATOR}${absolutePath}`;
}

function decodeItemId(
  itemId: string,
): { kind: EntryKind; hostId: string; path: string } {
  const [kind, hostId, ...pathParts] = itemId.split(ID_SEPARATOR);
  if (
    (kind !== "file" && kind !== "directory") ||
    !hostId ||
    pathParts.length === 0
  ) {
    throw new Error("This mention is malformed.");
  }
  return { kind, hostId, path: pathParts.join(ID_SEPARATOR) };
}

function joinWorkspacePath(root: string, relativePath: string): string {
  return `${root}/${relativePath}`.replace(/\/{2,}/g, "/");
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Lower is better; -1 means "no match". */
function matchScore(entry: IndexEntry, queryLower: string): number {
  if (queryLower === "") return 0;
  const nameLower = entry.name.toLowerCase();
  if (nameLower.startsWith(queryLower)) return 0;
  if (nameLower.includes(queryLower)) return 1;
  const pathLower = entry.path.toLowerCase();
  if (pathLower.includes(queryLower)) return 2;
  if (isSubsequence(queryLower, nameLower)) return 3;
  if (isSubsequence(queryLower, pathLower)) return 4;
  return -1;
}

function searchIndex(entries: IndexEntry[], query: string): IndexEntry[] {
  const queryLower = query.trim().toLowerCase();
  const scored: { entry: IndexEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = matchScore(entry, queryLower);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length,
  );
  return scored.slice(0, MAX_RESULTS).map(({ entry }) => entry);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const indexCache = new Map<string, { entries: IndexEntry[]; builtAt: number }>();
  const indexBuilds = new Map<string, Promise<void>>();

  function cacheKey(hostId: string, path: string): string {
    return `${hostId}${ID_SEPARATOR}${path}`;
  }

  function ensureIndexBuilding(hostId: string, path: string): Promise<void> {
    const key = cacheKey(hostId, path);
    const existing = indexBuilds.get(key);
    if (existing) return existing;
    const build = (async () => {
      try {
        const { paths } = await bb.sdk.files.listPaths({
          hostId,
          path,
          limit: INDEX_LIMIT,
          includeFiles: true,
          includeDirectories: true,
        });
        const entries = paths.filter((entry) => !isIgnoredPath(entry.path));
        indexCache.set(key, { entries, builtAt: Date.now() });
      } catch (error) {
        bb.log.warn(`mention-the-file: failed to index ${path}: ${String(error)}`);
      } finally {
        indexBuilds.delete(key);
      }
    })();
    indexBuilds.set(key, build);
    return build;
  }

  /** Resolve a thread to the host + absolute path of its workspace root. */
  async function workspaceRoot(
    threadId: string,
  ): Promise<{ hostId: string; path: string } | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.path) return null;
    return { hostId: environment.hostId, path: environment.path };
  }

  async function resolveFile(hostId: string, path: string) {
    const file = await bb.sdk.files.read({ hostId, path });
    if (file.contentEncoding === "base64") {
      return {
        context: `File: ${path}\n(binary file, ${file.sizeBytes} bytes — content omitted)`,
      };
    }
    const truncated = file.content.length > MAX_CONTEXT_CHARS;
    const content = truncated
      ? file.content.slice(0, MAX_CONTEXT_CHARS)
      : file.content;
    return {
      context: [
        `File: ${path}`,
        "```",
        content,
        "```",
        truncated ? "(truncated)" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  async function resolveDirectory(hostId: string, path: string) {
    const { paths, truncated } = await bb.sdk.files.listPaths({
      hostId,
      path,
      limit: MAX_DIRECTORY_ENTRIES,
      includeFiles: true,
      includeDirectories: true,
    });
    const listing = paths
      .filter((entry) => !isIgnoredPath(entry.path))
      .map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path))
      .sort()
      .join("\n");
    return {
      context: [
        `Directory: ${path}`,
        listing || "(empty)",
        truncated ? "(truncated)" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  bb.ui.registerMentionProvider({
    id: "file",
    label: "Files",
    async search({ threadId, query }) {
      if (!threadId) return [];
      const root = await workspaceRoot(threadId);
      if (!root) return [];

      const key = cacheKey(root.hostId, root.path);
      let cached = indexCache.get(key);
      const stale = !cached || Date.now() - cached.builtAt > INDEX_TTL_MS;
      if (stale) {
        const build = ensureIndexBuilding(root.hostId, root.path);
        if (!cached) {
          // Nothing to serve yet: give the build a bounded slice of the
          // 2s budget in case this workspace is small enough to finish
          // inline. Losing this race doesn't cancel the build — it keeps
          // running and populates the cache for the next keystroke.
          await Promise.race([build, sleep(SEARCH_BUDGET_MS)]);
          cached = indexCache.get(key);
        }
        // Stale-but-present: serve what we have and refresh in the background.
      }
      if (!cached) return [];

      return searchIndex(cached.entries, query).map((entry) => ({
        id: encodeItemId(
          entry.kind,
          root.hostId,
          joinWorkspacePath(root.path, entry.path),
        ),
        title: entry.kind === "directory" ? `${entry.name}/` : entry.name,
        subtitle: entry.kind === "directory" ? `${entry.path}/` : entry.path,
      }));
    },
    async resolve(itemId) {
      const { kind, hostId, path } = decodeItemId(itemId);
      return kind === "directory"
        ? resolveDirectory(hostId, path)
        : resolveFile(hostId, path);
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
