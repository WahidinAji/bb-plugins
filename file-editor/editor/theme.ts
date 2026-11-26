import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t, type Tag } from "@lezer/highlight";
import type { PluginCodeThemeData, PluginCodeThemeState } from "@get-bb/plugin-sdk/app";

/** Lezer tags and the TextMate scopes that paint them, most specific first. */
const TAG_SCOPES: [Tag | Tag[], string[]][] = [
  [[t.comment, t.lineComment, t.blockComment, t.docComment], ["comment"]],
  [[t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], ["keyword.control", "keyword"]],
  [t.definitionKeyword, ["storage.type", "keyword"]],
  [t.modifier, ["storage.modifier", "keyword"]],
  [[t.string, t.special(t.string), t.character, t.docString, t.attributeValue], ["string.quoted", "string"]],
  [t.regexp, ["string.regexp", "string"]],
  [t.escape, ["constant.character.escape", "constant.character"]],
  [[t.number, t.integer, t.float], ["constant.numeric", "constant"]],
  [[t.bool, t.null, t.atom], ["constant.language", "constant"]],
  [t.constant(t.variableName), ["variable.other.constant", "constant"]],
  [t.self, ["variable.language", "keyword"]],
  [[t.variableName, t.definition(t.variableName), t.local(t.variableName)], ["variable.other.readwrite", "variable"]],
  [
    [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))],
    ["entity.name.function", "support.function"],
  ],
  [[t.propertyName, t.definition(t.propertyName)], ["variable.other.property", "support.type.property-name", "variable"]],
  [[t.typeName, t.standard(t.typeName)], ["entity.name.type", "support.type", "storage.type"]],
  [t.className, ["entity.name.type.class", "entity.name.class", "entity.name.type"]],
  [t.namespace, ["entity.name.namespace", "entity.name.type"]],
  [t.labelName, ["entity.name.label", "variable"]],
  [t.macroName, ["entity.name.function.preprocessor", "meta.preprocessor", "entity.name.function"]],
  [t.tagName, ["entity.name.tag"]],
  [t.attributeName, ["entity.other.attribute-name"]],
  [
    [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator],
    ["keyword.operator"],
  ],
  [[t.punctuation, t.separator, t.bracket], ["punctuation"]],
  [[t.meta, t.annotation, t.processingInstruction], ["meta.decorator", "entity.name.function.decorator", "meta"]],
  [[t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], ["markup.heading", "entity.name.section"]],
  [t.emphasis, ["markup.italic"]],
  [t.strong, ["markup.bold"]],
  [[t.link, t.url], ["markup.underline.link", "string.other.link"]],
  [t.quote, ["markup.quote"]],
  [t.monospace, ["markup.inline.raw", "markup.raw"]],
  [t.inserted, ["markup.inserted"]],
  [t.deleted, ["markup.deleted"]],
  [t.changed, ["markup.changed"]],
  [t.invalid, ["invalid"]],
];

interface Paint {
  color?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
}

/** TextMate rule selection: the longest rule selector that prefixes a wanted scope. */
function paintFor(theme: PluginCodeThemeData, wanted: string[]): Paint | null {
  for (const scope of wanted) {
    let best: { length: number; settings: PluginCodeThemeData["tokenColors"][number]["settings"] } | null = null;
    for (const rule of theme.tokenColors) {
      if (rule.scope === undefined) continue;
      const selectors = typeof rule.scope === "string" ? rule.scope.split(",") : rule.scope;
      for (const raw of selectors) {
        const selector = raw.trim();
        if (selector === "" || selector.includes(" ")) continue;
        if (scope !== selector && !scope.startsWith(`${selector}.`)) continue;
        if (!best || selector.length > best.length) best = { length: selector.length, settings: rule.settings };
      }
    }
    if (best) {
      const style = best.settings.fontStyle ?? "";
      return {
        color: best.settings.foreground,
        fontStyle: style.includes("italic") ? "italic" : undefined,
        fontWeight: style.includes("bold") ? "bold" : undefined,
        textDecoration: style.includes("underline") ? "underline" : undefined,
      };
    }
  }
  return null;
}

function highlightFrom(theme: PluginCodeThemeData): HighlightStyle {
  const specs = TAG_SCOPES.flatMap(([tag, scopes]) => {
    const paint = paintFor(theme, scopes);
    return paint ? [{ tag, ...paint }] : [];
  });
  return HighlightStyle.define(specs, { themeType: theme.type });
}

/** `#rrggbb[aa]` with its alpha replaced. */
function alpha(hex: string, aa: string): string {
  return /^#[0-9a-f]{6}/i.test(hex) ? `${hex.slice(0, 7)}${aa}` : hex;
}

const layout = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "1.55",
  },
  ".cm-gutters": { border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
});

export function editorTheme(state: PluginCodeThemeState): Extension {
  const theme = state.theme;
  const dark = state.mode === "dark";
  if (!theme) {
    return [
      layout,
      EditorView.theme(
        {
          "&": { color: "var(--foreground)", backgroundColor: "var(--background)" },
          ".cm-gutters": { backgroundColor: "var(--background)", color: "var(--muted-foreground)" },
        },
        { dark },
      ),
      syntaxHighlighting(defaultHighlightStyle),
    ];
  }
  const c = theme.colors;
  const bg = c["editor.background"] ?? theme.bg;
  const fg = c["editor.foreground"] ?? theme.fg;
  const selection = c["editor.selectionBackground"] ?? (dark ? "#ffffff26" : "#0000001f");
  return [
    layout,
    EditorView.theme(
      {
        "&": { color: fg, backgroundColor: bg },
        ".cm-content": { caretColor: c["editorCursor.foreground"] ?? fg },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: c["editorCursor.foreground"] ?? fg },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          { backgroundColor: selection },
        ".cm-activeLine": { backgroundColor: c["editor.lineHighlightBackground"] ?? "transparent" },
        ".cm-gutters": {
          backgroundColor: c["editorGutter.background"] ?? bg,
          color: c["editorLineNumber.foreground"] ?? alpha(fg, "80"),
        },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: c["editorLineNumber.activeForeground"] ?? fg,
        },
        ".cm-searchMatch": { backgroundColor: c["editor.findMatchHighlightBackground"] ?? selection },
        ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: c["editor.findMatchBackground"] ?? selection },
        ".cm-selectionMatch": { backgroundColor: c["editor.selectionHighlightBackground"] ?? "transparent" },
        "&.cm-focused .cm-matchingBracket": {
          backgroundColor: c["editorBracketMatch.background"] ?? "transparent",
          outline: `1px solid ${c["editorBracketMatch.border"] ?? alpha(fg, "55")}`,
        },
        ".cm-panels": { backgroundColor: c["editorWidget.background"] ?? bg, color: fg },
        ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${c["editorWidget.border"] ?? alpha(fg, "22")}` },
        ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: alpha(fg, "99") },
      },
      { dark: theme.type === "dark" },
    ),
    syntaxHighlighting(highlightFrom(theme)),
  ];
}
