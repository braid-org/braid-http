var assert = require('assert')

// Writes patches in pseudoheader format.
//
//   If using_patches_n, we generate patches like:
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
//   Else, we have a single patch, and generate it like:
//
//       content-length: 21
//       content-range: json .range
//
//       {"some": "json object"}
//
function write_patches (res, patches, using_patches_n) {
    // `patches` must be an array of patch objects
    //  - Array:  [{unit, range, content}, ...]

    assert(patches)
    assert(typeof patches === 'object' && Array.isArray(patches))

    if (using_patches_n) {
        // Add `Patches: N` and `Content-Type: application/http-patches' if array
        res.write(`Content-Type: application/http-patches; count=${patches.length}\r\n`)
        res.write(`Patches: ${patches.length}\r\n\r\n`)
    }
    else
        // Else, we'll output a single patch
        assert(patches.length === 1)

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
//
// If req.already_buffered_body is set (Buffer, Uint8Array, or string), it
// will be used instead of reading from the request stream. This supports
// HTTP frameworks (like Fastify, Express with body-parser) that consume the
// request body before the handler runs.
function parse_update (req, cb) {
    if (req.already_buffered_body != null)
        parse_update_from_bytes(new Uint8Array(req.already_buffered_body), req.headers, cb)
    else {
        var chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () =>
            parse_update_from_bytes(new Uint8Array(Buffer.concat(chunks)), req.headers, cb))
    }
}

function num_patches_in (headers) {
    // It's in Patches: N
    if (headers.patches != null)  // != null catches undefined and null
        return headers.patches

    // Or Content-Type: application/http-patches; count=N
    var m = headers['content-type']?.match(/\/http-patches\s*;.*\bcount\s*=\s*(\d+)/i)
    return m ? parseInt(m[1]) : undefined
}

// Parse a complete body buffer into an update (body snapshot or patches).
function parse_update_from_bytes (bytes, headers, cb) {
    var num_patches = num_patches_in(headers)

    // Full body snapshot (no patches, no content-range)
    if (!num_patches && !headers['content-range']) {
        let update = { body: bytes, patches: undefined }
        Object.defineProperty(update, 'body_text', {
            get: () => new TextDecoder('utf-8').decode(update.body)
        })
        return cb(update)
    }

    // Parse a single patch, lacking Patches: N
    // We only support range patches right now, so there must be a
    // Content-Range header.
    if (num_patches == null && headers['content-range']) {
        assert(headers['content-range'], 'No patches to parse: need `Patches: N` or `Content-Range:` header in ' + JSON.stringify(headers))

        // Parse the Content-Range header
        // Content-range is of the form '<unit> <range>' e.g. 'json .index'
        var [unit, range] = parse_content_range(headers['content-range'])
        let patch = {unit, range, content: bytes}
        Object.defineProperty(patch, 'content_text', {
            get: () => new TextDecoder('utf-8').decode(patch.content)
        })
        return cb({ patches: [patch], body: undefined })
    }

    // Parse multiple patches within a Patches: N block
    num_patches = parseInt(num_patches)

    // We check to send patches each time we parse one.  But if there
    // are zero to parse, we will never check to send them.
    if (num_patches === 0)
        return cb({ patches: [], body: undefined })

    var patches = []
    var buffer = Array.from(bytes)

    while (patches.length < num_patches) {
        // Find the start of the headers (skip leading CR/LF)
        let headers_start = 0
        while (buffer[headers_start] === 13 || buffer[headers_start] === 10)
            headers_start++
        if (headers_start === buffer.length)
            break

        // Look for the double-newline at the end of the headers.
        let headers_end = headers_start
        while (++headers_end) {
            if (headers_end > buffer.length)
                break
            if (buffer[headers_end - 1] === 10
                && (buffer[headers_end - 2] === 10
                    || (buffer[headers_end - 2] === 13
                        && buffer[headers_end - 3] === 10)))
                break
        }
        if (headers_end > buffer.length)
            break

        // Extract the header string
        var headers_source = buffer.slice(headers_start, headers_end)
            .map(x => String.fromCharCode(x)).join('')

        // Now let's parse those headers.
        var patch_headers = require('parse-headers')(headers_source)

        // We require `content-length` to declare the length of the patch.
        if (!('content-length' in patch_headers)) {
            // Print a nice error if it's missing
            console.error('No content-length in', JSON.stringify(patch_headers),
                          'from', new TextDecoder().decode(new Uint8Array(buffer)),
                          {buffer})
            process.exit(1)
        }

        var body_length = parseInt(patch_headers['content-length'])

        // Give up if we don't have the full patch yet.
        if (buffer.length - headers_end < body_length) break

        // XX Todo: support custom patch types beyond content-range "Range Patches".

        // Content-range is of the form '<unit> <range>' e.g. 'json .index'
        var [unit, range] = parse_content_range(patch_headers['content-range'])
        var patch_content = new Uint8Array(buffer.slice(headers_end,
                                                        headers_end + body_length))

        // We've got our patch!
        let patch = {unit, range, content: patch_content}
        Object.defineProperty(patch, 'content_text', {
            get: () => new TextDecoder('utf-8').decode(patch.content)
        })
        patches.push(patch)

        buffer = buffer.slice(headers_end + body_length)
    }

    if (patches.length !== num_patches)
        console.error(`Got an incomplete PUT: ${patches.length}/${num_patches} patches were received`)

    cb({ patches, body: undefined })
}

