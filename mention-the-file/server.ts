// bb-plugin-mention-the-file — backend entry.
//
// Registers an @-mention provider so a file from the thread's workspace can
// be referenced while composing a message. Picking a result attaches the
// file's contents to the message as agent-visible (user-hidden) context.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const MAX_RESULTS = 20;
// Keep a single mention's context comfortably below typical model context
// budgets; a truncated file is still more useful than a blocked send.
const MAX_CONTEXT_CHARS = 200_000;

// The item id round-trips through the composer with no other context
// available at resolve time, so it carries the host + absolute path itself.
const ID_SEPARATOR = "::";

function encodeItemId(hostId: string, absolutePath: string): string {
  return `${hostId}${ID_SEPARATOR}${absolutePath}`;
}

function decodeItemId(itemId: string): { hostId: string; path: string } {
  const separatorIndex = itemId.indexOf(ID_SEPARATOR);
  if (separatorIndex < 0) {
    throw new Error("This file mention is malformed.");
  }
  return {
    hostId: itemId.slice(0, separatorIndex),
    path: itemId.slice(separatorIndex + ID_SEPARATOR.length),
  };
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
        includeDirectories: false,
      });
      return paths.map((entry) => ({
        id: encodeItemId(root.hostId, joinWorkspacePath(root.path, entry.path)),
        title: entry.name,
        subtitle: entry.path,
      }));
    },
    async resolve(itemId) {
      const { hostId, path } = decodeItemId(itemId);
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
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
