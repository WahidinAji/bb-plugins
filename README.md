# bb-plugins

A collection of [BB](https://getbb.app) plugins. Each subdirectory is a standalone plugin with its own `package.json` and BB manifest. Install one or install all via `.bb/plugins.json`.

## Plugins

| Plugin | What it does |
|--------|--------------|
| [mention-the-file](mention-the-file/) | Type `@` in the composer to search and mention a file from the thread's workspace; the file's contents are attached as context for the agent. |
| [porcelain](https://github.com/WahidinAji/bb-plugin-porcelain) | VS Code-style source control for a thread's environment — stage, discard, diff, commit, branch, and push the git working tree. Included as a git submodule. |

## Install

### One plugin

```bash
bb plugin install git:github.com/WahidinAji/bb-plugins@main --plugin mention-the-file
```

Or locally via path:

```bash
bb plugin install --yes ./bb-plugins/mention-the-file
```

### All via collection manifest

`.bb/plugins.json` indexes the plugins in this repo as a collection:

```bash
bb plugin install git:github.com/WahidinAji/bb-plugins@main
```

`bb` records the subdirectory per install, so `bb plugin outdated` / `update` / `remove` work independently even though every plugin shares one repo.

### Porcelain

Porcelain lives in [its own repository](https://github.com/WahidinAji/bb-plugin-porcelain) and is vendored here as a git submodule, so install it directly:

```bash
bb plugin install git:github.com/WahidinAji/bb-plugin-porcelain
```

## Development

```bash
bb plugin list
bb plugin build   # inside a plugin dir — emits dist/
bb plugin reload <id>
bb plugin dev     # watch mode
```

To clone this repo with porcelain included:

```bash
git clone --recurse-submodules git@github.com:WahidinAji/bb-plugins.git
```

> **Note:** Since porcelain lives in its own repository, this repo only pins a commit. When porcelain gets a new release, bump the pointer here:
>
> ```bash
> cd bb-plugin-porcelain && git pull && cd ..
> git add bb-plugin-porcelain && git commit -m "chore: bump porcelain"
> ```