function parse_content_range (range_string) {
    var match = range_string.match(/(\S+)( (.*))?/)
    if (!match) throw 'Cannot parse Content-Range in ' + string
    var [unit, range] = [match[1], match[3] || '']
    return [unit, range]
}


// Guard against double-braidification.
//
// Libraries (like braid-text &braid-blob) call braidify on the same
// request/response.  We can't let it run twice on the same request.  That can
// cause e.g. duplicate multiplexer request-id errors (409).
var braidify_version = require('./package.json').version
var warned_about_braidify_dupe = false
function warn_braidify_dupe (req) {
    function version_bigger (a, b) {
        var pa = a.split('.').map(Number)
        var pb = b.split('.').map(Number)
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) return true
            if ((pa[i] || 0) < (pb[i] || 0)) return false
        }
        return false
    }

    if (!warned_about_braidify_dupe) {
        var installed = req._braidified
        var major_mismatch = installed.split('.')[0] !== braidify_version.split('.')[0]
        var dominated = version_bigger(braidify_version, installed)

        if (major_mismatch || dominated)
            console.warn('braid-http: braidify already applied (v' + installed
                         + '), skipping v' + braidify_version
                         + (major_mismatch
                            ? ' — major version mismatch, things may break'
                            : ' — installed version is older, may lack features'))

        warned_about_braidify_dupe = true
    }
}

// Like setTimeout, but can be aborted in a batch (via batch_id) and calls
// on_abort on each timeout when aborted, instead of on_timeout.
function abortable_set_timeout(batch_id, on_timeout, on_abort, timeout_ms) {
    if (!braidify.pending_timeouts)
        braidify.pending_timeouts = new Map()

    var timers = braidify.pending_timeouts.get(batch_id)
    if (!timers) {
        timers = new Set()
        braidify.pending_timeouts.set(batch_id, timers)
    }

    var timer = { on_abort: on_abort }
    timer.timeout = setTimeout(function() {
        timers.delete(timer)
        if (!timers.size)
            braidify.pending_timeouts.delete(batch_id)
        on_timeout()
    }, timeout_ms)

    timers.add(timer)
}
// Aborts an abortable_timeout created above.
function abort_timeouts(batch_id) {
    var timers = braidify.pending_timeouts?.get(batch_id)
    if (!timers) return
    braidify.pending_timeouts.delete(batch_id)
    for (var t of timers) {
        clearTimeout(t.timeout)
        t.on_abort()
    }
}


