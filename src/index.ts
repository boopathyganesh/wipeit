#!/usr/bin/env node
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger, LOG_FILE } from './logger.js';
import { scan } from './scanner.js';
import { checkAccess, getSize, getMtime } from './fs-utils.js';
import { DEFAULT_FILTERS } from './types.js';
import type { AccessStatus, Filters, ScanItem, SortOrder, WipeResult } from './types.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const DRY_RUN = rawArgs.includes('--dry-run');
const pathArg = rawArgs.find((a) => !a.startsWith('-'));

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`
  wipeit — interactive node_modules cleaner

  Usage:
    wipeit [path] [--dry-run]

  Options:
    path        Root directory to scan  (default: ~/Desktop)
    --dry-run   Preview what would be deleted without removing anything
    --help      Show this help
    --version   Show version
  `);
  process.exit(0);
}

if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

// ── Config ────────────────────────────────────────────────────────────────────
const KNOWN_FLAGS = new Set(['--dry-run', '--help', '-h', '--version', '-v']);
const unknownFlags = rawArgs.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length > 0) {
  console.error(chalk.yellow(`  Warning: unknown flag(s): ${unknownFlags.join(', ')}`));
  console.error(chalk.dim(`  Run \`wipeit --help\` to see valid options.\n`));
}

const DEFAULT_ROOT = path.join(os.homedir(), 'Desktop');
const ROOT         = path.resolve(pathArg ?? DEFAULT_ROOT);
const _rawDepth    = parseInt(process.env['WIPEIT_DEPTH'] ?? '8', 10);
const MAX_DEPTH    = Number.isFinite(_rawDepth) && _rawDepth > 0 ? Math.min(_rawDepth, 50) : 8;
const HOME         = os.homedir();
const COLS         = process.stdout.columns ?? 100;
const CONCURRENCY  = 8;

// ── Pure helpers ──────────────────────────────────────────────────────────────
function rel(p: string): string {
  return p.replace(HOME, '~');
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `…${s.slice(-(maxLen - 1))}`;
}

