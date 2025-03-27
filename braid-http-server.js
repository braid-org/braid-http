var assert = require('assert')

// Writes patches in pseudoheader format.
//
//   The `patches` argument can be:
//     - Array of patches
//     - A single patch
//
//   Multiple patches are generated like:
//
//       Patches: n
//
//       content-length: 21
//       content-range: json .range
//
//       {"some": "json object"}
//
//       content-length: x
//       ...
//
//   A single patch is generated like:
//
//       content-length: 21
//       content-range: json .range
//
//       {"some": "json object"}
//
function write_patches (res, patches) {
    // `patches` must be a patch object or an array of patch objects
    //  - Object:  {unit, range, content}
    //  - Array:  [{unit, range, content}, ...]

    if (typeof patches !== 'object')
        console.error('We got bad patches!', {patches})

    assert(patches)
    assert(typeof patches === 'object')  // An array is also an object

    // An array of one patch behaves like a single patch
    if (Array.isArray(patches)) {

        // Add `Patches: N` header if array
        res.write(`Patches: ${patches.length}\r\n\r\n`)
    } else
        // Else, we'll out put a single patch
        patches = [patches]

    // Generate each patch
    patches.forEach((patch, i) => {
        assert(typeof patch.unit    === 'string')
        assert(typeof patch.range   === 'string')

        if (i > 0)
            res.write('\r\n\r\n')

        // Use a slick object_destructuring line to extract the extra_headers
        var {unit, range, content, ...extra_headers} = patch

        // Binarize the patch content
        var binary_content = (typeof patch.content === 'string'
                              ? new TextEncoder().encode(patch.content)
                              : patch.content)

        // Write the basic headers
        res.write('Content-Length: ' + get_binary_length(binary_content) + '\r\n'
                  + 'Content-Range: ' + patch.unit + ' ' + patch.range + '\r\n')

        // Write the extra headers:
        for (var header in extra_headers)
            res.write(`${header}: ${extra_headers[header]}\r\n`)

        res.write('\r\n')

        // Write the patch content
        write_binary(res, binary_content)
    })
}


// Deprecated method for legacy support
function parse_patches (req, cb) {
    parse_update(req, update => {
        if (update.body != null) {
            // Return body as an "everything" patch
            let patch = {unit: 'everything', range: '', content: update.body}
            Object.defineProperty(patch, 'content_text', {
                get: () => new TextDecoder('utf-8').decode(patch.content)
            })
            cb([patch])
        } else
            cb(update.patches)
    })
}

