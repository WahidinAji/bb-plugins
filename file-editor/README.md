# Live Editor

A BB plugin that opens code files in a CodeMirror editor and keeps the editor in sync with the file on disk.

- **Changes on disk show up in the editor.** If an agent, a git checkout, or another program changes an open file, the editor shows the new version within about a second. Your cursor and scroll position stay where they were.
- **Saves never overwrite a newer file.** Each save sends the hash of the version you started from. If the file changed since then, the save is refused and a banner asks whether to use the disk version or keep yours.
- **Autosave** runs about a second after you stop typing. You can turn it off. `Ctrl/Cmd+S` always saves.
- **Line endings stay as they are.** CRLF files are saved as CRLF.
- **It also replaces BB's read-only code viewer.** BB's file preview and plugins that use BB's viewer, such as Files, render code with CodeMirror instead. This avoids the `FileRenderer.processFileResult: Line doesnt exist` error that BB's built-in renderer throws.

The editor uses the colors of BB's active code theme, in light and dark mode.

## Use

Code files you open in BB's side panel open in Live Editor. That includes file links in chat, the file picker, and `bb thread open <path>`. Markdown, HTML, SVG and notebook files still open in BB's rendered preview.

To pick a different opener for a file type, go to **Settings > File openers**.

## Settings

Change these on the plugin's settings page or with `bb plugin config file-editor`.

| Setting | Default | What it does |
|---|---|---|
| `autosave` | `true` | Save about 1 second after you stop typing. When off, save with `Ctrl/Cmd+S` or the Save button. |
| `replaceViewer` | `true` | Render read-only code with CodeMirror instead of BB's source renderer. |
| `pollIntervalMs` | `1000` | How often the server checks open files for changes, in milliseconds, between 250 and 60000. Reload the plugin after changing it. |

## How sync works

Plugins can't watch files in BB, so the server reads each open file on a timer and compares its sha256. An editor tab registers the file for 45 seconds and renews that every 15 seconds while the tab is visible. The server stops checking files whose tabs are hidden or closed. When a hash changes, the server publishes a `file-changed` realtime event, and every tab showing that file reads it again. Saves call `bb.sdk.files.write` with `expectedSha256`, so the host rejects a save if someone else changed the file first.

## Development

```bash
npm install
npm run typecheck
bb plugin build
bb plugin install --yes .   # or: bb plugin reload file-editor
bb plugin dev               # rebuild and reload on save
```

- `server.ts` finds the host and absolute path for a file (workspace, thread storage, or host path), serves the read and save RPCs, and runs the change checks.
- `app.tsx` is the editor that opens files.
- `editor/viewer.tsx` is the read-only viewer that replaces BB's source renderer.
- `editor/theme.ts` turns BB's VS Code style code theme into CodeMirror styles.
- `editor/languages.ts` picks a CodeMirror language from the file extension.
