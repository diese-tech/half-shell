import type { ProviderConfig, ProviderTier } from './providers/types.js';

export interface GitHubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  appLogin: string;
  apiBaseUrl: string;
}

export type StoreKind = 'file' | 'sqlite';

export interface ReviewConfig {
  maxFiles: number;
  maxPatchChars: number;
  maxPromptChars: number;
  maxRelatedFiles: number;
  maxRelatedChars: number;
  /** Ceiling on GitHub requests spent gathering related context per review. */
  maxRelatedLookups: number;
  searchCallers: boolean;
  dryRun: boolean;
  dataDir: string;
  store: StoreKind;
  /** Database path when `store` is sqlite. */
  databasePath: string;
  /** Paths excluded from review context (generated/vendored noise). */
  excludePatterns: RegExp[];
}

export interface Config {
  port: number;
  github: GitHubConfig | undefined;
  providers: ProviderConfig[];
  /** Providers named in the chain that could not be configured, and why. */
  providerProblems: string[];
  allowPaidInference: boolean;
  review: ReviewConfig;
}

const KNOWN_PROVIDERS: Record<string, Partial<ProviderConfig>> = {
  groq: { tier: 'free', baseUrl: 'https://api.groq.com/openai/v1' },
  openrouter: { tier: 'free', baseUrl: 'https://openrouter.ai/api/v1' },
  ollama: { tier: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
};

const DEFAULT_EXCLUDES = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|zip|gz)$/i,
];

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Like `int`, but 0 is a legitimate value rather than a rejected one — some
 * settings document 0 as "disabled". A malformed value still falls back to the
 * default instead of becoming NaN, which would silently remove the bound.
 */
function nonNegativeInt(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** PEM keys are commonly supplied base64-encoded or with escaped newlines. */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN')) return trimmed.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded;
  } catch {
    // fall through to the raw value
  }
  return trimmed;
}

function loadGitHub(): GitHubConfig | undefined {
  const appId = env('GITHUB_APP_ID');
  const privateKey = env('GITHUB_PRIVATE_KEY');
  const webhookSecret = env('GITHUB_WEBHOOK_SECRET');
  if (!appId || !privateKey || !webhookSecret) return undefined;
  return {
    appId,
    privateKey: normalizePrivateKey(privateKey),
    webhookSecret,
    appLogin: env('GITHUB_APP_LOGIN') ?? 'half-shell[bot]',
    apiBaseUrl: env('GITHUB_API_BASE_URL') ?? 'https://api.github.com',
  };
}

function loadProviders(): { providers: ProviderConfig[]; problems: string[] } {
  const ids = (env('HALF_SHELL_PROVIDERS') ?? 'ollama')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const providers: ProviderConfig[] = [];
  const problems: string[] = [];

  for (const id of ids) {
    const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const defaults = KNOWN_PROVIDERS[id.toLowerCase()] ?? {};
    const baseUrl = env(`HALF_SHELL_PROVIDER_${key}_BASE_URL`) ?? defaults.baseUrl;
    const model = env(`HALF_SHELL_PROVIDER_${key}_MODEL`) ?? defaults.model;

    // Say exactly what is missing: a silently dropped provider is worse than
    // a loud one, because the chain just gets quietly shorter.
    const missing: string[] = [];
    if (!baseUrl) missing.push(`HALF_SHELL_PROVIDER_${key}_BASE_URL`);
    if (!model) missing.push(`HALF_SHELL_PROVIDER_${key}_MODEL`);
    if (missing.length > 0) {
      problems.push(`provider "${id}" is not usable; set ${missing.join(' and ')}`);
      continue;
    }
    if (!baseUrl || !model) continue;
    providers.push({
      id,
      tier: (env(`HALF_SHELL_PROVIDER_${key}_TIER`) as ProviderTier) ?? defaults.tier ?? 'paid',
      baseUrl,
      model,
      apiKey: env(`HALF_SHELL_PROVIDER_${key}_API_KEY`),
      timeoutMs: int(`HALF_SHELL_PROVIDER_${key}_TIMEOUT_MS`, 120_000),
    });
  }
  return { providers, problems };
}

export function loadConfig(): Config {
  const inference = loadProviders();
  return {
    port: int('PORT', 3000),
    github: loadGitHub(),
    providers: inference.providers,
    providerProblems: inference.problems,
    allowPaidInference: bool('HALF_SHELL_ALLOW_PAID_INFERENCE', false),
    review: {
      maxFiles: int('HALF_SHELL_MAX_FILES', 40),
      maxPatchChars: int('HALF_SHELL_MAX_PATCH_CHARS', 12_000),
      maxPromptChars: int('HALF_SHELL_MAX_PROMPT_CHARS', 120_000),
      maxRelatedFiles: nonNegativeInt('HALF_SHELL_MAX_RELATED_FILES', 5),
      maxRelatedChars: int('HALF_SHELL_MAX_RELATED_CHARS', 6_000),
      maxRelatedLookups: nonNegativeInt('HALF_SHELL_MAX_RELATED_LOOKUPS', 30),
      searchCallers: bool('HALF_SHELL_SEARCH_CALLERS', true),
      dryRun: bool('HALF_SHELL_DRY_RUN', false),
      dataDir: env('HALF_SHELL_DATA_DIR') ?? '.half-shell',
      store: env('HALF_SHELL_STORE') === 'sqlite' ? 'sqlite' : 'file',
      databasePath:
        env('HALF_SHELL_DATABASE_PATH') ??
        `${env('HALF_SHELL_DATA_DIR') ?? '.half-shell'}/half-shell.db`,
      excludePatterns: DEFAULT_EXCLUDES,
    },
  };
}

export function isExcluded(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}