// This function reads an update (either a set of patches, or a body) from a
// ReadableStream and then fires a callback when finished.
function parse_update (req, cb) {
    var num_patches = req.headers.patches

    if (!num_patches && !req.headers['content-range']) {
        var buffer = []
        req.on('data', chunk => buffer.push(chunk))
        req.on('end', () => {
            let body = new Uint8Array(Buffer.concat(buffer))
            let update = { body, patches: undefined }
            Object.defineProperty(update, 'body_text', {
                get: () => new TextDecoder('utf-8').decode(update.body)
            })
            cb(update)
        })
    }

    // Parse a single patch, lacking Patches: N
    else if (num_patches === undefined && req.headers['content-range']) {
        // We only support range patches right now, so there must be a
        // Content-Range header.
        assert(req.headers['content-range'], 'No patches to parse: need `Patches: N` or `Content-Range:` header in ' + JSON.stringify(req.headers))

        // Parse the Content-Range header
        // Content-range is of the form '<unit> <range>' e.g. 'json .index'
        var [unit, range] = parse_content_range(req.headers['content-range'])

        // The contents of the patch is in the request body
        var buffer = []
        // Read the body one chunk at a time
        req.on('data', chunk => buffer.push(chunk))
        // Then return it
        req.on('end', () => {
            let patch = {unit, range, content: new Uint8Array(Buffer.concat(buffer))}
            Object.defineProperty(patch, 'content_text', {
                get: () => new TextDecoder('utf-8').decode(patch.content)
            })
            cb({ patches: [patch], body: undefined })
        })
    }

    // Parse multiple patches within a Patches: N block
    else {
        num_patches = parseInt(num_patches)
        let patches = []
        let buffer = []

        // We check to send send patches each time we parse one.  But if there
        // are zero to parse, we will never check to send them.
        if (num_patches === 0)
            return cb({ patches: [], body: undefined })

        req.on('data', function parse (chunk) {

            // Merge the latest chunk into our buffer
            for (let x of chunk) buffer.push(x)

            while (patches.length < num_patches) {
                // Find the start of the headers
                let s = 0;
                while (buffer[s] === 13 || buffer[s] === 10) s++
                if (s === buffer.length) return {result: 'waiting'}

                // Look for the double-newline at the end of the headers.
                let e = s;
                while (++e) {
                    if (e > buffer.length) return {result: 'waiting'}
                    if (buffer[e - 1] === 10 && (buffer[e - 2] === 10 || (buffer[e - 2] === 13 && buffer[e - 3] === 10))) break
                }

                // Extract the header string
                let headers_source = buffer.slice(s, e).map(x => String.fromCharCode(x)).join('')

                // Now let's parse those headers.
                var headers = require('parse-headers')(headers_source)

                // We require `content-length` to declare the length of the patch.
                if (!('content-length' in headers)) {
                    // Print a nice error if it's missing
                    console.error('No content-length in', JSON.stringify(headers),
                                  'from', new TextDecoder().decode(new Uint8Array(buffer)), {buffer})
                    process.exit(1)
                }

                var body_length = parseInt(headers['content-length'])

                // Give up if we don't have the full patch yet.
                if (buffer.length - e < body_length)
                    return

                // XX Todo: support custom patch types beyond content-range.

                // Content-range is of the form '<unit> <range>' e.g. 'json .index'
                var [unit, range] = parse_content_range(headers['content-range'])
                var patch_content = new Uint8Array(buffer.slice(e, e + body_length))

                // We've got our patch!
                let patch = {unit, range, content: patch_content}
                Object.defineProperty(patch, 'content_text', {
                    get: () => new TextDecoder('utf-8').decode(patch.content)
                })
                patches.push(patch)

                buffer = buffer.slice(e + body_length)
            }

            // We got all the patches!  Pause the stream and tell the callback!
            req.pause()
            cb({ patches, body: undefined })
        })
        req.on('end', () => {
            // If the stream ends before we get everything, then return what we
            // did receive
            console.error('Request stream ended!')
            if (patches.length !== num_patches)
                console.error(`Got an incomplete PUT: ${patches.length}/${num_patches} patches were received`)
        })
    }
}

function parse_content_range (range_string) {
    var match = range_string.match(/(\S+)( (.*))?/)
    if (!match) throw 'Cannot parse Content-Range in ' + string
    var [unit, range] = [match[1], match[3] || '']
    return [unit, range]
}

