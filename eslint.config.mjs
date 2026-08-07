import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // `build/` holds the staged MCPB bundle: a copy of `dist/` plus vendored dependencies.
  // `docs/` is the published static site: browser JavaScript outside the TypeScript
  // program, plus files this repository's generator owns end to end.
  {
    ignores: ['dist/**', 'build/**', 'docs/**', 'node_modules/**', 'coverage/**', 'src/generated/operations.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The `.mjs` config and build scripts sit outside tsconfig's `include`.
        projectService: { allowDefaultProject: ['eslint.config.mjs', 'scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // The generator and build scripts are Node CLI tools; printing is their job.
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: { 'no-console': 'off', 'no-undef': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  prettier,
);
