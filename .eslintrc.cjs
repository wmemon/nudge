'use strict'

/**
 * ESLint config — enforces architecture boundaries via eslint-plugin-boundaries
 *
 * Element types:
 *   app                → src/app/**
 *   worker             → src/worker/**
 *   module-domain      → src/modules/<name>/domain/**       (capture: moduleName)
 *   module-application → src/modules/<name>/application/**  (capture: moduleName)
 *   module-adapters    → src/modules/<name>/adapters/**     (capture: moduleName)
 *   module-data-access → src/modules/<name>/data-access/**  (capture: moduleName)
 *   module-public      → src/modules/<name>/index.ts        (capture: moduleName)
 *   platform-llm       → src/platform/llm-router/**         (MBC-002 boundary)
 *   platform-db        → src/platform/db-supabase/**        (MBC-003 boundary)
 *   platform           → src/platform/**                    (all other platform)
 *   shared             → src/shared/**
 *
 * Enforced rules (see plan §6 + ADR-001):
 *   app / worker        → module-public, platform, shared only
 *   module-public       → own module layers only (same moduleName capture)
 *   module-adapters     → module-application (same module), platform, shared
 *   module-application  → module-domain (same module), platform, shared
 *   module-domain       → shared only (no platform, no vendor SDKs)
 *   module-data-access  → own domain (same module), platform-db, shared
 *   platform-llm        → shared (isolated — only file allowed to import openai/anthropic)
 *   platform-db         → shared (isolated — only file allowed to import supabase-js)
 *   platform            → shared, platform (cross-platform ok)
 *   shared              → shared only
 *
 *   MBC-002: openai only inside src/platform/llm-router/ (used as OpenRouter client; @anthropic-ai/sdk not used)
 *   MBC-003: @supabase/supabase-js only inside src/platform/db-supabase/
 */

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.eslint.json',
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import', 'boundaries'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  settings: {
    'boundaries/elements': [
      { type: 'app',                pattern: 'src/app/**' },
      { type: 'worker',             pattern: 'src/worker/**' },
      { type: 'module-domain',      pattern: 'src/modules/*/domain/**',      capture: ['moduleName'] },
      { type: 'module-application', pattern: 'src/modules/*/application/**', capture: ['moduleName'] },
      { type: 'module-adapters',    pattern: 'src/modules/*/adapters/**',    capture: ['moduleName'] },
      { type: 'module-data-access', pattern: 'src/modules/*/data-access/**', capture: ['moduleName'] },
      { type: 'module-public',      pattern: 'src/modules/*/index.ts',       capture: ['moduleName'] },
      { type: 'platform-llm',       pattern: 'src/platform/llm-router/**' },
      { type: 'platform-db',        pattern: 'src/platform/db-supabase/**' },
      { type: 'platform',           pattern: 'src/platform/**' },
      { type: 'shared',             pattern: 'src/shared/**' },
    ],
  },
  rules: {
    // ── Architecture boundary rules ──────────────────────────────────────
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          // Entrypoints: may only consume module public APIs, platform, shared
          {
            from: ['app', 'worker'],
            allow: ['module-public', 'platform', 'platform-llm', 'platform-db', 'shared'],
          },

          // Module public API (index.ts): owns all its own layers + platform + shared
          // Capture matching ensures cross-module data-access is blocked at layer level
          {
            from: [['module-public', { moduleName: '${moduleName}' }]],
            allow: [
              ['module-application',  { moduleName: '${moduleName}' }],
              ['module-adapters',     { moduleName: '${moduleName}' }],
              ['module-data-access',  { moduleName: '${moduleName}' }],
              ['module-domain',       { moduleName: '${moduleName}' }],
              'platform', 'platform-llm', 'platform-db', 'shared',
            ],
          },

          // Adapters → application (same module), platform, shared
          {
            from: [['module-adapters', { moduleName: '${moduleName}' }]],
            allow: [
              ['module-application', { moduleName: '${moduleName}' }],
              'platform', 'platform-llm', 'platform-db', 'shared',
            ],
          },

          // Application → domain (same module), platform (via ports), shared
          {
            from: [['module-application', { moduleName: '${moduleName}' }]],
            allow: [
              ['module-domain', { moduleName: '${moduleName}' }],
              'platform', 'platform-llm', 'platform-db', 'shared',
            ],
          },

          // Domain: shared helpers only — no platform, no data-access, no vendor SDKs
          {
            from: ['module-domain'],
            allow: ['shared'],
          },

          // Data-access: own domain + db platform + shared
          {
            from: [['module-data-access', { moduleName: '${moduleName}' }]],
            allow: [
              ['module-domain', { moduleName: '${moduleName}' }],
              'platform-db', 'shared',
            ],
          },

          // Platform-llm: shared + platform (openai imports live here — MBC-002; used as OpenRouter client)
          // Needs platform/config for OPENROUTER_* vars and platform/config/index.js import
          { from: ['platform-llm'], allow: ['shared', 'platform', 'platform-db'] },

          // Platform-db: shared only (supabase-js imports live here — MBC-003)
          { from: ['platform-db'], allow: ['shared'] },

          // General platform: shared + cross-platform ok
          { from: ['platform'], allow: ['shared', 'platform', 'platform-llm', 'platform-db'] },

          // Shared: fully self-contained
          { from: ['shared'], allow: ['shared'] },
        ],
      },
    ],

    // ── Vendor SDK isolation (MBC-002, MBC-003) ──────────────────────────
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['openai', 'openai/*'],
            message: 'MBC-002: openai may only be imported inside src/platform/llm-router/ (used as OpenRouter client)',
          },
          {
            group: ['@supabase/supabase-js', '@supabase/supabase-js/*'],
            message: 'MBC-003: @supabase/supabase-js may only be imported inside src/platform/db-supabase/',
          },
        ],
      },
    ],

    // ── TypeScript rules ─────────────────────────────────────────────────
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-floating-promises': 'error',
  },

  overrides: [
    // Allow vendor SDK imports inside their designated platform directories
    {
      files: ['src/platform/llm-router/**'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      files: ['src/platform/db-supabase/**'],
      rules: { 'no-restricted-imports': 'off' },
    },
    // Relax boundaries + unused-vars in tests
    {
      files: ['tests/**', '**/*.test.ts', '**/*.spec.ts'],
      rules: {
        'boundaries/element-types': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
}