function braidify (req, res, next) {
    if (typeof req === 'function') {
        var handler = req
        return (req, res, next) =>
            braidify(req, res, () => handler(req, res, next))
    }

    // console.log('\n## Braidifying', req.method, req.url, req.headers.peer)

    // First, declare that we support Patches and JSON ranges.
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT')
    res.setHeader('Range-Request-Allow-Units', 'json')

    // Extract braid info from headers
    var version = ('version' in req.headers) && JSON.parse('['+req.headers.version+']'),
        parents = ('parents' in req.headers) && JSON.parse('['+req.headers.parents+']'),
        peer = req.headers['peer']

    // Parse the subscribe header
    var subscribe = req.headers.subscribe
    if (subscribe === 'true')
        subscribe = true

    // Define convenience variables
    req.version   = version
    req.parents   = parents
    req.subscribe = subscribe

    // Multiplexer stuff
    var multiplex_version = '1.0'
    if ((braidify.enable_multiplex ?? true) &&
        (req.method === 'MULTIPLEX' || req.url.startsWith('/.well-known/multiplexer/'))) {

        // free the cors
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "*")
        res.setHeader("Access-Control-Allow-Headers", "*")
        res.setHeader("Access-Control-Expose-Headers", "*")
        if (req.method === 'OPTIONS') return res.end()

        // check the multiplexing protocol version
        if (req.headers['multiplex-version'] !== multiplex_version) {
            res.writeHead(400, 'Bad Multiplexer Version')
            return res.end()
        }

        // let the caller know we're handling things
        req.is_multiplexer = res.is_multiplexer = true

        // parse the multiplexer id and request id from the url
        var [multiplexer, request] = req.url.split('/').slice(req.method === 'MULTIPLEX' ? 1 : 3)

        // if there's just a multiplexer, then we're creating a multiplexer..
        if (!request) {
            // maintain a Map of all the multiplexers
            if (!braidify.multiplexers) braidify.multiplexers = new Map()

            // if this multiplexer already exists, respond with an error
            if (braidify.multiplexers.has(multiplexer)) {
                res.writeHead(409, 'Conflict', {'Content-Type': 'application/json'})
                return res.end(JSON.stringify({
                    error: 'Multiplexer already exists',
                    details: `Cannot create duplicate multiplexer with ID '${multiplexer}'`
                }))
            }

            braidify.multiplexers.set(multiplexer, {requests: new Map(), res})

            // when the response closes,
            // let everyone know the multiplexer has died
            res.on('close', () => {
                for (var f of braidify.multiplexers.get(multiplexer).requests.values()) f()
                braidify.multiplexers.delete(multiplexer)
            })

            // keep the connection open,
            // so people can send multiplexed data to it
            res.writeHead(200, 'OK', {
                'Multiplex-Version': multiplex_version,
                'Incremental': '?1',
                'Cache-Control': 'no-store',
                'X-Accel-Buffering': 'no',
                ...req.httpVersion !== '2.0' && {'Connection': 'keep-alive'}
            })

            // but write something.. won't interfere with multiplexer,
            // and helps flush the headers
            return res.write(`\r\n`)
        } else {
            // in this case, we're closing the given request

            // if the multiplexer doesn't exist, send an error
            var m = braidify.multiplexers?.get(multiplexer)
            if (!m) {
                res.writeHead(404, 'Multiplexer no exist', {'Bad-Multiplexer': multiplexer})
                return res.end(`multiplexer ${multiplexer} does not exist`)
            }

            // if the request doesn't exist, send an error
            let s = m.requests.get(request)
            if (!s) {
                res.writeHead(404, 'Multiplexed request not found', {'Bad-Request': request})
                return res.end(`request ${request} does not exist`)
            }

            // remove this request, and notify it
            m.requests.delete(request)
            s()

            // let the requester know we succeeded
            res.writeHead(200, 'OK', { 'Multiplex-Version': multiplex_version })
            return res.end(``)
        }
    }

    // a Multiplex-Through header means the user wants to send the
    // results of this request to the provided multiplexer,
    // tagged with the given request id
    if ((braidify.enable_multiplex ?? true) &&
        req.headers['multiplex-through'] &&
        req.headers['multiplex-version'] === multiplex_version) {

        // parse the multiplexer id and request id from the header
        var [multiplexer, request] = req.headers['multiplex-through'].split('/').slice(3)

        // find the multiplexer object (contains a response object)
        var m = braidify.multiplexers?.get(multiplexer)
        if (!m) {
            req.is_multiplexer = res.is_multiplexer = true
            res.writeHead(424, 'Multiplexer no exist', {'Bad-Multiplexer': multiplexer})
            return res.end(`multiplexer ${multiplexer} does not exist`)
        }

        // if this request-id already exists, respond with an error
        if (m.requests.has(request)) {
            req.is_multiplexer = res.is_multiplexer = true
            res.writeHead(409, 'Conflict', {'Content-Type': 'application/json'})
            return res.end(JSON.stringify({
                error: 'Request already multiplexed',
                details: `Cannot multiplex request with duplicate ID '`
                         + request + `' for multiplexer '` + multiplexer + `'`
            }))
        }

        m.res.write(`start response ${request}\r\n`)

        // let the requester know we've multiplexed their response
        var og_stream = res.stream
        var og_socket = res.socket
        var og_res_end = () => {
            og_res_end = null
            if (!braidify.cors_headers) braidify.cors_headers = new Set([
                'Access-Control-Allow-Origin',
                'Access-Control-Allow-Methods',
                'Access-Control-Allow-Headers',
                'Access-Control-Allow-Credentials',
                'Access-Control-Expose-Headers',
                'Access-Control-Max-Age'
            ].map(x => x.toLowerCase()))

            // copy any CORS headers from the user
            var cors_headers = Object.entries(res2.getHeaders()).
                filter(x => braidify.cors_headers.has(x[0]))

            if (og_stream) {
                og_stream.respond({
                    ':status': 293,
                    'Multiplex-Through': req.headers['multiplex-through'],
                    'Multiplex-Version': multiplex_version,
                    'Cache-Control': 'no-store',
                    ...Object.fromEntries(cors_headers)
                })
                og_stream.write('Ok.')
                og_stream.end()
            } else {
                og_socket.write('HTTP/1.1 293 Responded via multiplexer\r\n')
                og_socket.write(`Multiplex-Through: ${req.headers['multiplex-through']}\r\n`)
                og_socket.write(`Multiplex-Version: ${multiplex_version}\r\n`)
                og_socket.write(`Cache-Control: no-store\r\n`)
                cors_headers.forEach(([key, value]) =>
                    og_socket.write(`${key}: ${value}\r\n`))
                og_socket.write('\r\n')
                og_socket.write('Ok.')
                og_socket.end()
            }
        }

        // and now set things up so that future use of the
        // response object forwards stuff into the multiplexer

        // first we create a kind of fake socket
        class MultiplexedWritable extends require('stream').Writable {
            constructor(multiplexer, request) {
                super()
                this.multiplexer = multiplexer
                this.request = request
            }

            _write(chunk, encoding, callback) {
                og_res_end?.()

                try {
                    var len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding)
                    this.multiplexer.res.write(`${len} bytes for response ${this.request}\r\n`)
                    this.multiplexer.res.write(chunk, encoding, callback)
                } catch (e) {
                    callback(e)
                }
            }
        }
        var mw = new MultiplexedWritable(m, request)

        // then we create a fake server response,
        // that pipes data to our fake socket
        var res2 = new (require('http').ServerResponse)({})
        res2.useChunkedEncodingByDefault = false
        res2.assignSocket(mw)

        // register a handler for when the multiplexer closes,
        // to close our fake response
        m.requests.set(request, () => {
            og_res_end?.()
            res2.destroy()
        })

        // when our fake response is done,
        // we want to send a special message to the multiplexer saying so
        res2.on('finish', () => m.res.write(`close response ${request}\r\n`))

        // copy over any headers which have already been set on res to res2
        for (let x of Object.entries(res.getHeaders()))
            res2.setHeader(...x)

        // we want access to "res" to be forwarded to our fake "res2",
        // so that it goes into the multiplexer
        function* get_props(obj) {
            do {
                for (var x of Object.getOwnPropertyNames(obj)) yield x
            } while (obj = Object.getPrototypeOf(obj))
        }
        for (let key of get_props(res)) {
            // skip keys that break stuff for some reason
            if (
                // just touching these seems to cause issues
                key === '_events' || key === 'emit'

                // empirically, on an http1 server,
                // this causes res2 to close prematurely
                || key === 'destroyed'

                // adding these lines gets rid of some deprecation warnings.. keep?
                || key === '_headers'
                || key === '_headerNames') continue

            if (res2[key] === undefined) continue
            var value = res[key]
            if (typeof value === 'function') {
                res[key] = res2[key].bind(res2)
            } else {
                +((key) => {
                    Object.defineProperty(res, key, {
                        get: () => res2[key],
                        set: x => res2[key] = x
                    })
                })(key)
            }
        }

        // this is provided so code can know if the response has been multiplexed
        res.multiplexer = m.res
    }

    // Add the braidly request/response helper methods
    res.sendUpdate = (stuff) => send_update(res, stuff, req.url, peer)
    res.sendVersion = res.sendUpdate
    req.parseUpdate = () => new Promise(
        (done, err) => parse_update(req, (update) => done(update))
    )
    req.patches = () => new Promise(
        (done, err) => parse_patches(req, (patches) => done(patches))
    )
    req.patchesJSON = () => new Promise(
        (done, err) => parse_patches(
            req,
            (patches) => done(patches.map(
                p => ({...p, content: JSON.parse(p.content_text)})
            ))
        )
    )
    req.startSubscription = res.startSubscription =
        function startSubscription (args = {}) {
            // console.log('Starting subscription!')
            // console.log('Timeouts are:',
            //             req.socket.server.timeout,
            //             req.socket.server.keepAliveTimeout)

            res.isSubscription = true

            // Let's disable the timeouts (if it exists)
            if (req.socket.server)
                req.socket.server.timeout = 0.0

            // We have a subscription!
            res.statusCode = 209
            res.setHeader("subscribe", req.headers.subscribe ?? 'true')
            res.setHeader('cache-control', 'no-cache, no-transform, no-store')


            // Note: I used to explicitly disable transfer-encoding chunked
            // here by setting the header to empty string.  This is the only
            // way I know to disable it in nodejs.  We don't need chunked
            // encoding in subscriptions, because chunked encoding is used to
            // signal the end of a response, and subscriptions don't end.  I
            // disabled them to make responses cleaner.  However, it turns out
            // the Caddy proxy throws an error if it receives a response with
            // transfer-encoding: set to the empty string.  So I'm disabling
            // it now.

            // if (req.httpVersionMajor == 1) {
            //     // Explicitly disable transfer-encoding chunked for http 1
            //     res.setHeader('transfer-encoding', '')
            // }

            // Tell nginx not to buffer the subscription
            res.setHeader('X-Accel-Buffering', 'no')

            var connected = true
            function disconnected (x) {
                if (!connected) return
                connected = false
                // console.log(`Connection closed on ${req.url} from`, x, 'event')

                // Now call the callback
                if (args.onClose)
                    args.onClose()
            }

            res.on('close',   x => disconnected('close'))
            res.on('finish',  x => disconnected('finish'))
            req.on('abort',   x => disconnected('abort'))

            // Heartbeats
            if (req.headers['heartbeats']) {
                let heartbeats = parseFloat(req.headers['heartbeats'])
                if (isFinite(heartbeats)) {
                    res.setHeader('heartbeats', req.headers['heartbeats'])
                    let closed
                    res.on('close', () => closed = true)
                    loop()
                    function loop() {
                        if (res.writableEnded || closed) return
                        res.write("\r\n")
                        setTimeout(loop, 1000 * heartbeats)
                    }
                }
            }
        }

    // Check the Useragent to work around Firefox bugs
    if (req.headers['user-agent']
        && typeof req.headers['user-agent'] === 'string'
        && req.headers['user-agent'].toLowerCase().indexOf('firefox') > -1)
        res.is_firefox = true

    next && next()
}

