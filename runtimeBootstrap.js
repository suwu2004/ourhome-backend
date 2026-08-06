'use strict';

// Render currently starts the service with `node server.js`, which bypasses the
// `node -r ...` preload flags from package.json. Loading the patches from a
// module imported by server.js makes the behavior identical for both startup
// paths. Node's module cache prevents double installation when npm start is used.
require('./modelTokenLimitPatch');
require('./thinkingTransportPatch');