// The main server function!  Dispatches based on argument shape:
//
//  - braidify((req, res) => ...)      calls braidify.handler
//  - braidify(server)                 calls braidify.server
//  - braidify(req, res, next)         calls braidify.middleware (Express-style)
//  - braidify(req, res)               calls braidify.request (inline)
//
function braidify (req, res, next) {
    if (typeof req === 'function') return braidify.handler(req)
    // A server-like object can be distinguished because it has:
    //   • 1 arg
    //   • a .listen() method
    if (arguments.length === 1 && req && typeof req.listen === 'function')
        return braidify.server(req)
    if (typeof next === 'function') return braidify.middleware(req, res, next)
    return braidify.request(req, res)
}

// Braidify a (req, res) => {} handler, by returning a wrapped (req, res) => {} handler.
//
// The wrapped handler:
//  - Braidifies the req and res
//  - Handles and hides multiplexer requests behind the scenes
//  - Receives perfect replacement res that writes into multiplexer
//  - Supports multiplex_wait to ensure ordering with multiplexer creation
//
braidify.handler = function (handler) {
    return (req, res, next) => {
        braidify_request_internal(req, res, (new_req, new_res) =>
            handler(new_req, new_res, next))
    }
}

// Braidify a node-style http.Server.  Supports 'http', 'https', 'http2',
// 'fastify', 'restify', and the apps of 'express', 'koa', 'connect'...
//
// The server:
//  - Braidifies the req and res
//  - Handles and hides multiplexer requests behind the scenes
//  - Provides perfect replacement res that writes into multiplexer
//  - Supports multiplex_wait to ensure ordering with multiplexer creation
//
braidify.server = function (server) {
    if (server._braidified_server) return server
    server._braidified_server = true
    var original_emit = server.emit.bind(server)
    server.emit = function (event, ...args) {
        if (event !== 'request') return original_emit(event, ...args)
        var [req, res] = args
        braidify_request_internal(req, res, (new_req, new_res) =>
            original_emit('request', new_req, new_res))
        return true
    }
    return server
}

// Braidify a request and response as Express middleware, with `next`.
//
//  - Handles and hides multiplexer requests behind the scenes
//  - Does NOT provide perfect replacement res.  Some types of monkey-patches
//    to req/res can break.
//  - Supports multiplex_wait to ensure ordering with multiplexer creation
//
braidify.middleware = function (req, res, next) {
    // Pass `() => next()` (not `next` directly) because braidify_request_internal
    // calls done(req, new_res) with two args, and Express's next() interprets
    // a truthy first arg as an error.  We want next() with no args.
    braidify_request_internal(req, res, () => next())
}

// Braidify a `req` and `res` inline.
//
//  - Handles but does NOT HIDE multiplex requests.
//    - Caller must do `if (req.is_multiplexer) return`
//  - Returns a perfect replacement res that writes into multiplexer.
//  - Does NOT support multiplex_wait buffer.
//    - Results in 15% more 424s with extra 1rt on first multiplexed request
//
braidify.request = function (req, res) {
    // No `done` callback → braidify_request_internal sees done is undefined,
    // skips the multiplex_wait branch, and runs synchronously.  By the time
    // it returns, new_res is final (either res2 if multiplex-through, else
    // the original res).
    var new_res = braidify_request_internal(req, res)
    return {req, res: new_res}
}


