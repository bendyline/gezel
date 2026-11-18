// Test fixture: asks for a package that is not part of it.
const lodash = require('lodash');
module.exports = {
  actions: { chunk: async () => ({ data: lodash.chunk([1, 2], 1) }) },
  triggers: {},
};
