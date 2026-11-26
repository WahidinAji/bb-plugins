// Live Editor frontend. Registers a fileOpener that opens code files in
// CodeMirror. The editor re-reads the file when the server reports a change,
// and saves send the last synced sha256 so a newer file is never overwritten.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_useCodeTheme,
  experimental_useTabVisible,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { FileChangedPayload, ReadResult, rpcContract } from "./server";
import { languageFor, OPENER_EXTENSIONS } from "./editor/languages";
import { editorTheme } from "./editor/theme";
import { SourceViewer } from "./editor/viewer";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const HEARTBEAT_MS = 15_000;
const AUTOSAVE_DELAY_MS = 1_000;

/** Marks transactions that mirror the disk, so they don't count as user edits. */
const fromDisk = Annotation.define<boolean>();

type TextRead = Extract<ReadResult, { status: "text" }>;
/** The disk version the buffer was last in sync with; sha256 null = file absent. */
interface Base {
  content: string;
  sha256: string | null;
}
type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "delegate" }
  | { kind: "error"; message: string };
type SaveState = "saved" | "dirty" | "saving";
/** The buffer and disk diverged while the user had unsaved edits. */
type Conflict = { kind: "changed"; remote: TextRead } | { kind: "deleted" };

function lineSeparatorOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Replace only the differing middle, so cursors and folds outside it survive. */
function replaceDoc(view: EditorView, next: string) {
  const prev = view.state.doc.toString();
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  if (start === endPrev && start === endNext) return;
  view.dispatch({
    changes: { from: start, to: endPrev, insert: next.slice(start, endNext) },
    annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function FileEditor({ path, source, experimental_lineRange: lineRange, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const codeTheme = experimental_useCodeTheme();
  const visible = experimental_useTabVisible();
  const connection = useRealtimeConnectionState();
  const { values } = useSettings();
  const autosave = values?.autosave !== false;

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartments = useRef({ theme: new Compartment(), separator: new Compartment() });
  const baseRef = useRef<Base | null>(null);
  const keyRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const resyncAfterSaveRef = useRef(false);
  const saveAgainRef = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRangeRef = useRef(lineRange ?? null);
  const conflictRef = useRef<Conflict | null>(null);

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflictState] = useState<Conflict | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setConflict = useCallback((next: Conflict | null) => {
    conflictRef.current = next;
    setConflictState(next);
  }, []);

  const codeThemeRef = useRef(codeTheme);
  codeThemeRef.current = codeTheme;
  const fileRef = { source, path };
  const fileRefRef = useRef(fileRef);
  fileRefRef.current = fileRef;

  const revealRange = useCallback(() => {
    const view = viewRef.current;
    const range = pendingRangeRef.current;
    if (!view || !range) return;
    pendingRangeRef.current = null;
    const doc = view.state.doc;
    const clamp = (line: number) => Math.min(Math.max(line, 1), doc.lines);
    const from = doc.line(clamp(range.startLineNumber)).from;
    const to = doc.line(clamp(range.endLineNumber)).to;
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, []);

  const createView = useCallback((content: string) => {
    if (!hostRef.current) return;
    viewRef.current?.destroy();
    const { theme, separator } = compartments.current;
    viewRef.current = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          separator.of(EditorState.lineSeparator.of(lineSeparatorOf(content))),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          languageFor(path),
          theme.of(editorTheme(codeThemeRef.current)),
          EditorView.updateListener.of((update) => {
            const userEdit = update.transactions.some((tr) => tr.docChanged && !tr.annotation(fromDisk));
            if (userEdit) onUserEditRef.current();
          }),
        ],
      }),
    });
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.theme.reconfigure(editorTheme(codeTheme)) });
  }, [codeTheme]);

  /** Bring the buffer in line with a fresh read of the file. */
  const applyRead = useCallback((result: ReadResult) => {
    keyRef.current = result.key;
    if (result.status === "binary" || result.status === "too-large") {
      setPhase({ kind: "delegate" });
      return;
    }
    const view = viewRef.current;
    const base = baseRef.current;

    if (result.status === "missing") {
      if (!view || !base) {
        setPhase({ kind: "missing" });
        return;
      }
      if (base.sha256 === null) return;
      baseRef.current = { content: base.content, sha256: null };
      setConflict({ kind: "deleted" });
      return;
    }

    if (!view || !base) {
      baseRef.current = { content: result.content, sha256: result.sha256 };
      createView(result.content);
      setPhase({ kind: "ready" });
      setSaveState("saved");
      revealRange();
      return;
    }
    if (result.sha256 === base.sha256) return;

    const doc = view.state.doc.toString();
    if (doc === result.content) {
      baseRef.current = { content: result.content, sha256: result.sha256 };
      setConflict(null);
      setSaveState("saved");
    } else if (doc === base.content && base.sha256 !== null) {
      const separator = lineSeparatorOf(result.content);
      if (separator !== view.state.lineBreak) {
        view.dispatch({
          effects: compartments.current.separator.reconfigure(EditorState.lineSeparator.of(separator)),
        });
      }
      replaceDoc(view, result.content);
      baseRef.current = { content: result.content, sha256: result.sha256 };
      setConflict(null);
      setSaveState("saved");
    } else {
      setConflict({ kind: "changed", remote: result });
    }
  }, [createView, revealRange, setConflict]);

  const sync = useCallback(async () => {
    if (savingRef.current) {
      resyncAfterSaveRef.current = true;
      return;
    }
    try {
      applyRead(await rpc.call("file_read", fileRefRef.current));
    } catch (cause) {
      if (!viewRef.current) setPhase({ kind: "error", message: errorMessage(cause) });
    }
  }, [rpc, applyRead]);

  const save = useCallback(async () => {
    const view = viewRef.current;
    const base = baseRef.current;
    if (!view || !base || conflictRef.current?.kind === "changed") return;
    if (savingRef.current) {
      saveAgainRef.current = true;
      return;
    }
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const text = view.state.doc.toString();
    if (text === base.content && base.sha256 !== null) {
      setSaveState("saved");
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    setSaveError(null);
    try {
      const result = await rpc.call("file_save", {
        ...fileRefRef.current,
        content: text,
        expectedSha256: base.sha256,
      });
      if (result.outcome === "written") {
        baseRef.current = { content: text, sha256: result.sha256 };
        if (conflictRef.current?.kind === "deleted") setConflict(null);
        setSaveState(view.state.doc.toString() === text ? "saved" : "dirty");
      } else {
        setSaveState("dirty");
        resyncAfterSaveRef.current = true;
      }
    } catch (cause) {
      setSaveError(errorMessage(cause));
      setSaveState("dirty");
    } finally {
      savingRef.current = false;
    }
    if (resyncAfterSaveRef.current) {
      resyncAfterSaveRef.current = false;
      await sync();
    }
    if (saveAgainRef.current) {
      saveAgainRef.current = false;
      await save();
    }
  }, [rpc, sync, setConflict]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const onUserEditRef = useRef(() => {});
  onUserEditRef.current = () => {
    setSaveState("dirty");
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    if (autosave && conflictRef.current === null) {
      autosaveTimer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
    }
  };

  // A new file in this tab: start over.
  const identity = `${source.kind}|${source.threadId}|${source.environmentId}|${source.projectId}|${source.experimental_hostId ?? ""}|${path}`;
  useEffect(() => {
    baseRef.current = null;
    keyRef.current = null;
    setConflict(null);
    setPhase({ kind: "loading" });
    void sync();
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [identity]);

  useEffect(() => {
    pendingRangeRef.current = lineRange ?? null;
    if (baseRef.current) revealRange();
  }, [lineRange, revealRange]);

  // Keep the server's watch alive only while this tab is on screen, and catch
  // up on anything missed while it was hidden.
  const wasHidden = useRef(false);
  useEffect(() => {
    if (!visible) {
      wasHidden.current = true;
      return;
    }
    if (wasHidden.current) {
      wasHidden.current = false;
      void sync();
    }
    const timer = setInterval(() => {
      rpc.call("file_watch", fileRefRef.current).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [visible, identity, rpc, sync]);

  // Realtime signals are ephemeral: re-read after the connection comes back.
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") wasDisconnected.current = true;
    else if (wasDisconnected.current) {
      wasDisconnected.current = false;
      void sync();
    }
  }, [connection, sync]);

  useRealtime("file-changed", (payload) => {
    const change = payload as FileChangedPayload;
    if (change.key !== keyRef.current) return;
    if (baseRef.current && change.sha256 === baseRef.current.sha256) return;
    void sync();
  });

  const takeDiskVersion = () => {
    const view = viewRef.current;
    const current = conflictRef.current;
    if (!view || current?.kind !== "changed") return;
    replaceDoc(view, current.remote.content);
    baseRef.current = { content: current.remote.content, sha256: current.remote.sha256 };
    setConflict(null);
    setSaveState("saved");
  };
  const keepMine = () => {
    const current = conflictRef.current;
    if (current?.kind === "changed" && baseRef.current) {
      baseRef.current = { content: current.remote.content, sha256: current.remote.sha256 };
    }
    setConflict(null);
    void save();
  };

  if (phase.kind === "delegate") return <Original />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={path}>
          {path}
        </span>
        {phase.kind === "ready" ? (
          <>
            <StatusLabel saveState={saveState} live={connection === "connected"} />
            {saveState === "dirty" && !autosave ? (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void save()}>
                Save
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {conflict?.kind === "changed" ? (
        <Banner tone="warning">
          <span className="flex-1">This file changed on disk while you had unsaved edits.</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={takeDiskVersion}>
            Use disk version
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={keepMine}>
            Keep mine
          </Button>
        </Banner>
      ) : null}
      {conflict?.kind === "deleted" ? (
        <Banner tone="warning">
          <span className="flex-1">This file was deleted on disk. Saving will create it again.</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void save()}>
            Save anyway
          </Button>
        </Banner>
      ) : null}
      {saveError !== null ? (
        <Banner tone="error">
          <span className="flex-1">Save failed: {saveError}</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void save()}>
            Retry
          </Button>
        </Banner>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0 overflow-hidden" />
        {phase.kind === "loading" ? <Overlay>Loading…</Overlay> : null}
        {phase.kind === "missing" ? <Overlay>This file does not exist. It will open here when it is created.</Overlay> : null}
        {phase.kind === "error" ? (
          <Overlay>
            <span className="text-destructive">{phase.message}</span>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void sync()}>
              Try again
            </Button>
          </Overlay>
        ) : null}
      </div>
    </div>
  );
}

function StatusLabel({ saveState, live }: { saveState: SaveState; live: boolean }) {
  const label = saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved" : "Saved";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" title={live ? "Live: changes on disk appear here" : "Reconnecting…"}>
      <span className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-amber-500"}`} />
      {label}
    </span>
  );
}

function Banner({ tone, children }: { tone: "warning" | "error"; children: ReactNode }) {
  return (
    <div
      role="status"
      className={`flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs ${
        tone === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-foreground"
      }`}
    >
      <Icon name={tone === "error" ? "CircleAlert" : "TriangleAlert"} className="size-3.5 shrink-0" />
      {children}
    </div>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "editor",
    title: "Live Editor",
    extensions: OPENER_EXTENSIONS,
    component: FileEditor,
  });
  app.slots.experimental_sourceCodeRenderer({
    id: "viewer",
    title: "Live Editor viewer",
    description: "Read-only CodeMirror viewer in place of BB's built-in source renderer.",
    component: SourceViewer,
  });
});
