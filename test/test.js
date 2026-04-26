#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
var fs = require('fs')
var path = require('path')
var define_tests = require('./tests.js')
var {braidify, free_cors} = require('../braid-http-server.js')
var https = require('../braid-http-client.js').http(require('https'))
var braid_fetch = require('../braid-http-client.js').fetch
var multiplex_fetch = require('../braid-http-client.js').multiplex_fetch
var reliable_update_channel = require('../braid-http-client.js').reliable_update_channel
var {create_braid_text} = require('braid-text')

// Parse command line arguments
var args = process.argv.slice(2)
var mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
var filter_arg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
    || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test/test.js [options]

Options:
  --browser, -b          Start server for browser testing (default: console mode)
  --filter=PATTERN       Only run tests matching pattern (case-insensitive)
  --grep=PATTERN         Alias for --filter
  --port=N               Base port (uses N, N+1, N+2, N+3). Default 9000. Or set PORT env.
  --help, -h             Show this help message

Examples:
  node test/test.js                      # Run all tests in console
  node test/test.js --filter="version"   # Run only tests with "version" in name
  node test/test.js --browser            # Start browser test server
  node test/test.js -b                   # Short form for browser mode
  node test/test.js --port=9100          # Run on ports 9100-9103 (e.g. parallel run)
  PORT=9100 node test/test.js            # Same via env var