function parseBytes(s: string): number {
  const m = s.match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1] ?? '0');
  switch ((m[2] ?? '').toUpperCase()) {
    case 'K': return n * 1_024;
    case 'M': return n * 1_024 ** 2;
    case 'G': return n * 1_024 ** 3;
    case 'T': return n * 1_024 ** 4;
    default: return n;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_024 ** 3) return `${(bytes / 1_024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1_024 ** 2) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Returns null if input is invalid so callers can warn the user. */
function parseSizeFilter(raw: string): { minBytes: number; maxBytes: number } | null {
  const m = raw.trim().match(/^([<>]?)([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) return null;
  const bytes = parseBytes(`${m[2] ?? '0'}${m[3] ?? ''}`);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (m[1] === '<') return { minBytes: 0, maxBytes: bytes };
  return { minBytes: bytes, maxBytes: Infinity };
}

/** Returns null if input is invalid so callers can warn the user. */
function parseAgeFilter(raw: string): number | null {
  const m = raw.trim().match(/^>?(\d+)\s*([dmy])$/i);
  if (!m) return null;
  const n = parseInt(m[1] ?? '0', 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const DAY = 86_400_000;
  switch ((m[2] ?? '').toLowerCase()) {
    case 'd': return n * DAY;
    case 'm': return n * 30 * DAY;
    case 'y': return n * 365 * DAY;
    default:  return null;
  }
}

// ── Filter / sort helpers ─────────────────────────────────────────────────────
function applyFilters(items: ScanItem[], filters: Filters): ScanItem[] {
  return items.filter((item) => {
    if (filters.path) {
      const p = rel(path.dirname(item.nmPath)).toLowerCase();
      if (!p.includes(filters.path.toLowerCase())) return false;
    }
    const bytes = parseBytes(item.size);
    if (filters.minBytes > 0 && bytes < filters.minBytes) return false;
    if (filters.maxBytes < Infinity && bytes > filters.maxBytes) return false;
    if (filters.olderThanMs > 0 && item.mtimeMs > 0) {
      if (Date.now() - item.mtimeMs < filters.olderThanMs) return false;
    }
    return true;
  });
}

function sortItems(items: ScanItem[], sort: SortOrder): ScanItem[] {
  return [...items].sort((a, b) => {
    switch (sort) {
      case 'size-desc': return parseBytes(b.size) - parseBytes(a.size);
      case 'size-asc': return parseBytes(a.size) - parseBytes(b.size);
      case 'path': return a.nmPath.localeCompare(b.nmPath);
      default: {
        if (a.access === 'writable' && b.access !== 'writable') return -1;
        if (a.access !== 'writable' && b.access === 'writable') return 1;
        return 0;
      }
    }
  });
}

function describeFilters(f: Filters): string {
  const parts: string[] = [];
  if (f.path) parts.push(`path="${f.path}"`);
  if (f.minBytes > 0) parts.push(`size>${formatBytes(f.minBytes)}`);
  if (f.maxBytes < Infinity) parts.push(`size<${formatBytes(f.maxBytes)}`);
  if (f.olderThanMs > 0) parts.push(`age>${Math.round(f.olderThanMs / 86_400_000)}d`);
  return parts.join('  ');
}

function hasFilters(f: Filters): boolean {
  return !!(f.path || f.minBytes > 0 || f.maxBytes < Infinity || f.olderThanMs > 0);
}

// ── UI builders ───────────────────────────────────────────────────────────────
function statusBadge(access: AccessStatus): { badge: string; disabled: string | false } {
  switch (access) {
    case 'writable': return { badge: chalk.green('✓ writable '), disabled: false };
    case 'readonly': return { badge: chalk.yellow('⚠ read-only'), disabled: 'read-only — cannot delete' };
    case 'noaccess': return { badge: chalk.red('✗ no access'), disabled: 'no access — permission denied' };
  }
}

async function buildScanItem(nmPath: string): Promise<ScanItem> {
  const [access, size, mtimeMs] = await Promise.all([
    checkAccess(nmPath),
    getSize(nmPath),
    getMtime(nmPath),
  ]);
  const { badge, disabled } = statusBadge(access);
  const maxPathLen = Math.max(20, COLS - 22 - 4);
  const pathCol = truncate(rel(path.dirname(nmPath)), maxPathLen);
  const sizeCol = chalk.cyan(size.padStart(7));
  const choiceName = `${badge}  ${sizeCol}  ${pathCol}`;
  return { nmPath, access, size, mtimeMs, choiceName, disabled };
}

// ── Concurrency-limited item builder ─────────────────────────────────────────
async function buildItemsConcurrently(
  found: string[],
  onProgress: (done: number, total: number) => void,
): Promise<ScanItem[]> {
  const results: (ScanItem | undefined)[] = new Array(found.length);
  let done = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, found.length) }, async (_, worker) => {
      let i = worker;
      while (i < found.length) {
        results[i] = await buildScanItem(found[i]!);
        onProgress(++done, found.length);
        i += CONCURRENCY;
      }
    }),
  );

  return results.filter((r): r is ScanItem => r !== undefined);
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function runScan(root: string): Promise<ScanItem[]> {
  const scanSpinner = ora({
    text: 'Scanning…  0 found', color: 'cyan', spinner: {
      frames: ['✢', '✣', '✤', '✱', '✲', '✳', '✴', '✶', '✷', '✸', '✻'],
      interval: 150,
    }
  }).start();
  const scanStart = Date.now();

  const found = await scan(root, MAX_DEPTH, (_p, total) => {
    scanSpinner.text = `Scanning…  ${chalk.cyan(total)} found`;
  });

  const scanMs = Date.now() - scanStart;
  scanSpinner.succeed(`Scan complete — ${chalk.cyan(found.length)} found  ${chalk.dim(`(${scanMs}ms)`)}`);
  logger.info(`Scan complete — ${found.length} found in ${scanMs}ms`);
  found.forEach((p) => logger.info(`  FOUND   ${p}`));

  if (found.length === 0) return [];

  const chkSpinner = ora({
    text: `Checking 0 / ${found.length}`, color: 'cyan', spinner: {
      frames: ['✢', '✣', '✤', '✱', '✲', '✳', '✴', '✶', '✷', '✸', '✻'],
      interval: 150,
    }
  }).start();
  const items = await buildItemsConcurrently(found, (done, total) => {
    chkSpinner.text = `Checking permissions & sizes…  ${chalk.cyan(done)} / ${total}`;
  });
  chkSpinner.succeed(`Permissions & sizes checked  ${chalk.dim(`(${found.length} entries)`)}`);
  items.forEach((i) => logger.info(`  CHECK   ${i.nmPath}  access=${i.access}  size=${i.size}`));

  return items;
}

// ── Filter submenu ────────────────────────────────────────────────────────────
async function promptFilters(current: Filters): Promise<Filters> {
  const filters = { ...current };

  while (true) {
    const sizeDesc = filters.minBytes > 0
      ? `>${formatBytes(filters.minBytes)}`
      : filters.maxBytes < Infinity
        ? `<${formatBytes(filters.maxBytes)}`
        : null;
    const ageDesc = filters.olderThanMs > 0
      ? `>${Math.round(filters.olderThanMs / 86_400_000)}d`
      : null;

    const action = await select({
      message: 'Filters',
      choices: [
        { name: `⌕  Path    ${filters.path ? chalk.yellow(filters.path) : chalk.dim('(none)')}`, value: 'path' },
        { name: `📦 Size    ${sizeDesc ? chalk.yellow(sizeDesc) : chalk.dim('(none)')}`, value: 'size' },
        { name: `📅 Age     ${ageDesc ? chalk.yellow(ageDesc) : chalk.dim('(none — e.g. older than N months)')}`, value: 'age' },
        { name: `✕  Clear all filters`, value: 'clear' },
        { name: `← Back`, value: 'back' },
      ],
    });

    if (action === 'back') return filters;
    if (action === 'clear') { Object.assign(filters, DEFAULT_FILTERS); continue; }

    if (action === 'path') {
      filters.path = await input({
        message: 'Filter by path segment  (e.g. Axon · core · cenizaslabs-ai):',
        default: filters.path,
      });
      continue;
    }

    if (action === 'size') {
      const raw = await input({ message: 'Size  (e.g. >500M  >1G  <100M — blank to clear):' });
      if (!raw.trim()) {
        filters.minBytes = 0; filters.maxBytes = Infinity;
      } else {
        const parsed = parseSizeFilter(raw);
        if (!parsed) {
          console.log(chalk.red(`  Invalid size format: "${raw}". Use e.g. >500M, <1G, >2G`));
          logger.warn(`Invalid size filter input: "${raw}"`);
        } else {
          filters.minBytes = parsed.minBytes; filters.maxBytes = parsed.maxBytes;
        }
      }
      continue;
    }

    if (action === 'age') {
      const raw = await input({ message: 'Older than  (e.g. 30d · 6m · 1y — blank to clear):' });
      if (!raw.trim()) {
        filters.olderThanMs = 0;
      } else {
        const parsed = parseAgeFilter(raw);
        if (parsed === null) {
          console.log(chalk.red(`  Invalid age format: "${raw}". Use e.g. 30d, 6m, 1y`));
          logger.warn(`Invalid age filter input: "${raw}"`);
        } else {
          filters.olderThanMs = parsed;
        }
      }
      continue;
    }
  }
}

// ── Pre-selection menu ────────────────────────────────────────────────────────
type PreMenuReturn = { next: 'select'; items: ScanItem[]; filters: Filters; sort: SortOrder }
  | { next: 'exit' };

const SORT_LABELS: Record<SortOrder, string> = {
  'access': 'writable first',
  'size-desc': 'size ↓',
  'size-asc': 'size ↑',
  'path': 'path A→Z',
};

let _isScanning = false; // HIGH 6 — guard against concurrent rescans

async function runPreMenu(
  initialItems: ScanItem[],
  initialFilters: Filters,
  initialSort: SortOrder,
): Promise<PreMenuReturn> {
  let items = initialItems;
  let filters = initialFilters;
  let sort = initialSort;

  while (true) {
    const filtered = applyFilters(items, filters);
    const filterDesc = describeFilters(filters);
    const countSuffix = hasFilters(filters)
      ? chalk.yellow(filterDesc) + chalk.dim(`  ${filtered.length} / ${items.length}`)
      : chalk.dim(`${items.length} found`);

    const action = await select({
      message: `wipeit  ·  ${countSuffix}${DRY_RUN ? chalk.yellow('  [dry-run]') : ''}`,
      choices: [
        { name: `${chalk.green('▶')} Browse & select`, value: 'select' },
        { name: `${chalk.yellow('⌕')} Filters   ${hasFilters(filters) ? chalk.yellow(`[${filterDesc}]`) : chalk.dim('(none)')}`, value: 'filters' },
        { name: `${chalk.magenta('⇅')} Sort      ${chalk.dim(SORT_LABELS[sort])}`, value: 'sort' },
        { name: `${chalk.blue('↺')} Rescan directory`, value: 'rescan' },
        { name: `${chalk.red('✕')} Exit`, value: 'exit' },
      ],
    });

    if (action === 'exit') {
      const ok = await confirm({ message: 'Exit wipeit?', default: false });
      if (ok) return { next: 'exit' };
      continue;
    }

    if (action === 'filters') {
      filters = await promptFilters(filters);
      continue;
    }

    if (action === 'sort') {
      sort = await select<SortOrder>({
        message: 'Sort by',
        choices: [
          { name: 'Writable first  (default)', value: 'access' },
          { name: 'Size: largest first', value: 'size-desc' },
          { name: 'Size: smallest first', value: 'size-asc' },
          { name: 'Path A→Z', value: 'path' },
        ],
      });
      continue;
    }

    if (action === 'rescan') {
      if (_isScanning) {
        console.log(chalk.yellow('  Already scanning — please wait…'));
        continue;
      }
      logger.info('Rescan triggered by user');
      _isScanning = true;
      try { items = await runScan(ROOT); } finally { _isScanning = false; }
      continue;
    }

    // 'select'
    return { next: 'select', items, filters, sort };
  }
}

// ── Checkbox ──────────────────────────────────────────────────────────────────
async function runCheckbox(filtered: ScanItem[], preselect: string[]): Promise<string[]> {
  console.log(
    '\n  ' + chalk.gray('Legend:') + '  ' +
    chalk.green('✓ writable') + '   ' +
    chalk.yellow('⚠ read-only') + '   ' +
    chalk.red('✗ no access') + '\n',
  );

  return checkbox({
    message: 'Select node_modules  (↑↓ navigate · space select · a all · ⏎ submit):',
    choices: filtered.map(({ choiceName, nmPath, disabled }) => ({
      name: choiceName,
      value: nmPath,
      disabled,
      checked: preselect.includes(nmPath),
    })),
    pageSize: 15,
  });
}

// ── Post-selection menu ───────────────────────────────────────────────────────
async function runPostMenu(selected: string[], items: ScanItem[]): Promise<'proceed' | 'invert' | 'back'> {
  const projectedBytes = selected.reduce(
    (sum, p) => sum + parseBytes(items.find((i) => i.nmPath === p)?.size ?? '0'), 0,
  );

  return select({
    message:
      `${chalk.bold(selected.length)} selected` +
      (projectedBytes > 0 ? `  ·  ~${chalk.cyan(formatBytes(projectedBytes))} to free` : ''),
    choices: [
      { name: `${chalk.green('✓')} Proceed with deletion`, value: 'proceed' },
      { name: `${chalk.cyan('⇄')} Invert selection`, value: 'invert' },
      { name: `${chalk.gray('←')} Back`, value: 'back' },
    ],
  });
}

// ── Selection state machine ───────────────────────────────────────────────────
async function runSelectionLoop(initialItems: ScanItem[]): Promise<string[]> {
  let items = initialItems;
  let filters = { ...DEFAULT_FILTERS };
  let sort: SortOrder = 'access';
  let preselect: string[] = [];
  let filtered: ScanItem[] = [];

  type Stage = 'premenu' | 'checkbox' | 'postmenu';
  let stage: Stage = 'premenu';
  let selected: string[] = [];

  while (true) {
    if (stage === 'premenu') {
      const result = await runPreMenu(items, filters, sort);
      if (result.next === 'exit') return [];

      // Update state from pre-menu result
      items = result.items;
      filters = result.filters;
      sort = result.sort;
      filtered = sortItems(applyFilters(items, filters), sort);
      preselect = []; // fresh selection when entering checkbox from pre-menu
      stage = 'checkbox';
      continue;
    }

    if (stage === 'checkbox') {
      selected = await runCheckbox(filtered, preselect);
      preselect = [];
      stage = selected.length === 0 ? 'premenu' : 'postmenu';
      continue;
    }

    if (stage === 'postmenu') {
      const action = await runPostMenu(selected, items);
      if (action === 'proceed') return selected;

      if (action === 'invert') {
        const writableInView = filtered.filter((i) => i.access === 'writable').map((i) => i.nmPath);
        preselect = writableInView.filter((p) => !selected.includes(p));
        logger.info(`Invert: ${preselect.length} items preselected`);
        stage = 'checkbox';
        continue;
      }

      // 'back' → home screen, clear preselect
      preselect = [];
      stage = 'premenu';
      continue;
    }
  }
}

// ── Wipe (with retry on failure) ──────────────────────────────────────────────
async function runWipe(
  toWipe: string[],
  sizeMap: Map<string, string>, // snapshot of sizes captured at scan time
): Promise<{ succeeded: WipeResult[]; failed: WipeResult[] }> {
  const spinner = ora({
    color: 'cyan', spinner: {
      frames: ['✢', '✣', '✤', '✱', '✲', '✳', '✴', '✶', '✷', '✸', '✻'],
      interval: 150,
    }
  });
  const succeeded: WipeResult[] = [];
  const failed: WipeResult[] = [];

  for (const nmPath of toWipe) {
    const label = rel(nmPath);
    const isDryRun = DRY_RUN;

    spinner.start(isDryRun ? chalk.dim(`[dry-run] ${label}`) : chalk.gray(`Wiping  ${label}`));
    const start = Date.now();

    try {
      if (!isDryRun) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out after 30s — path may be on a frozen mount')), 30_000).unref(),
        );
        await Promise.race([fs.promises.rm(nmPath, { recursive: true }), timeout]);
      }
      const durationMs = Date.now() - start;
      const prefix = isDryRun ? chalk.yellow('[dry-run] ') : '';
      spinner.succeed(prefix + chalk.green('Deleted ') + label + chalk.dim(`  (${durationMs}ms)`));
      const result: WipeResult = { nmPath, success: true, durationMs };
      succeeded.push(result);
      logger.info(`  DELETED  ${nmPath}  (${durationMs}ms)${isDryRun ? '  [dry-run]' : ''}`);
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      spinner.fail(chalk.red('Failed  ') + label + chalk.gray(`  (${error})`));
      const result: WipeResult = { nmPath, success: false, durationMs, error };
      failed.push(result);
      logger.error(`  FAILED   ${nmPath}  (${durationMs}ms)  ${error}`);
    }
  }

  // Offer retry for failures — deduplicate paths to prevent double-deletion
  if (failed.length > 0 && !DRY_RUN) {
    console.log('');
    const retry = await confirm({
      message: `${failed.length} deletion${failed.length > 1 ? 's' : ''} failed — retry?`,
      default: true,
    });
    if (retry) {
      const seen = new Set(succeeded.map((r) => r.nmPath));
      const retryPaths = [...new Set(failed.map((r) => r.nmPath))].filter((p) => !seen.has(p));
      const { succeeded: rs, failed: rf } = await runWipe(retryPaths, sizeMap);
      return { succeeded: [...succeeded, ...rs], failed: rf };
    }
  }

  return { succeeded, failed };
}

// ── Signal handlers ───────────────────────────────────────────────────────────
function handleSignal(signal: string): void {
  logger.warn(`Process received ${signal} — exiting cleanly`);
  logger.separator();
  logger.close().finally(() => {
    console.log(chalk.yellow(`\n  Interrupted (${signal}). Exiting.\n`));
    process.exit(1);
  });
}
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT',  () => handleSignal('SIGINT'));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.separator();
  logger.info(`Session start`);
  logger.info(`Scan root : ${ROOT}`);
  logger.info(`Max depth : ${MAX_DEPTH}`);
  logger.info(`Dry run   : ${DRY_RUN}`);
  logger.info(`Log file  : ${LOG_FILE}`);

  console.log(chalk.bold(`\n  wipeit  —  node_modules cleaner${DRY_RUN ? chalk.yellow('  [dry-run]') : ''}\n`));
  console.log(
    `  ${chalk.gray('Root')}  ${chalk.white(rel(ROOT))}` +
    (!pathArg ? chalk.dim('  (default · pass a path to override)') : ''),
  );
  console.log(`  ${chalk.gray('Log')}   ${chalk.dim(LOG_FILE)}\n`);

  // CRITICAL 2 — Validate ROOT before scanning
  try {
    const stat = await fs.promises.stat(ROOT);
    if (!stat.isDirectory()) {
      console.error(chalk.red(`  Error: "${rel(ROOT)}" is not a directory.\n`));
      process.exit(1);
    }
  } catch {
    console.error(chalk.red(`  Error: "${rel(ROOT)}" does not exist or is not accessible.\n`));
    process.exit(1);
  }

  const items = await runScan(ROOT);
  if (items.length === 0) {
    logger.warn('No node_modules found. Exiting.');
    console.log(chalk.yellow('\n  No node_modules directories found.\n'));
    return;
  }

  const selected = await runSelectionLoop(items);
  if (selected.length === 0) {
    logger.warn('Nothing selected. Exiting.');
    console.log(chalk.yellow('\n  Nothing selected. Exiting.\n'));
    return;
  }

  selected.forEach((p) => logger.info(`  SELECTED  ${p}`));

  // Final confirmation
  const projectedBytes = selected.reduce(
    (sum, p) => sum + parseBytes(items.find((i) => i.nmPath === p)?.size ?? '0'), 0,
  );
  console.log('');
  const confirmed = await confirm({
    message:
      `${DRY_RUN ? chalk.yellow('[dry-run] ') : ''}Delete ${selected.length} node_modules` +
      (projectedBytes > 0 ? ` (~${formatBytes(projectedBytes)})` : '') + '?',
    default: false,
  });

  if (!confirmed) {
    logger.warn('User aborted at confirmation.');
    console.log(chalk.yellow('\n  Aborted.\n'));
    return;
  }

  logger.info('Confirmed. Starting wipe...');
  console.log('');

  // Snapshot sizes at confirmation time — insulates report from any future rescan
  const sizeMap = new Map(items.map((i) => [i.nmPath, i.size]));
  const { succeeded, failed } = await runWipe(selected, sizeMap);

  // Space report uses the snapshot, not a live lookup
  const freedBytes = succeeded.reduce(
    (sum, r) => sum + parseBytes(sizeMap.get(r.nmPath) ?? '0'), 0,
  );
  const freedLabel = freedBytes > 0 ? formatBytes(freedBytes) : '?';

  console.log('');
  console.log(`  ${chalk.bold('┌─ Report ───────────────────────────────')}`);
  if (DRY_RUN) {
    console.log(`  ${chalk.bold('│')}  ${chalk.yellow('dry-run — nothing actually deleted')}`);
  }
  console.log(`  ${chalk.bold('│')}  ${chalk.green(`✓ ${succeeded.length} deleted`)}`);
  if (failed.length > 0) {
    console.log(`  ${chalk.bold('│')}  ${chalk.red(`✗ ${failed.length} failed`)}`);
  }
  console.log(`  ${chalk.bold('│')}  ${chalk.cyan(`Space freed : ~${freedLabel}`)}`);
  console.log(`  ${chalk.bold('└───────────────────────────────────────')}\n`);

  logger.info(`Report — ${succeeded.length} deleted · ${failed.length} failed · ~${freedLabel} freed`);
  logger.info('Session end');
  logger.separator();
}

main()
  .then(() => logger.close())
  .catch(async (err: unknown) => {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      logger.warn('Session cancelled (Ctrl+C)');
      await logger.close();
      console.log(chalk.yellow('\n  Cancelled.\n'));
      process.exit(0);
    }
    const msg   = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? msg) : msg;
    logger.error(`Unhandled: ${msg}`);
    logger.error(`Stack: ${stack}`);
    await logger.close();
    console.error(chalk.red('\n  Error:'), msg);
    process.exit(1);
  });
