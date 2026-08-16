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
  // The other discipline: one component paints the modal overlay.
  //
  // Four dialogs each carried their own copy of `fixed inset-0 z-50 grid
  // place-items-center bg-black/60 p-6`, and nothing in the app knew a dialog
  // was open. That matters beyond tidiness: the browser pane is a
  // `WebContentsView`, a native view paints above all renderer DOM, and it has
  // to hide whenever a dialog is up. With four backdrops there is nothing to
  // subscribe to and every dialog written afterwards has to *remember* - which
  // produces a bug that only appears when a browser tab happens to be open.
  //
  // So it is a rule the linter holds instead of a rule a person holds, for the
  // same reason `no-electron-in-core` above is one.
  //
  // Matched as two whole words in one class string rather than as the literal
  // pair, so `inset-0 fixed` and `fixed z-50 inset-0` are caught too. Both
  // string literals and template chunks are checked - the second is what
  // someone reaches for once the first has failed. `absolute inset-0` is
  // untouched and common: it is a pane filling its own box, not an overlay.
  // ---------------------------------------------------------------------------
  {
    name: 'no-raw-overlay',
    files: ['packages/ui/**/*.{ts,tsx}', 'packages/desktop/src/renderer/**/*.{ts,tsx}'],
    // The one place that may say it. Exempting the component by name is the
    // whole mechanism: the boundary is only worth having if crossing it has to
    // be deliberate enough to show up in a diff of this file.
    ignores: ['packages/ui/src/components/Overlay.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/(^|\\s)fixed(\\s|$)/][value=/(^|\\s)inset-0(\\s|$)/]",
          message:
            'A modal overlay is `Overlay` (packages/ui/src/components/Overlay.tsx), which owns the scrim, the centring, the z-index, the island shadow, Escape - and the state that says a dialog is up. A raw `fixed inset-0` is a fifth copy of that decision and a backdrop nothing can subscribe to.'
        },
        {
          selector:
            "TemplateElement[value.raw=/(^|\\s)fixed(\\s|$)/][value.raw=/(^|\\s)inset-0(\\s|$)/]",
          message:
            'A modal overlay is `Overlay` (packages/ui/src/components/Overlay.tsx), which owns the scrim, the centring, the z-index, the island shadow, Escape - and the state that says a dialog is up. A raw `fixed inset-0` is a fifth copy of that decision and a backdrop nothing can subscribe to.'
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