`)
    process.exit(0)
}

// Allow self-signed certs for localhost testing
if (typeof fetch !== 'undefined') allow_self_signed_certs()

// Server configuration.  Default port 9000; override with env PORT or --port=N.
var port = parseInt(process.env.PORT
    || args.find(arg => arg.startsWith('--port='))?.split('=')[1]
    || 9000)
var test_update = {
    version: ['test'],
    parents: ['oldie'],
    body: JSON.stringify({this: 'stuff'})
}
var retries_left = 4
var giveup_completely_set = {}
var faulty_mux_i = 0
var deleted_request_count = {}

process.on("unhandledRejection", (x) => {
    if (mode === 'browser') console.log(`unhandledRejection: ${x.stack}`)
})
process.on("uncaughtException", (x) =>
    console.log(`uncaughtException: ${x.stack}`)
)

// ============================================================================
// Test Server
// ============================================================================

var braid_text_instance = create_braid_text()
braid_text_instance.db_folder = null
var braid_text_fail_first_get = {}     // key -> true, returns 500
var braid_text_fail_first_put = {}     // key -> true, returns 500
var braid_text_first_get_status = {}   // key -> {status, retry_after?}
var braid_text_first_put_status = {}   // key -> {status, retry_after?}
var braid_text_get_parents_log = {}    // key -> [parents-header-value, ...]
var braid_text_put_delay_ms = {}       // key -> ms to delay each PUT by
var braid_text_put_concurrency = {}    // key -> {current, max}
var braid_text_hang_first_put = {}     // key -> true, first PUT hangs forever
var braid_text_headers_log = {}        // key -> [{method, headers}, ...]
global.braid_text_fail_first_get = braid_text_fail_first_get
global.braid_text_fail_first_put = braid_text_fail_first_put
global.braid_text_first_get_status = braid_text_first_get_status
global.braid_text_first_put_status = braid_text_first_put_status
global.braid_text_get_parents_log = braid_text_get_parents_log
global.braid_text_put_delay_ms = braid_text_put_delay_ms
global.braid_text_put_concurrency = braid_text_put_concurrency
global.braid_text_hang_first_put = braid_text_hang_first_put
global.braid_text_headers_log = braid_text_headers_log

function create_test_server() {
    var server = require('http2').createSecureServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem')),
        allowHTTP1: true
    }, async (req, res) => {
        console.log('Request:', req.url, req.method)

        // Only allow connections from localhost
        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            console.log(`connection attempt from: ${req.socket.remoteAddress}`)
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }

        // MULTIPLEX
        var is_mux = req.method === 'MULTIPLEX' || req.url.startsWith('/.well-known/multiplexer/')
        if (is_mux) {
            var [multiplexer, request] = req.url.split('/').slice(req.method === 'MULTIPLEX' ? 1 : 3)
        }

        if (is_mux && request) deleted_request_count[request] = (deleted_request_count[request] ?? 0) + 1

        if (is_mux && multiplexer === 'faulty_mux') {
            faulty_mux_i++
            if (faulty_mux_i === 1) {
                res.writeHead(425)
                return res.end('')
            }
        } else if (is_mux && multiplexer === 'bad_mux') {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && multiplexer === 'bad_mux_method' && req.method === 'MULTIPLEX') {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && multiplexer === 'bad_mux_well_known_url' && req.url.startsWith('/.well-known/multiplexer/')) {
            res.writeHead(500)
            return res.end('')
        } else if (is_mux && request === 'bad_request') {
            res.writeHead(500)
            return res.end('')
        } else if (req.url === '/500') {
            res.writeHead(500)
            return res.end('')
        }

        if (req.headers.pre_delay_ms) await new Promise(done => setTimeout(done, parseFloat(req.headers.pre_delay_ms)))

        var eval_func = () => new Promise((done, fail) => {
            var body = ''
            req.on('data', chunk => {
                body += chunk.toString()
            })
            req.on('end', () => {
                try {
                    done(eval(body))
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' })
                    res.end(`Error: ${error.message}`)
                    fail(error)
                }
            })
        })

        if (req.url.startsWith('/eval_pre_braidify') && req.method === 'POST')
            if ((await eval_func()) !== 'keep going') return res.end('ok')

        // Braid-text test endpoint
        if (req.url.startsWith('/braid-text-test')) {
            var key = req.url.split('?')[0]
            // Optional: record all headers on each request (for tests)
            if (braid_text_headers_log[key])
                braid_text_headers_log[key].push({method: req.method, headers: {...req.headers}})
            // Optional: log the parents header seen on each GET (for tests)
            if (req.method === 'GET' && braid_text_get_parents_log[key])
                braid_text_get_parents_log[key].push(req.headers.parents ?? null)
            // Optional: fail the first GET on this URL, then succeed (for retry tests)
            if (req.method === 'GET' && braid_text_fail_first_get[key]) {
                delete braid_text_fail_first_get[key]
                res.writeHead(500)
                return res.end('')
            }
            // Optional: return a specific status (and optional Retry-After)
            // on the first GET of this key, then succeed on subsequent GETs
            if (req.method === 'GET' && braid_text_first_get_status[key]) {
                var spec = braid_text_first_get_status[key]
                delete braid_text_first_get_status[key]
                var headers = {}
                if (spec.retry_after !== undefined)
                    headers['Retry-After'] = String(spec.retry_after)
                res.writeHead(spec.status, headers)
                return res.end('')
            }
            if (req.method === 'PUT' && braid_text_fail_first_put[key]) {
                delete braid_text_fail_first_put[key]
                res.writeHead(500)
                return res.end('')
            }
            // Optional: hang the first PUT forever (for timeout tests)
            if (req.method === 'PUT' && braid_text_hang_first_put[key]) {
                delete braid_text_hang_first_put[key]
                return  // never respond
            }
            // Optional: return a specific status (and optional Retry-After)
            // on the first PUT of this key, then succeed on subsequent PUTs
            if (req.method === 'PUT' && braid_text_first_put_status[key]) {
                var put_spec = braid_text_first_put_status[key]
                delete braid_text_first_put_status[key]
                var put_headers = {}
                if (put_spec.retry_after !== undefined)
                    put_headers['Retry-After'] = String(put_spec.retry_after)
                res.writeHead(put_spec.status, put_headers)
                return res.end('')
            }
            // Optional: track PUT concurrency per key (for probe-first tests)
            if (req.method === 'PUT' && braid_text_put_concurrency[key]) {
                var c = braid_text_put_concurrency[key]
                c.current++
                if (c.current > c.max) c.max = c.current
                var decremented = false
                var dec = () => { if (!decremented) { decremented = true; c.current-- } }
                res.on('close', dec)
                res.on('finish', dec)
            }
            // Optional: delay each PUT by some number of ms (for probe-first tests)
            if (req.method === 'PUT' && braid_text_put_delay_ms[key]) {
                await new Promise(r => setTimeout(r, braid_text_put_delay_ms[key]))
            }
            return braid_text_instance.serve(req, res, {key})
        }

        // Braidifies our server
        braidify(req, res)
        if (req.is_multiplexer) return

        if (req.url.startsWith('/eval') && req.method === 'POST')
            if ((await eval_func()) !== 'keep going') return

        // MULTIPLEX
        if (req.url === '/kill_mux') {
            braidify.multiplexers?.get(req.headers.mux)?.res.end('AAAAA')
            return res.end(`ok`)
        }
        if (is_mux) res.end('hm..')

        // We'll serve Braid at the /json route!
        if (req.url.startsWith('/json') && req.method === 'GET') {
            res.setHeader('content-type', req.headers.charset ? 'application/json; charset=utf-8' : 'application/json')

            if (giveup_completely_set[req.headers.giveup_completely]) {
                res.statusCode = 500
                return res.end()
            }

            // If the client requested a subscription, let's honor it!
            if (req.subscribe)
                res.startSubscription()

            // test writing header after startSubscription
            res.setHeader('post-sub-header', 'yup')

            // Send the current version
            if (!req.headers.skip_first) res.sendUpdate(test_update)

            res.multiplexer?.write('\r\r\n\r\r')

            if (req.headers.send_unicode_version) res.sendUpdate({
                version: ['hello🌍-0'],
                body: 'hi'
            })
            if (req.headers.send_unicode_parents) res.sendUpdate({
                parents: ['hello🌍-0', '🌈-5'],
                body: 'hi'
            })

            // Send a binary body update
            if (req.headers.send_binary_body_arraybuffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Uint8Array([0, 1, 2, 3]).buffer
            })
            if (req.headers.send_binary_body) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: new Uint8Array([0, 1, 2, 3])
            })
            if (req.headers.send_binary_body_blob) {
                await res.sendUpdate({
                    version: ['test'],
                    parents: ['oldie'],
                    body: typeof Blob !== 'undefined' ?
                        new Blob([new Uint8Array([0, 1, 2, 3])]) :
                        'old node version'
                })
            }
            if (req.headers.send_binary_body_buffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                body: Buffer.from(new Uint8Array([0, 1, 2, 3]))
            })

            // Send a binary patch update
            if (req.headers.send_binary_patch_arraybuffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer}
            })
            if (req.headers.send_binary_patch) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])}
            })
            if (req.headers.send_binary_patch_blob) {
                await res.sendUpdate({
                    version: ['test'],
                    parents: ['oldie'],
                    patch: {unit: 'text', range: '[0:0]', content: typeof Blob !== 'undefined' ? new Blob([new Uint8Array([0, 1, 2, 3])]) : 'old node version'}
                })
            }
            if (req.headers.send_binary_patch_buffer) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patch: {unit: 'text', range: '[0:0]', content: Buffer.from(new Uint8Array([0, 1, 2, 3]))}
            })

            // binary patches
            if (req.headers.send_binary_patches_arraybuffer) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3]).buffer},
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13]).buffer}
                ]
            })
            if (req.headers.send_binary_patches) res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([0, 1, 2, 3])},
                    {unit: 'text', range: '[0:0]', content: new Uint8Array([10, 11, 12, 13])}
                ]
            })
            if (req.headers.send_binary_patches_blob) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: typeof Blob !== 'undefined' ? new Blob([new Uint8Array([0, 1, 2, 3])]) : 'old node version'},
                    {unit: 'text', range: '[0:0]', content: typeof Blob !== 'undefined' ? new Blob([new Uint8Array([10, 11, 12, 13])]) : 'old node version'}
                ]
            })
            if (req.headers.send_binary_patches_buffer) await res.sendUpdate({
                version: ['test'],
                parents: ['oldie'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: Buffer.from(new Uint8Array([0, 1, 2, 3]))},
                    {unit: 'text', range: '[0:0]', content: Buffer.from(new Uint8Array([10, 11, 12, 13]))}
                ]
            })

            if (req.headers.giveup) return setTimeout(() => res.end(), 300)
            if (req.headers.giveup_completely) {
                giveup_completely_set[req.headers.giveup_completely] = true
                return setTimeout(() => res.end(), 300)
            }

            if (req.subscribe) {
                // Send a patch
                res.sendUpdate({
                    VersiOn: ['test1'],
                    ParEnts: ['oldie', 'goodie'],
                    patch: {unit: 'json', range: '[1]', content: '1'},
                    hash: '42',
                    ':status': '115'
                })

                // Send a patch as array
                res.sendUpdate({
                    Version: ['test2'],
                    patch: {unit: 'json', range: '[2]', content: '2'}
                })

                // Send two patches as array
                res.sendUpdate({
                    version: ['test3'],
                    patches: [{unit: 'json', range: '[3]', content: '3', hash: '43'},
                              {unit: 'json', range: '[4]', content: '4'}]
                })

                // Simulate an update after the fact
                setTimeout(() => res.sendUpdate({version: ['another!'], body: '"!"'}), 200)
            }

            // End the response, if this isn't a subscription
            if (!req.subscribe) {
                res.statusCode = 200
                res.end()
            }
        }

        // Simulate a framework that pre-buffers the request body
        // (like Fastify or Express with body-parser)
        if (req.url === '/json_prebuffered' && req.method === 'PUT') {
            braidify(req, res)
            // Read the stream into a buffer, then set already_buffered_body
            var chunks = []
            req.on('data', chunk => chunks.push(chunk))
            req.on('end', async () => {
                req.already_buffered_body = Buffer.concat(chunks)
                if (req.headers.check_patch_content_text) {
                    var update = await req.parseUpdate()
                    for (var p of update.patches)
                        res.write('' + p.content_text + '\n')
                } else if (req.headers.check_body_text) {
                    var update = await req.parseUpdate()
                    res.write(update.body_text)
                }
                res.statusCode = 200
                res.end()
            })
            return
        }

        // Echo back the content-type header the server received
        if (req.url === '/json_echo_content_type' && req.method === 'PUT') {
            res.statusCode = 200
            res.end(req.headers['content-type'] || 'none')
            return
        }

        // Test patch: vs patches: wire format
        if (req.url === '/test_patches_n_trigger' && req.method === 'GET' && req.subscribe) {
            res.startSubscription()

            // Single patch via patch: (should inline, no Patches: N)
            res.sendUpdate({
                version: ['v1'],
                patch: {unit: 'text', range: '[0:0]', content: 'hello'},
            })

            // Single patch via patches: array (should use Patches: 1)
            res.sendUpdate({
                version: ['v2'],
                patches: [{unit: 'text', range: '[0:0]', content: 'world'}],
            })

            // Multiple patches via patches: array (should use Patches: 2)
            res.sendUpdate({
                version: ['v3'],
                patches: [
                    {unit: 'text', range: '[0:0]', content: 'a'},
                    {unit: 'text', range: '[1:1]', content: 'b'},
                ],
            })

            setTimeout(() => res.end(), 100)
            return
        }

        // We'll accept Braid at the /json PUTs!
        if (req.url === '/json' && req.method === 'PUT') {
            if (req.headers.check_patch_content_text) {
                var update = await req.parseUpdate()
                for (var p of update.patches)
                    res.write('' + p.content_text + '\n')
            } else if (req.headers.check_patch_binary) {
                var update = await req.parseUpdate()
                for (var p of update.patches)
                    res.write('' + p.content + '\n')
            } else if (req.headers.check_everything_patch_content_text) {
                var patches = await req.patches()
                res.write(patches[0].content_text)
            } else if (req.headers.check_everything_patch_binary) {
                var patches = await req.patches()
                res.write('' + patches[0].content)
            } else if (req.headers.check_body_binary) {
                var update = await req.parseUpdate()
                res.write('' + update.body)
            } else if (req.headers.check_body_text) {
                var update = await req.parseUpdate()
                res.write(update.body_text)
            }
            res.statusCode = 200
            res.end()
        }

        // Static HTML routes here:
        var pathname = req.url.split('?')[0]
        if (pathname === '/' || pathname === '/client.html')
            res.end(fs.readFileSync(path.join(__dirname, 'client.html')))
        else if (req.url === '/braid-http-client.js')
            res.end(fs.readFileSync(path.join(__dirname, '..', 'braid-http-client.js')))
        else if (req.url === '/tests.js')
            res.end(fs.readFileSync(path.join(__dirname, 'tests.js')))
        else if (req.url === '/test-responses.txt')
            res.end(fs.readFileSync(path.join(__dirname, 'test-responses.txt')))

        // New routes for tests
        if (req.url === "/400") {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: 400 }))
        } else if (req.url === "/401") {
            res.writeHead(401, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: 401 }))
        } else if (req.url === "/keep_open") {
        } else if (req.url === "/check_parents") {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ parents: req.headers.parents }))
        } else if (req.url === "/retry") {
            if (retries_left > 0) {
                retries_left--
                res.writeHead(408, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ error: 408 }))
            } else {
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify(test_update))
            }
        } else if (req.url === '/binary') {
            var buffer = Buffer.alloc(256)
            for (var i = 0; i < 256; i++) buffer[i] = i

            if (req.subscribe) {
                res.startSubscription()
                res.sendUpdate({
                    version: ['test'],
                    parents: ['oldie'],
                    body: buffer
                })
            } else {
                res.writeHead(200, {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": buffer.length
                })
                res.end(buffer)
            }
        } else if (req.url === '/noheartbeat') {
            res.setHeader('Heartbeats', req.headers['heartbeats'])
            delete req.headers['heartbeats']
            res.startSubscription()
            res.sendUpdate(test_update)
            return
        } else if (req.url === '/parse_error') {
            res.startSubscription()
            res.write(`hello: true\r\n`)
            res.write(`hello\r\n`)
            res.write('Content-Length: 2\r\n')
            res.write('\r\n')
            res.write('hi')
        }
    })

    return server
}

function create_express_middleware_server() {
    var express_app = require("express")()

    express_app.use((req, res, next) => {
        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }
        next()
    })

    express_app.use(braidify)

    express_app.use((req, res, next) => {
        free_cors(res)
        if (req.method === 'OPTIONS') return res.end('')
        next()
    })

    express_app.get("/middleware-test", (req, res) => {
        if (mode === 'browser') console.log('Express-Request:', req.url, req.method)

        if (typeof res.startSubscription === "function" && typeof res.sendUpdate === "function") {
            if (req.subscribe) {
                res.startSubscription()
                res.sendUpdate({
                    version: ["middleware-works"],
                    body: "Braidify works as Express middleware!",
                })
            } else {
                res.json({ success: true, message: "Braidify works as Express middleware!" })
            }
        } else {
            res.status(500).end('not ok')
        }
    })

    return https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    }, express_app)
}

function create_wrapper_server() {
    return https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    }, braidify(async (req, res) => {
        if (mode === 'browser') console.log('Wrapped-Handler-Request:', req.url, req.method)

        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1'
        ) {
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }

        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        if (req.url === '/wrapper-test' && req.method === 'GET') {
            res.setHeader('content-type', 'application/json')

            if (req.subscribe)
                res.startSubscription()

            res.sendUpdate({
                version: ['wrapper-test-version'],
                body: JSON.stringify({ message: "Braidify works as a wrapper function!" })
            })

            if (!req.subscribe) {
                res.end()
            } else {
                setTimeout(() => {
                    res.sendUpdate({
                        version: ['wrapper-test-update'],
                        body: JSON.stringify({ message: "This is an update!" })
                    })
                }, 200)
            }
        } else if (req.url === '/eval') {
            var body = ''
            req.on('data', chunk => body += chunk.toString())
            req.on('end', () => {
                try {
                    eval(body)
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' })
                    res.end(`Error: ${error.message}`)
                }
            })
        } else {
            res.writeHead(404)
            res.end('Not found')
        }
    }))
}

// Server using the new braidify.server() entry point (attaches to an
// existing http.Server, intercepts 'request' events).  Listens on port+3.
//
// Hosts the same /wrapper-test-style endpoints, plus a /listener-test
// endpoint that exercises the http2-proxy-bug pattern: setting a property
// on `res` and reading it from inside an event listener.
var listener_test_results = {}
function create_wrapped_server() {
    var server = https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    })

    braidify.server(server)

    server.on('request', (req, res) => {
        if (req.socket.remoteAddress !== '127.0.0.1'
            && req.socket.remoteAddress !== '::1'
            && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('Forbidden: Only localhost connections are allowed')
            return
        }

        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        if (req.url === '/server-test' && req.method === 'GET') {
            res.setHeader('content-type', 'application/json')
            if (req.subscribe) res.startSubscription()
            res.sendUpdate({
                version: ['server-test-version'],
                body: JSON.stringify({ message: "Braidify works as server!" })
            })
            if (!req.subscribe) {
                res.end()
            } else {
                setTimeout(() => res.sendUpdate({
                    version: ['server-test-update'],
                    body: JSON.stringify({ message: "This is a server update!" })
                }), 200)
            }
            return
        }

        // Listener test: set a property on res, attach a 'finish' listener
        // that reads `this[prop]`.  This is the pattern that broke under
        // the old property-forwarding hack (state on res, listener on res2,
        // mismatch when listener fires).
        if (req.url.startsWith('/listener-test/')) {
            var test_id = req.url.split('/').pop()
            res.my_marker = 'magic-' + test_id
            var record = function () {
                if (listener_test_results[test_id]) return  // already recorded
                listener_test_results[test_id] =
                    (this.my_marker === 'magic-' + test_id) ? 'ok' : 'fail'
            }
            res.on('finish', record)
            res.on('close', record)
            res.setHeader('content-type', 'application/json')
            if (req.subscribe) res.startSubscription()
            res.sendUpdate({
                version: ['listener-test-' + test_id],
                body: JSON.stringify({ id: test_id })
            })
            return
        }

        if (req.url.startsWith('/listener-result/')) {
            var test_id = req.url.split('/').pop()
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end(listener_test_results[test_id] || 'pending')
            return
        }

        res.writeHead(404)
        res.end('Not found')
    })

    return server
}

function allow_self_signed_certs() {
    fetch().catch(() => { })
    var globalDispatcherSymbol = Symbol.for('undici.globalDispatcher.1')
    var Agent = globalThis[globalDispatcherSymbol].constructor

    Object.defineProperty(globalThis, globalDispatcherSymbol, {
        value: new Agent({ connect: { rejectUnauthorized: false } }),
        writable: true,
        enumerable: false,
        configurable: false
    })
}

// HTTP/2 fetch wrapper - needed because Node's native fetch uses HTTP/1.1
// which doesn't support custom methods like MULTIPLEX
function create_http2_fetch(base_url) {
    var http2 = require('http2')
    var { URL } = require('url')

    // Keep a session pool for reuse
    var sessions = new Map()

    function get_session(origin) {
        if (!sessions.has(origin)) {
            var session = http2.connect(origin, { rejectUnauthorized: false })
            session.on('error', () => sessions.delete(origin))
            session.on('close', () => sessions.delete(origin))
            sessions.set(origin, session)
        }
        return sessions.get(origin)
    }

    return async function http2_fetch(url, options = {}) {
        var full_url = url.startsWith('http') ? url : `${base_url}${url}`

        // use regular fetch when we can..
        if (options.method !== 'MULTIPLEX')
            return fetch(full_url, options)

        var parsed_url = new URL(full_url)
        var origin = parsed_url.origin

        var client = get_session(origin)

        var headers = {
            ':method': options.method || 'GET',
            ':path': parsed_url.pathname + parsed_url.search,
        }

        // Add custom headers
        if (options.headers) {
            var h = options.headers instanceof Headers ? Object.fromEntries(options.headers) : options.headers
            for (var [key, value] of Object.entries(h)) {
                headers[key.toLowerCase()] = value
            }
        }

        var req = client.request(headers)

        // Send body if present
        if (options.body) {
            req.write(options.body)
        }
        req.end()

        return new Promise((resolve, reject) => {
            req.on('error', reject)
            req.on('response', (response_headers) => {
                var status = response_headers[':status']

                // For streaming responses, we need to provide a reader that
                // returns data as it arrives, not wait for 'end'
                var data_queue = []
                var data_resolve = null
                var ended = false

                req.on('data', chunk => {
                    if (data_resolve) {
                        data_resolve({ done: false, value: new Uint8Array(chunk) })
                        data_resolve = null
                    } else {
                        data_queue.push(chunk)
                    }
                })

                req.on('end', () => {
                    ended = true
                    if (data_resolve) {
                        data_resolve({ done: true, value: undefined })
                        data_resolve = null
                    }
                })

                // Create a fetch-like Response object
                var body = {
                    getReader: () => ({
                        read: async () => {
                            if (data_queue.length > 0) {
                                return { done: false, value: new Uint8Array(data_queue.shift()) }
                            }
                            if (ended) {
                                return { done: true, value: undefined }
                            }
                            return new Promise(resolve => {
                                data_resolve = resolve
                            })
                        }
                    })
                }
                var response = {
                    ok: status >= 200 && status < 300,
                    status,
                    headers: {
                        get: (name) => response_headers[name.toLowerCase()]
                    },
                    body,
                    text: async () => {
                        var chunks = []
                        var reader = body.getReader()
                        while (true) {
                            var { done, value } = await reader.read()
                            if (done) break
                            chunks.push(Buffer.from(value))
                        }
                        return Buffer.concat(chunks).toString()
                    },
                    json: async function() { return JSON.parse(await response.text()) }
                }
                resolve(response)
            })
        })
    }
}

// ============================================================================
// Console Test Mode (Node.js)
// ============================================================================

async function run_console_tests() {
    // Test tracking
    var total_tests = 0
    var passed_tests = 0
    var failed_tests = 0
    var skipped_tests = 0

    // Store tests to run sequentially
    var tests_to_run = []

    // Create wrapped fetch that points to localhost
    // Use HTTP/2 fetch for og_fetch since Node's native fetch uses HTTP/1.1
    // which doesn't support custom methods like MULTIPLEX
    var og_fetch = create_http2_fetch(`https://localhost:${port}`)
    var wrapped_fetch = async (url, options = {}) => {
        var full_url = url.startsWith('http') ? url : `https://localhost:${port}${url}`
        return braid_fetch(full_url, options)
    }
    // Expose set_fetch on wrapped_fetch so tests can call it
    wrapped_fetch.set_fetch = braid_fetch.set_fetch

    // Create a wrapped braid_fetch that handles relative URLs for Node.js
    var wrapped_braid_fetch = (url, options = {}) => {
        var full_url = url.startsWith('http') ? url : `https://localhost:${port}${url}`
        return braid_fetch(full_url, options)
    }
    // Copy properties from braid_fetch
    wrapped_braid_fetch.set_fetch = braid_fetch.set_fetch
    Object.defineProperty(wrapped_braid_fetch, 'enable_multiplex', {
        get: () => braid_fetch.enable_multiplex,
        set: (v) => { braid_fetch.enable_multiplex = v }
    })
    Object.defineProperty(wrapped_braid_fetch, 'reconnect_delay_ms', {
        get: () => braid_fetch.reconnect_delay_ms,
        set: (v) => { braid_fetch.reconnect_delay_ms = v }
    })

    // multiplex_fetch is imported from braid-http-client.js

    function add_section_header(header_text) {
        add_section_header.current_section = header_text
    }

    // In console mode, wait_for_tests queues a callback to run after all previous tests
    // We store it as a special entry in tests_to_run
    function wait_for_tests(cb) {
        tests_to_run.push({ is_wait_callback: true, callback: cb })
    }

    function run_test(test_name, test_function, expected_result) {
        // Apply filter if specified
        if (filter_arg && !test_name.toLowerCase().includes(filter_arg.toLowerCase())) {
            skipped_tests++
            return
        }

        total_tests++
        var section = add_section_header.current_section
        tests_to_run.push({ test_name, test_function, expected_result, section })
    }

    console.log('Starting braid-http tests...\n')

    // Start the servers
    var main_server = create_test_server()
    var express_server = create_express_middleware_server()
    var wrapper_server = create_wrapper_server()
    var wrapped_server = create_wrapped_server()

    await new Promise(resolve => main_server.listen(port, resolve))
    await new Promise(resolve => express_server.listen(port + 1, resolve))
    await new Promise(resolve => wrapper_server.listen(port + 2, resolve))
    await new Promise(resolve => wrapped_server.listen(port + 3, resolve))

    console.log(`Test server running on https://localhost:${port}`)

    // Define all tests
    // Note: tests.js manages braid_fetch.enable_multiplex itself
    define_tests(run_test, {
        fetch: wrapped_fetch,
        og_fetch,  // Already configured with base_url
        port,
        add_section_header,
        wait_for_tests,
        test_update: { ...test_update, status: "200" },
        multiplex_fetch,
        braid_fetch: wrapped_braid_fetch,
        reliable_update_channel,
        base_url: `https://localhost:${port}`  // For building expected values in tests
    })

    // Run tests sequentially
    var current_section = null
    for (var item of tests_to_run) {
        // Handle wait_for_tests callbacks
        if (item.is_wait_callback) {
            item.callback()
            continue
        }

        var { test_name, test_function, expected_result, section } = item
        if (section && section !== current_section) {
            current_section = section
            console.log(`\n--- ${section} ---`)
        }

        try {
            var timeout_ms = 10000
            var result = await Promise.race([
                test_function(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Test timed out after ${timeout_ms/1000}s`)), timeout_ms))
            ])
            if (result == expected_result) {
                passed_tests++
                console.log(`✓ ${test_name}`)
            } else if (result === 'old node version') {
                skipped_tests++
                console.log(`○ ${test_name} (skipped: old node version)`)
            } else {
                failed_tests++
                console.log(`✗ ${test_name}`)
                console.log(`  Expected: ${expected_result}`)
                console.log(`  Got: ${result}`)
            }
        } catch (error) {
            failed_tests++
            console.log(`✗ ${test_name}`)
            console.log(`  Error: ${error.message || error}`)
        }
    }

    // Print summary
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${total_tests} | ✓ : ${passed_tests} | ✗ : ${failed_tests} | Skipped: ${skipped_tests}`)
    console.log('='.repeat(50))

    // Close servers
    main_server.close()
    express_server.close()
    wrapper_server.close()
    wrapped_server.close()

    // Close all connections if available (Node 18.2+)
    if (typeof main_server.closeAllConnections === 'function') {
        main_server.closeAllConnections()
        express_server.closeAllConnections()
        wrapper_server.closeAllConnections()
        wrapped_server.closeAllConnections()
    }

    setTimeout(() => process.exit(failed_tests > 0 ? 1 : 0), 100)
}

// ============================================================================
// Browser Test Mode (Server)
// ============================================================================

async function run_browser_mode() {
    var main_server = create_test_server()
    var express_server = create_express_middleware_server()
    var wrapper_server = create_wrapper_server()
    var wrapped_server = create_wrapped_server()

    await new Promise(resolve => main_server.listen(port, resolve))
    await new Promise(resolve => express_server.listen(port + 1, resolve))
    await new Promise(resolve => wrapper_server.listen(port + 2, resolve))
    await new Promise(resolve => wrapped_server.listen(port + 3, resolve))

    console.log(`Test server running on https://localhost:${port}`)
    console.log(`Express middleware test server running on port ${port + 1}`)
    console.log(`Wrapper function test server running on port ${port + 2}`)
    var url = filter_arg
        ? `https://localhost:${port}/?filter=${encodeURIComponent(filter_arg)}`
        : `https://localhost:${port}/`
    console.log(`\nOpening ${url} in your browser...`)
    if (filter_arg) console.log(`Filter: ${filter_arg}`)

    // Auto-open browser
    var {exec} = require('child_process')
    var cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${url}"`)
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    if (mode === 'browser') {
        await run_browser_mode()
    } else {
        await run_console_tests()
    }
}

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
