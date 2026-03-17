export type SessionProviderName = 'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw';

const SESSION_PROVIDERS = new Set<SessionProviderName>([
  'claude',
  'codex',
  'browser',
  'opencode',
  'openclaw',
]);

export function parseSessionProviderList(value: string | undefined): SessionProviderName[] {
  if (!value) {
    return [];
  }
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is SessionProviderName => SESSION_PROVIDERS.has(item as SessionProviderName));
  return Array.from(new Set(parsed));
}

export function sessionProviderHelpText(): string {
  return 'claude, codex, browser, opencode, or openclaw';
}
