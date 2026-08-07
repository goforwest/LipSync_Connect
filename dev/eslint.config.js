import globals from 'globals';

export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-unused-vars': ['error', { args: 'none' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-return-await': 'warn',
    },
  },
];