async function send_update(res, data, url, peer) {
    var {version, parents, patches, patch, body, status} = data

    if (status) {
        assert(typeof status === 'number', 'sendUpdate: status must be a number')
        assert(status > 100 && status < 600, 'sendUpdate: status must be a number between 100 and 600')
    }
    else
        status = 200

    function set_header (key, val) {
        if (res.isSubscription)
            res.write(`${key}: ${val}\r\n`)
        else
            res.setHeader(key, val)
    }
    function write_body (body) {
        if (res.isSubscription) res.write('\r\n')
        write_binary(res, body)
    }

    // console.log('Sending Update', {url, peer, data, subscription: res.isSubscription})

    // Validate the body and patches
    assert(!(patch && patches),
           'sendUpdate: cannot have both `update.patch` and `update.patches` set')
    if (patch)
        patches = [patch]
    assert(!(body && patches),
           'sendUpdate: cannot have both `update.body` and `update.patch(es)')
    assert(!patches || Array.isArray(patches),
           'sendUpdate: `patches` provided is not array')

    // Validate body format
    if (body !== undefined) {
        assert(typeof body === 'string' || get_binary_length(body) != null)
        if (typeof Blob !== 'undefined' && body instanceof Blob) body = await body.arrayBuffer()
    }

    // Validate patches format
    if (patches !== undefined) {
        // Now `patches` will be an array of patches
        //
        // This distinction is used in write_patches() to determine whether
        // to inline a single patch in the update body vs. writing out a
        // Patches: N block.
        assert(typeof patches === 'object')
        for (let p of Array.isArray(patches) ? patches : [patch]) {
            assert('unit' in p)
            assert('range' in p)
            assert('content' in p)
            assert(typeof p.content === 'string'
                   || get_binary_length(p.content) != null)
            if (typeof Blob !== 'undefined' && p.content instanceof Blob)
                p.content = await p.content.arrayBuffer()
        }
    }

    // To send a response without a body, we just send an empty body
    if (!patches && !body)
        body = ''

    var reason =
        status === 200 ? 'OK'
        : 404 ? 'Not Found'
        : 'Unknown'
    if (res.isSubscription) res.write(`HTTP ${status} ${reason}\r\n`)

    // Write the headers or virtual headers
    for (var [header, value] of Object.entries(data)) {
        header = header.toLowerCase()

        // A header set to undefined acts like it wasn't set
        if (value === undefined)
            continue

        // Status headers are set in the status line (above)
        if (header === 'status')
            continue

        // Version and Parents get output in the Structured Headers format,
        // so we convert `value` from array to comma-separated strings.
        if (header === 'version') {
            header = 'Version'               // Capitalize for prettiness
            value = value.map(JSON.stringify).map(ascii_ify).join(", ")
        } else if (header === 'parents') {
            header = 'Parents'               // Capitalize for prettiness
            value = value.map(JSON.stringify).map(ascii_ify).join(", ")
        }

        // We don't output patches or body yet
        else if (header === 'patches' || header === 'body' || header === 'patch')
            continue

        set_header(header, value)
    }

    // Write the patches or body
    if (body || body === '') {
        let binary = typeof body === 'string' ? new TextEncoder().encode(body) : body,
            length = get_binary_length(binary)
        assert(length !== undefined && length !== 'undefined')
        set_header('Content-Length', length)
        write_body(binary)
    } else
        write_patches(res, patches)

    // Add a newline to prepare for the next version
    // See also https://github.com/braid-org/braid-spec/issues/73
    if (res.isSubscription) {
        var extra_newlines = 1
        if (res.is_firefox)
            // Work around Firefox network buffering bug
            // See https://github.com/braid-org/braidjs/issues/15
            extra_newlines = 240

        for (var i = 0; i < 1 + extra_newlines; i++)
            res.write("\r\n")
    }
}

function get_binary_length(x) {
    return  x instanceof ArrayBuffer ? x.byteLength :
            x instanceof Uint8Array ? x.length :
            typeof Blob !== 'undefined' && x instanceof Blob ? x.size :
            x instanceof Buffer ? x.length : undefined
}

function write_binary(res, body) {
    if (body instanceof ArrayBuffer) body = new Uint8Array(body)
    res.write(body)
}

function ascii_ify(s) {
    return s.replace(/[^\x20-\x7E]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

module.exports = braidify
