const root = process.env.GEZEL_FAILING_TESTS_ROOT;

if (!root) {
  throw new Error('GEZEL_FAILING_TESTS_ROOT is required for the controlled scenario test run');
}

export default {
  root,
  test: {
    include: ['tests/machine.test.ts'],
    setupFiles: [],
    globalSetup: [],
  },
};