// This does the actual braidification.
//
// When done and ready for the user's handler to be called, it calls
// done(req, new_res).  Also returns new_res synchronously, for callers
// (like braidify.request) that don't use the done callback.
function braidify_request_internal (req, res, done) {
    // We may end up creating a synthetic new_res to use in place of res for
    // multiplex-through sub-requests.  We return it at the end so callers
    // (like braidify.request) can hand it back to the user.
    var new_res = res

    // Guard against double-braidification.
    if (req._braidified && !req.reprocess_me) {
        // If this was already braidified, then print a warning
        warn_braidify_dupe(req)
        // and stop braidifying it any further — but still let the user
        // handler run, since the dupe req/res were already braidified
        done?.(req, res)
        return new_res
    }
    // But some potential 424 responses get delayed and reprocessed.
    // So let's clear the reprocess_me flag on those, since we're doing it.
    delete req.reprocess_me


    req._braidified = braidify_version

    // console.log('\n## Braidifying', req.method, req.url, req.headers.peer)

    // Prevent uncaught EPIPE crashes on client disconnect
    res.on('error', (_e) => {})

    // First, declare that we support Patches and JSON ranges.
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT')
    res.setHeader('Range-Request-Allow-Units', 'json')

    // All requests explicitly Vary on Version, Parents, and Subscribe
    res.appendHeader('Vary', 'Version')
    res.appendHeader('Vary', 'Parents')
    res.appendHeader('Vary', 'Subscribe')

    // Extract braid info from headers
    var version = ('version' in req.headers) && JSON.parse('['+req.headers.version+']'),
        parents = ('parents' in req.headers) && JSON.parse('['+req.headers.parents+']'),
        peer = req.headers['peer']

    // Parse the subscribe header
    var subscribe = req.headers.subscribe
    // If the subscribe header exists...
    if ((subscribe === '' || subscribe)
        // And this is a GET, because `Subscribe:` is only
        // specified for GET thus far...
        && req.method === 'GET') {
        // Then let's set 'subscribe' on.  We default to "true", but if the
        // client actually specified a value other than empty string '', let's
        // use that rich value.
        subscribe = subscribe || true

        // Great. Now we also need to set the response body's content-type, so
        // that FireFox doesn't try to sniff the content-type on a stream and
        // hang forever waiting for 512 bytes (see firefox issue
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1544313)
        res.setHeader('Content-Type', 'application/http-sequence')

        // And we don't want any caches trying to store these stream bodies.
        res.setHeader('Cache-Control', 'no-store')
    }

    // Define convenience variables
    req.version   = version
    req.parents   = parents
    req.peer      = peer
    req.subscribe = subscribe

    // Multiplexer stuff
    var multiplex_version = '1.0'
    if ((braidify.enable_multiplex ?? true) &&
        (req.method === 'MULTIPLEX' || req.url.startsWith('/.well-known/multiplexer/'))) {
        req.is_multiplexer = res.is_multiplexer = true

        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        // check the multiplexing protocol version
        if (req.headers['multiplex-version'] !== multiplex_version) {
            res.writeHead(400, 'Bad Multiplexer Version')
            return res.end()
        }

        // parse the multiplexer id and request id from the url
        var [multiplexer_id, request_id] = req.url.split('/').slice(req.method === 'MULTIPLEX' ? 1 : 3)

        // if there's just a multiplexer, then we're creating a multiplexer..
        if (!request_id) {
            // maintain a Map of all the multiplexers
            if (!braidify.multiplexers) braidify.multiplexers = new Map()

            // if this multiplexer already exists, respond with an error
            if (braidify.multiplexers.has(multiplexer_id)) {
                res.writeHead(409, 'Conflict', {'Content-Type': 'application/json'})
                return res.end(JSON.stringify({
                    error: 'Multiplexer already exists',
                    details: `Cannot create duplicate multiplexer with ID '${multiplexer_id}'`
                }))
            }

            braidify.multiplexers.set(multiplexer_id, {requests: new Map(), res})

            // Clean up multiplexer on error or close
            function cleanup() {
                var multiplexer = braidify.multiplexers.get(multiplexer_id)
                if (!multiplexer) return
                for (var f of multiplexer.requests.values()) f()
                braidify.multiplexers.delete(multiplexer_id)
            }
            res.on('error', cleanup)
            res.on('close', cleanup)

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
            res.write(`\r\n`)

            // Notify any requests that arrived before this multiplexer
            // was created. Must happen after writeHead so the POST's
            // response is ready before waiters write through it.
            abort_timeouts(multiplexer_id)
            return
        } else {
            // in this case, we're closing the given request

            // if the multiplexer doesn't exist, send an error
            var multiplexer = braidify.multiplexers?.get(multiplexer_id)
            if (!multiplexer) {
                res.writeHead(404, 'Multiplexer no exist', {'Bad-Multiplexer': multiplexer_id})
                return res.end(`multiplexer ${multiplexer_id} does not exist`)
            }

            // if the request doesn't exist, send an error
            let request_finisher = multiplexer.requests.get(request_id)
            if (!request_finisher) {
                res.writeHead(404, 'Multiplexed request not found', {'Bad-Request': request_id})
                return res.end(`request ${request_id} does not exist`)
            }

            // remove this request, and notify it
            multiplexer.requests.delete(request_id)
            request_finisher()

            // let the requester know we succeeded
            res.writeHead(200, 'OK', { 'Multiplex-Version': multiplex_version })
            return res.end(``)
        }
    }

    // a Multiplex-Through header means the user wants to read the
    // results of this request to the provided multiplexer,
    // tagged with the given request id
    if ((braidify.enable_multiplex ?? true) &&
        req.headers['multiplex-through'] &&
        req.headers['multiplex-version'] === multiplex_version) {

        // parse the multiplexer id and request id from the header
        var [multiplexer_id, request_id] = req.headers['multiplex-through'].split('/').slice(3)

        // find the multiplexer object (contains a response object)
        var multiplexer = braidify.multiplexers?.get(multiplexer_id)
        if (!multiplexer) {
            if (braidify.multiplex_wait && done) {
                // Wait a few milliseconds for the multiplexer to be created.
                //
                // This handles the race where Multiplex-Through arrives
                // before the POST that creates the multiplexer.  We'll wait a
                // few ms to see if the POST arrives before giving up with a 424.
                abortable_set_timeout(multiplexer_id,
                    function give_up () {
                        // Timed out — send 424
                        free_cors(res)
                        req.is_multiplexer = res.is_multiplexer = true
                        res.writeHead(424, 'Multiplexer not found',
                                      {'Bad-Multiplexer': multiplexer_id})
                        res.end('multiplexer ' + multiplexer_id
                                + ' does not exist')
                    },
                    function ready_for_mux () {
                        // Multiplexer appeared — re-process the request
                        req.reprocess_me = true
                        braidify_request_internal(req, res, done)
                    },
                    braidify.multiplex_wait)
                return
            }

            free_cors(res)
            req.is_multiplexer = res.is_multiplexer = true
            res.writeHead(424, 'Multiplexer not found',
                          {'Bad-Multiplexer': multiplexer_id})
            return res.end('multiplexer ' + multiplexer_id
                           + ' does not exist')
        }

        // if this request-id already exists, respond with an error
        if (multiplexer.requests.has(request_id)) {
            // free cors to multiplexer errors
            free_cors(res)

            req.is_multiplexer = res.is_multiplexer = true
            res.writeHead(409, 'Conflict', {'Content-Type': 'application/json'})
            return res.end(JSON.stringify({
                error: 'Request already multiplexed',
                details: `Cannot multiplex request with duplicate ID '`
                         + request_id + `' for multiplexer '` + multiplexer_id + `'`
            }))
        }

        multiplexer.res.write(`start response ${request_id}\r\n`)

        // let the requester know we've multiplexed his response
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
            constructor(multiplexer, request_id) {
                super()
                this.multiplexer = multiplexer
                this.request_id = request_id
            }

            _write(chunk, encoding, callback) {
                og_res_end?.()

                try {
                    var len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding)
                    this.multiplexer.res.write(`${len} bytes for response ${this.request_id}\r\n`)
                    this.multiplexer.res.write(chunk, encoding, callback)
                } catch (e) {
                    callback(e)
                }
            }
        }
        var mw = new MultiplexedWritable(multiplexer, request_id)
        mw.on('error', () => {})  // EPIPE when client disconnects mid-stream

        // then we create a fake server response,
        // that pipes data to our fake socket
        var res2 = new (require('http').ServerResponse)({})
        res2.useChunkedEncodingByDefault = false
        res2.assignSocket(mw)

        // res2 is the "effective" response for this multiplexed sub-request.
        // braidify.handler / braidify.server use this to deliver the right
        // response object to the user's handler.
        new_res = res2

        // register a handler for when the multiplexer closes,
        // to close our fake response
        multiplexer.requests.set(request_id, () => {
            og_res_end?.()
            res2.destroy()
        })

        // when our fake response is done,
        // we want to send a special message to the multiplexer saying so
        res2.on('finish', () => multiplexer.res.write(`close response ${request_id}\r\n`))

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
                // these cause res2 to close prematurely
                || key === 'destroyed'
                || key === '_closed'

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
        res.multiplexer = multiplexer.res
    }

    // Add the braidly request/response helper methods.
    add_braid_helpers(req, res, new_res, peer)

    // Check the Useragent to work around Firefox bugs
    if (req.headers['user-agent']
        && typeof req.headers['user-agent'] === 'string'
        && req.headers['user-agent'].toLowerCase().indexOf('firefox') > -1)
        res.is_firefox = true

    // Hand control back to the caller with the new req and res.
    done?.(req, new_res)
    return new_res
}


