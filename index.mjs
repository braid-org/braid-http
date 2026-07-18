// This is the root file for es modules:
//
//    import {fetch, http_server} from 'braid-http'
//
// This file combines the client and server files into one file.

import braid_client from './braid-http-client.js'
import braid_server from './braid-http-server.js'

var fetch = braid_client.fetch,
    braidify = braid_server.braidify,
    http_bus = braid_client.http_bus,
    free_cors = braid_server.free_cors,
    reliable_update_channel = braid_client.reliable_update_channel,

    // Deprecated names, kept working for backwards-compatibility:
    http_server = braid_server.braidify,  // Deprecated: renamed to braidify
    http_client = braid_client.http       // Deprecated: use fetch instead

export {
    fetch, braidify, http_bus, free_cors, reliable_update_channel,
    http_server, http_client
}
export default {
    fetch, braidify, http_bus, free_cors, reliable_update_channel,
    http_server, http_client
}
