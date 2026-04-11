// This is the root file for es modules:
//
//    import {fetch, http} from 'braid-http'
//
// This file combines the client and server files into one file.

import braid_client from './braid-http-client.js'
import braid_server from './braid-http-server.js'

var fetch = braid_client.fetch,
    reliable_update_channel = braid_client.reliable_update_channel,
    http_client = braid_client.http,
    http_server = braid_server.braidify,
    free_cors = braid_server.free_cors

export { fetch, reliable_update_channel, http_client, http_server, free_cors }
export default { fetch, reliable_update_channel, http_client, http_server, free_cors }
