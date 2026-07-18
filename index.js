// This is the root file for require('braid-http').
//
// It combines the client and server files into one file.

var client = require('./braid-http-client'),
    server = require('./braid-http-server')

module.exports = {
    fetch: client.fetch,
    braidify: server.braidify,
    http_bus: client.http_bus,
    free_cors: server.free_cors,
    reliable_update_channel: client.reliable_update_channel,

    // Deprecated names, kept working for backwards-compatibility:
    http_server: server.braidify,  // Deprecated: renamed to braidify
    http_client: client.http       // Deprecated: use fetch instead
}
