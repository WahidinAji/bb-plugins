import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { csharp, dart, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";

const legacy = (parser: StreamParser<unknown>) => () => StreamLanguage.define(parser);

const byExtension: Record<string, () => Extension> = {
  go: go,
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: json,
  jsonc: json,
  py: python,
  rs: rust,
  java: java,
  kt: legacy(kotlin),
  kts: legacy(kotlin),
  scala: legacy(scala),
  dart: legacy(dart),
  cs: legacy(csharp),
  c: cpp,
  h: cpp,
  cc: cpp,
  cpp: cpp,
  cxx: cpp,
  hh: cpp,
  hpp: cpp,
  php: php,
  rb: legacy(ruby),
  lua: legacy(lua),
  swift: legacy(swift),
  sql: () => sql(),
  css: css,
  scss: css,
  less: css,
  html: html,
  htm: html,
  vue: html,
  svelte: html,
  xml: xml,
  yaml: yaml,
  yml: yaml,
  toml: legacy(toml),
  sh: legacy(shell),
  bash: legacy(shell),
  zsh: legacy(shell),
  ps1: legacy(powerShell),
  pl: legacy(perl),
  r: legacy(r),
  hs: legacy(haskell),
  proto: legacy(protobuf),
  ini: legacy(properties),
  cfg: legacy(properties),
  conf: legacy(properties),
  env: legacy(properties),
  properties: legacy(properties),
  dockerfile: legacy(dockerFile),
  md: markdown,
};

/**
 * Extensions this plugin opens by default. Markdown, HTML, SVG and notebooks
 * are left to BB's rendered previews.
 */
export const OPENER_EXTENSIONS = [
  ...Object.keys(byExtension).filter((ext) => !["md", "html", "htm"].includes(ext)),
  "mod", "sum", "txt", "log", "csv", "tsv", "lock", "gradle", "tf", "hcl", "graphql", "gql",
  "ex", "exs", "erl", "ml", "clj", "fish", "gitignore", "dockerignore", "editorconfig",
];

export function languageFor(path: string): Extension {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return legacy(dockerFile)();
  if (name === "makefile" || name === ".env" || name.startsWith(".env.")) {
    return name === "makefile" ? legacy(shell)() : legacy(properties)();
  }
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1);
  return byExtension[ext]?.() ?? [];
}
