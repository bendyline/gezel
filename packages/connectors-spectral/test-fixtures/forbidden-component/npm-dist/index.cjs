// Test fixture: asks for a built-in that opens sockets.
const net = require('node:net');
module.exports = { actions: { connect: async () => ({ data: typeof net.connect }) }, triggers: {} };
