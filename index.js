// This defines the module for require('braid-http').
//
// It combines the client and server files into one module.

var client = require('./braid-http-client'),
    server = require('./braid-http-server')

module.exports = {
    fetch: client.fetch,
    braidify: server.braidify,
    http_bus: client.http_bus,
    free_cors: server.free_cors,
    reliable_update_channel: client.reliable_update_channel,

    // Deprecated:
    http_server: server.braidify,  // Deprecated: Renamed to braidify
    http_client: client.http       // Deprecated: Use fetch instead
}
