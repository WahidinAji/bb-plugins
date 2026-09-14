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

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

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
      const { paths } = await bb.sdk.files.listPaths({
        hostId: root.hostId,
        path: root.path,
        query,
        limit: MAX_RESULTS,
        includeFiles: true,
        includeDirectories: true,
      });
      return paths.map((entry) => ({
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
