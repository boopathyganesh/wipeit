# nm-wipe

Interactive `node_modules` cleaner CLI for macOS and Linux.

`nm-wipe` scans a directory tree for `node_modules` folders, lets you interactively filter and select them, and then deletes them (or simulates deletion in dry‑run mode). It’s designed to safely reclaim disk space from old projects.

> **Warning**  
> This tool deletes directories. Always start with `--dry-run` until you’re comfortable with what it will remove.

## Install

```bash
npm install -g nm-wipe
# or
pnpm add -g nm-wipe
# or
yarn global add nm-wipe
```

After installation you’ll have an `nm-wipe` binary on your PATH.

## Usage

```bash
nm-wipe [root] [--dry-run]
```

- **`root`** (optional): directory to scan.  
  - Defaults to your desktop: `~/Desktop`.
- **`--dry-run`**: simulate deletions without removing anything.
- **`--help` / `-h`**: show help.
- **`--version` / `-v`**: show version.

### Examples

```bash
# Safely preview what would be deleted under ~/Desktop
nm-wipe --dry-run

# Scan a specific projects folder (recommended: first run with --dry-run)
nm-wipe ~/dev --dry-run

# Actually delete selected node_modules under ~/dev
nm-wipe ~/dev
```

## Interactive flow

1. **Scan**: `nm-wipe` scans `root` (default `~/Desktop`) up to a configurable depth for `node_modules` folders.
2. **Filter & sort**:
   - Filter by:
     - **Path segment** (e.g. `Axon`, `core`, `cenizaslabs-ai`).
     - **Size** (e.g. `>500M`, `<1G`, `>2G`).
     - **Age** (last modified) (e.g. `30d`, `6m`, `1y`).
   - Sort by:
     - Writable first (default).
     - Size (largest / smallest first).
     - Path A→Z.
3. **Select**:
   - Use the checkbox UI to select which `node_modules` folders to delete.
   - Read‑only or no‑access directories are shown but disabled.
4. **Confirm**:
   - `nm-wipe` shows how many folders are selected and an approximate total size to be freed.
   - You must confirm before anything is deleted.
5. **Wipe**:
   - Deletions run one by one with a progress spinner.
   - Failures are reported and can be retried.

## Environment variables

- **`WIPEIT_DEPTH`**  
  Maximum directory depth to scan from the root (default `8`, hard‑capped at `50`).

  ```bash
  WIPEIT_DEPTH=12 nm-wipe ~/dev --dry-run
  ```

## Safety characteristics

- Never follows symlinks.
- Never recurses into `node_modules` contents (only removes the directory itself).
- Uses filesystem permission checks to show whether a directory is writable, read‑only, or not accessible.
- Uses `du -sh` to estimate sizes; timeouts and permission errors degrade gracefully without crashing the CLI.

## Development

This repo uses TypeScript and ships compiled JavaScript in `dist/`.

Prerequisites:

- Node.js **18+**

Install dependencies (recommended: `bun`, but `npm`/`pnpm` also work):

```bash
bun install
```

Build and stamp the CLI:

```bash
bun run build
bun run postbuild
```

Run in dev mode (TS directly with tsx):

```bash
bun run dev
```

Run the built CLI locally:

```bash
node dist/index.js --dry-run
```

## License

MIT © Boopathy Ganesh K

