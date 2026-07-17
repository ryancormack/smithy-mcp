import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typedFiles = [
  'packages/*/src/**/*.ts',
  'packages/cdk/bin/**/*.ts',
  'packages/cdk/lib/**/*.ts'
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/cdk.out/**',
      '.pnpm-store/**',
      'semantic-review/**'
    ]
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node
    }
  },
  ...tseslint.configs.strict.map(config => ({
    ...config,
    files: ['**/*.ts']
  })),
  ...tseslint.configs.strictTypeChecked.map(config => ({
    ...config,
    files: typedFiles,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: typedFiles,
    rules: {
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true }
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
    }
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-dynamic-delete': 'off'
    }
  }
);