// Add the braidly request/response helper methods:
//
//  - req.parseUpdate, req.patches, req.patchesJSON, req.startSubscription
//  - res.sendUpdate, res.sendVersion, res.startSubscription
//
// We add the response helpers to both res and res2.
//
//  - res2 is the "canonical" response
//  - res is backwards-compatible with some uses of braidify
//    - it forwards specific properties to res2 (before this function runs)
//
function add_braid_helpers (req, res, res2, peer) {
    res2 = res2 || res

    res2.sendUpdate = (stuff) => send_update(res2, stuff, req.url, peer)
    res2.sendVersion = res2.sendUpdate
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
    req.startSubscription = res2.startSubscription =
        function startSubscription (args = {}) {
            // console.log('Starting subscription!')
            // console.log('Timeouts are:',
            //             req.socket.server.timeout,
            //             req.socket.server.keepAliveTimeout)

            res2.isSubscription = true

            // Let's disable the timeouts (if it exists)
            if (req.socket.server) {
                req.socket.server.timeout = 0.0

                // Node 18+ added requestTimeout (default 300s) and
                // headersTimeout (default 60s) which will kill idle
                // long-lived connections — our bread and butter.  We disable
                // the requestTimeout, but the headersTimeout is probably
                // fine.
                //
                req.socket.server.requestTimeout = 0
                // req.socket.server.headersTimeout = 0
            }

            // We have a subscription!
            res2.statusCode = 209
            res2.statusMessage = 'Multiresponse'
            res2.setHeader("subscribe", req.headers.subscribe ?? 'true')
            res2.setHeader('cache-control', 'no-cache, no-transform, no-store')


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
            //     res2.setHeader('transfer-encoding', '')
            // }

            // Tell nginx not to buffer the subscription
            res2.setHeader('X-Accel-Buffering', 'no')

            var connected = true
            function disconnected (x) {
                if (!connected) return
                connected = false
                // console.log(`Connection closed on ${req.url} from`, x, 'event')

                // Now call the callback
                if (args.onClose)
                    args.onClose()
            }

            res2.on('close',   x => disconnected('close'))
            res2.on('finish',  x => disconnected('finish'))
            req.on('abort',    x => disconnected('abort'))

            // Start sending heartbeats to the client every N seconds if
            // they've been requested.  Heartbeats help a client know if a
            // connection is still alive, and can also signal to
            // intermediaries to keep a connection open, because sometimes
            // intermediaries will time-out a connection after a period of no
            // activity.
            if (req.headers['heartbeats']) {
                let heartbeats = parseFloat(req.headers['heartbeats'])
                if (isFinite(heartbeats)) {
                    res2.setHeader('heartbeats', req.headers['heartbeats'])
                    let closed
                    res2.on('close', () => closed = true)
                    loop()
                    function loop() {
                        // We only send heartbeats:
                        //  - After the headers have been sent
                        //  - Before the stream has closed
                        if (res2.headersSent && !res2.writableEnded && !closed)
                            res2.write("\r\n")

                        setTimeout(loop, 1000 * heartbeats)
                    }
                }
            }
        }

    // Mirror the helpers onto res so callers holding the original res
    // (inline / middleware forms) find them too.  No-op when res === res2.
    if (res !== res2) {
        res.sendUpdate = res2.sendUpdate
        res.sendVersion = res2.sendVersion
        res.startSubscription = res2.startSubscription
    }
}

