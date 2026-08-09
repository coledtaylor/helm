import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * The rule that matters is `no-electron-in-core`, near the bottom.
 *
 * SPEC 5 calls `core/` never importing Electron "the one discipline", and M1's
 * acceptance criteria require it enforced by a rule rather than by convention -
 * because a convention is only as good as whoever is in a hurry. Three forms are
 * blocked: static import, `require()`, and dynamic `import()`. The first is what
 * anyone would write; the last two are what someone would reach for after the
 * first one failed.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/dist-app/**',
      '**/drizzle/**',
      '**/*.generated.ts'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ]
    }
  },

  // ---------------------------------------------------------------------------
  // React surfaces
  // ---------------------------------------------------------------------------
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'packages/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },

  // ---------------------------------------------------------------------------
  // The spike harness (Spike B/C). Its job is to poke at a live terminal and
  // report what came back, which means `any` at the probe boundary and control
  // characters in regexes. Held to the same rules as the app, it would be
  // rewritten for style - and CLAUDE.md is explicit that it must not be.
  // ---------------------------------------------------------------------------
  {
    files: [
      'packages/desktop/src/main/{bridge,selftest,fidelity,claudecheck}.ts',
      'packages/desktop/src/renderer/src/{probe,latency}.ts'
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      // Stripping ANSI is the whole job here, and an escape sequence starts
      // with a control character. Written as `` the pattern would be
      // unreadable to anyone checking it against a terminal spec.
      'no-control-regex': 'off'
    }
  },

  // Build scripts print what they generated; that output is the confirmation.
  {
    files: ['**/scripts/**/*.{mjs,js,ts}'],
    rules: { 'no-console': 'off' }
  },

  {
    files: ['packages/desktop/src/main/**/*.ts'],
    rules: {
      // The main process is a CLI as much as a window: the spike modes print
      // their verdict to stdout and CI reads it.
      'no-console': 'off'
    }
  },

  // ---------------------------------------------------------------------------
  // The one discipline: `packages/core` is headless.
  // ---------------------------------------------------------------------------
  {
    name: 'no-electron-in-core',
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/**', '@electron/**', 'electron-*'],
              message:
                'packages/core is headless (SPEC 5). Electron belongs in packages/desktop - pass what core needs in as an argument instead.'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='require'] > Literal[value=/^(electron|@electron\\u002F)/]",
          message:
            'packages/core is headless (SPEC 5). Electron belongs in packages/desktop - pass what core needs in as an argument instead.'
        },
        {
          selector: "ImportExpression > Literal[value=/^(electron|@electron\\u002F)/]",
          message:
            'packages/core is headless (SPEC 5). Electron belongs in packages/desktop - pass what core needs in as an argument instead.'
        }
      ]
    }
  },

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-console': 'off'
    }
  },

  {
    files: ['**/*.mjs', '**/*.js'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
)
