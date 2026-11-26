Edit code in BB's side panel. When the file changes on disk, the editor shows the new version.

## What you get

- A CodeMirror editor for code files, with syntax colors from BB's code theme, search, code folding, and multiple cursors.
- If an agent edits a file you have open, its change appears in the editor within about a second.
- If the file changed since you last synced, your save is refused instead of overwriting it, and you choose which version to keep.
- Read-only code in BB's file preview and in plugins like Files renders with CodeMirror instead of BB's built-in renderer.

## How it works

BB reads and writes the files on the machine that holds them. The plugin sends nothing outside your BB server and needs no account or API key.