async function send_update(res, update, url, peer) {
    // Normalize all headers in update to lowercase
    update = Object.fromEntries(
        Object.entries(update)
            .map(([k, v]) => [k.toLowerCase(), v])
    )

    var {version, parents, patches, patch, body, status, encoding} = update
    // Note: This ^^ `encoding` field is wrong!  It's used for the dt encoding
    // in braid-text, but that should be content-encoding or transfer-encoding
    // or x-transfer-encoding.

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
        if (res.isSubscription && !encoding) res.write('\r\n')
        write_binary(res, body)
    }

    // console.log('Sending Update', {url, peer, update, subscription: res.isSubscription})

    // Validate the body and patches
    assert(!(patch && patches),
           'sendUpdate: cannot have both `update.patch` and `update.patches` set')
    assert(!(body && (patches || patch)),
           'sendUpdate: cannot have both `update.body` and `update.patch(es)')
    assert(!patches || Array.isArray(patches),
           'sendUpdate: `patches` provided is not array')

    // Now the caller has specified EITHER `patch:` or `patches:`.  IFF he
    // specified the latter, we will ultimately output a "Patches: N" block,
    // rather than a single inlined patch.
    var using_patches_n = !!patches

    // Now we will stop using the `patch` form, and only use `patches`.
    if (patch) {
        patches = [patch]  // Use this now
        patch = NaN        // Don't use this variable anymore
    }

    // Validate body format
    if (body !== undefined) {
        assert(typeof body === 'string' || get_binary_length(body) != null)
        if (typeof Blob !== 'undefined' && body instanceof Blob) body = await body.arrayBuffer()
    }

    // Validate patches format
    if (patches) {
        assert(typeof patches === 'object' && Array.isArray(patches))
        for (let p of patches) {
            assert('unit' in p)
            assert('range' in p)
            assert('content' in p)
            assert(typeof p.content === 'string'
                   || get_binary_length(p.content) != null)

            // And convert blobs to... what?   Because... why?  What is this?
            if (typeof Blob !== 'undefined' && p.content instanceof Blob)
                p.content = await p.content.arrayBuffer()

            // //   - Move content-type onto each patch if using_patches_n
            // if (using_patches_n && content_type)
            //     p['content-type'] = content_type
        }
    }

    if (using_patches_n && update['content-type']) {
        // Clear content_type, because it will get clobbered in write_patches()
        console.warn('braid-http: content-type ' + update['content-type']
                     + ' ignored on update with multiple patches'
                     + ' (of type application/http-patches)')
        delete update['content-type']
    }

    // if (using_patches_n) {
    //     // Clear content_type, because we moved it onto the patches
    //     content_type = undefined
    //     delete update.content_type
    // }

    // To send a response without a body, we just send an empty body
    if (!patches && !body)
        body = ''

    var reason =
        status === 200 ? 'OK'
        : status === 404 ? 'Not Found'
        : 'Unknown'
    if (res.isSubscription && !encoding) res.write(`HTTP ${status} ${reason}\r\n`)

    // Write the headers or virtual headers
    for (var [header, value] of Object.entries(update)) {

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
        set_header(encoding ? 'Length' : 'Content-Length', length)
        write_body(binary)
    } else
        write_patches(res, patches, using_patches_n)

    // Add a newline to prepare for the next version
    // See also https://github.com/braid-org/braid-spec/issues/73
    if (res.isSubscription) {
        var extra_newlines = 1

        // Note: this firefox workaround was replaced with a content-type fix
        // above.  We realized that content-type fixes the issue when we found
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1544313
        //
        // if (res.is_firefox)
        //     // Work around Firefox network buffering bug
        //     // See https://github.com/braid-org/braidjs/issues/15
        //     extra_newlines = 240

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

function free_cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Access-Control-Expose-Headers", "*")
}

braidify.multiplex_wait = 10  // ms; set to 0 or false to disable

module.exports = {
    braidify,
    free_cors
}
