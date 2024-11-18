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
function write_patches(res, patches) {
    // `patches` must be a patch object or an array of patch objects
    //  - Object:  {unit, range, content}
    //  - Array:  [{unit, range, content}, ...]

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

        if (typeof patch.content === 'string')
            patch.content = new TextEncoder().encode(patch.content)

        if (i > 0)
            res.write('\r\n\r\n')

        let extra_headers = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k != 'unit' && k != 'range' && k != 'content'))

        res.write(`Content-Length: ${get_binary_length(patch.content)}\r
Content-Range: ${patch.unit} ${patch.range}\r
${Object.entries(extra_headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r
`)
        write_binary(res, patch.content)
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
    // console.log('\n## Braidifying', req.method, req.url, req.headers.peer)

    // First, declare that we support Patches and JSON ranges.
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT')
    res.setHeader('Range-Request-Allow-Units', 'json')

    // Extract braid info from headers
    var version = ('version' in req.headers) && JSON.parse('['+req.headers.version+']'),
        parents = ('parents' in req.headers) && JSON.parse('['+req.headers.parents+']'),
        peer = req.headers['peer'],
        url = req.url.substr(1)

    // Parse the subscribe header
    var subscribe = req.headers.subscribe
    if (subscribe === 'true')
        subscribe = true

    // Define convenience variables
    req.version   = version
    req.parents   = parents
    req.subscribe = subscribe

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
            res.setHeader("subscribe", req.headers.subscribe)
            res.setHeader('cache-control', 'no-cache, no-transform')


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

    // console.log('sending version', {url, peer, version, parents, patches, body,
    //                                 subscription: res.isSubscription})

    // Validate that the body and patches are strings,
    // or in the case of body, it could be binary
    if (body !== undefined) {
        assert(typeof body === 'string' || get_binary_length(body) != null)
        if (body instanceof Blob) body = await body.arrayBuffer()
    } else {
        // Only one of patch or patches can be set
        assert(!(patch && patches))
        assert((patch || patches) !== undefined)
        assert((patch || patches) !== null)

        // Patches must be an array
        if (patches)
            assert(Array.isArray(patches))

        // But if using `patch`, then we set `patches` to just that object
        if (patch)
            patches = patch

        // Now `patches` will be an array of patches or a single patch object.
        //
        // This distinction is used in write_patches() to determine whether
        // to inline a single patch in the update body vs. writing out a
        // Patches: N block.
        assert(typeof patches === 'object')
        for (let p of Array.isArray(patches) ? patches : [patch]) {
            assert('unit' in p)
            assert('range' in p)
            assert('content' in p)
            assert(typeof p.content === 'string' || get_binary_length(p.content) != null)
            if (p.content instanceof Blob) p.content = await p.content.arrayBuffer()
        }
    }

    var body_exists = body || body === ''
    assert(body_exists || patches, 'Missing body or patches')
    assert(!(body_exists && patches), 'Cannot send both body and patches')

    if (res.isSubscription) res.write(`HTTP ${status} OK\r\n`)

    // Write the headers or virtual headers
    for (var [header, value] of Object.entries(data)) {
        header = header.toLowerCase()

        // A header set to undefined acts like it wasn't set
        if (value === undefined)
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
    if (body_exists) {
        let x = typeof body === 'string' ? new TextEncoder().encode(body) : body
        set_header('Content-Length', get_binary_length(x))
        write_body(x)
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
            x instanceof Blob ? x.size :
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
