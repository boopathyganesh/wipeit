export type AccessStatus = 'writable' | 'readonly' | 'noaccess';
export type SortOrder   = 'access' | 'size-desc' | 'size-asc' | 'path';

export interface ScanItem {
  nmPath:     string;
  access:     AccessStatus;
  size:       string;
  mtimeMs:    number;
  choiceName: string;
  disabled:   string | false;
}

export interface WipeResult {
  nmPath:     string;
  success:    boolean;
  durationMs: number;
  error?:     string;
}

export interface Filters {
  path:        string;
  minBytes:    number;
  maxBytes:    number;
  olderThanMs: number;
}

export const DEFAULT_FILTERS: Filters = {
  path:        '',
  minBytes:    0,
  maxBytes:    Infinity,
  olderThanMs: 0,
};
