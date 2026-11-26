export const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  '__pycache__',
  '.DS_Store',
  '$RECYCLE.BIN',
  'System Volume Information',
];

export function parseIgnore(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${withWildcards}$`);
}

export function isIgnored(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');

  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!pattern) continue;

    if (pattern.includes('/')) {
      const matcher = globToRegExp(pattern);
      if (segments.some((_, index) => matcher.test(segments.slice(0, index + 1).join('/')))) {
        return true;
      }
      if (matcher.test(normalized)) return true;
    } else {
      const matcher = globToRegExp(pattern);
      if (segments.some((segment) => matcher.test(segment))) return true;
    }
  }
  return false;
}
