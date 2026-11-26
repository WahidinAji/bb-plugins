import { useEffect, useRef } from "react";
import { experimental_useCodeTheme, useSettings, type PluginSourceCodeRendererProps } from "@get-bb/plugin-sdk/app";
import { foldGutter } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { languageFor } from "./languages";
import { editorTheme } from "./theme";

function highlightExtension(content: EditorState["doc"], range: PluginSourceCodeRendererProps["highlightedLines"]): Extension {
  if (!range) return [];
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.line({ class: "cm-bb-highlighted" });
  const last = Math.min(range.end, content.lines);
  for (let line = Math.max(range.start, 1); line <= last; line++) {
    const from = content.line(line).from;
    builder.add(from, from, mark);
  }
  return EditorView.decorations.of(builder.finish());
}

const highlightedLineTheme = EditorView.theme({
  ".cm-bb-highlighted": { backgroundColor: "color-mix(in srgb, var(--primary, #3b82f6) 14%, transparent)" },
});

/** Read-only CodeMirror stand-in for BB's source viewer. */
export function SourceViewer(props: PluginSourceCodeRendererProps) {
  const { values } = useSettings();
  if (values?.replaceViewer === false) return <props.Original />;
  return <CodeMirrorViewer {...props} />;
}

function CodeMirrorViewer({ content, path, overflow, highlightedLines }: PluginSourceCodeRendererProps) {
  const codeTheme = experimental_useCodeTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const parts = useRef({
    theme: new Compartment(),
    language: new Compartment(),
    wrap: new Compartment(),
    highlight: new Compartment(),
    separator: new Compartment(),
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const p = parts.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          p.separator.of(EditorState.lineSeparator.of(content.includes("\r\n") ? "\r\n" : "\n")),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: "0", "aria-label": path }),
          lineNumbers(),
          foldGutter(),
          highlightSpecialChars(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of(searchKeymap),
          highlightedLineTheme,
          p.language.of(languageFor(path)),
          p.wrap.of(overflow === "wrap" ? EditorView.lineWrapping : []),
          p.theme.of(editorTheme(codeTheme)),
          p.highlight.of([]),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      effects: parts.current.separator.reconfigure(
        EditorState.lineSeparator.of(content.includes("\r\n") ? "\r\n" : "\n"),
      ),
    });
  }, [content]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: parts.current.language.reconfigure(languageFor(path)) });
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: parts.current.wrap.reconfigure(overflow === "wrap" ? EditorView.lineWrapping : []),
    });
  }, [overflow]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: parts.current.theme.reconfigure(editorTheme(codeTheme)) });
  }, [codeTheme]);

  const start = highlightedLines?.start;
  const end = highlightedLines?.end;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const range = start === undefined || end === undefined ? null : { start, end };
    const effects = [parts.current.highlight.reconfigure(highlightExtension(doc, range))];
    if (range && doc.lines > 0) {
      const line = doc.line(Math.min(Math.max(range.start, 1), doc.lines));
      effects.push(EditorView.scrollIntoView(line.from, { y: "center" }));
    }
    view.dispatch({ effects });
  }, [start, end, content]);

  return <div ref={hostRef} className="flex h-full min-h-0 w-full flex-1 flex-col [&_.cm-editor]:min-h-0 [&_.cm-editor]:flex-1" />;
}
