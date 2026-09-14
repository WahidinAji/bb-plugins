# bb-plugin-mention-the-file

A file `@`-mention provider for [BB](https://getbb.app). Type `@` in the
composer — new thread, an existing thread, a queued message, or a side chat —
and search files in that thread's workspace by name. Picking one attaches the
file's contents to your message as agent-visible (user-hidden) context, so
you don't have to paste it in or describe where it lives.

Headless plugin: server-only, no frontend bundle, no settings.

## How it works

- **Trigger:** `@`, provider label **Files**.
- **Search** resolves the thread → its environment → the environment's
  `{ hostId, path }`, then runs a recursive fuzzy filename search
  (`bb.sdk.files.listPaths`) rooted at the workspace, scoped to that host —
  so it works for threads on remote/enrolled machines too, not just the
  local one.
- **Resolve** reads the picked file (`bb.sdk.files.read`) and returns its
  contents as the mention's context, wrapped in a fenced code block.
  - Binary files resolve to a short note (path + size) instead of embedding
    content.
  - Text content is capped at 200,000 characters; longer files are
    truncated with a trailing `(truncated)` marker rather than blocking the
    send.
- No thread/environment attached to the composer yet (e.g. a brand new
  thread before it's created) → the provider returns no results rather than
  erroring.

## Install

```bash
bb plugin install git:github.com/WahidinAji/bb-plugins@main --plugin mention-the-file
```

Or locally via path:

```bash
bb plugin install --yes ./mention-the-file
```

## Develop

```bash
bb plugin install .      # register this directory
bb plugin dev            # rebuild + reload on save
bb plugin logs mention-the-file -f
```

## Architecture

| File          | Role                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `server.ts`   | Registers the mention provider: `search` (fuzzy file lookup scoped to the thread's environment) and `resolve` (reads the file and builds the attached context). |

The item id returned from `search` has no accompanying thread/project
context when `resolve` is later called, so it self-encodes the
`hostId` and absolute path (`<hostId>::<path>`) needed to read the file back.
