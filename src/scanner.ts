import fs from 'fs';
import path from 'path';

/**
 * Async recursive scan for `node_modules` directories.
 * Using fs.promises yields to the event loop between reads,
 * which lets ora's spinner animation actually render.
 */
export async function scan(
  dir: string,
  maxDepth: number,
  onFound?: (found: string, total: number) => void,
  depth = 0,
  results: string[] = [],
): Promise<string[]> {
  if (depth > maxDepth) return results;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks — prevents path traversal
    if (!entry.isDirectory()) continue;

    if (entry.name === 'node_modules') {
      const full = path.join(dir, entry.name);
      results.push(full);
      onFound?.(full, results.length);
      continue; // never recurse inside node_modules
    }

    if (entry.name.startsWith('.')) continue;

    await scan(path.join(dir, entry.name), maxDepth, onFound, depth + 1, results);
  }

  return results;
}
