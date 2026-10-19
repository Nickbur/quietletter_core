// ESLint flat config — Node + TypeScript server (type-aware). Formatting is Prettier's job:
// eslint-config-prettier switches off every stylistic rule.
import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig(
    globalIgnores(['**/dist/', '**/coverage/', 'drizzle/']),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['**/*.{ts,mts,cts}'],
        languageOptions: {
            parserOptions: {
                // Root *.config.ts files sit outside the build tsconfig; tests/ has its own tsconfig.
                projectService: { allowDefaultProject: ['*.config.ts'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
        },
    },
    {
        languageOptions: { globals: globals.node },
        rules: {
            // Logs go through the app logger; console is allowed only where a disable comment says why.
            'no-console': 'error',
            // A leading underscore marks an intentionally unused binding (`_req`, `_unused`).
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                },
            ],
        },
    },
    {
        files: ['**/*.cjs'],
        languageOptions: { sourceType: 'commonjs' },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
        // Nothing focused, switched off or left as a placeholder reaches `build`: a known bug is pinned with
        // `it.fails`, not skipped (a conditional `skipIf` for a live, opt-in suite stays allowed).
        files: ['**/*.test.ts'],
        plugins: { vitest },
        rules: {
            'vitest/no-focused-tests': 'error',
            'vitest/no-disabled-tests': 'error',
            'vitest/warn-todo': 'error',
        },
    },
    prettier,
);
