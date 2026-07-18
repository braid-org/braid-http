#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
var fs = require('fs')
var path = require('path')
var define_tests = require('./tests.js')

// The server library keeps enable_multiplex as state on the module instance,
// so to get both a multiplexing and a non-multiplexing braidify, we require
// it twice, busting the require cache in between for a fresh second instance
var {braidify, free_cors} = require('../braid-http-server.js')
delete require.cache[require.resolve('../braid-http-server.js')]
var {braidify: braidify_no_mux} = require('../braid-http-server.js')
braidify_no_mux.enable_multiplex = false

var {fetch: braid_fetch, http, multiplex_fetch,
     reliable_update_channel, http_bus} = require('../braid-http-client.js')
var https = http(require('https'))   // node's https module, braidified

// Parse command line arguments
var args = process.argv.slice(2)
var mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
var filter_arg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
    || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]
var show_hangs = args.includes('--hangs') && require('./show-hangs.js')

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test/test.js [options]

Options:
  --browser, -b          Start server for browser testing (default: console mode)
  --filter=PATTERN       Only run tests matching pattern (case-insensitive)
  --grep=PATTERN         Alias for --filter
  --port=N               Base port (uses N, N+1, N+2, N+3, N+4). Default 9000. Or set PORT env.
  --hangs                When a test times out, print the still-pending promises
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

process.on("unhandledRejection", (x) =>
    console.log(`unhandledRejection: ${x?.stack || x}`)
)
process.on("uncaughtException", (x) =>
    console.log(`uncaughtException: ${x.stack}`)
)

// ============================================================================
// Test Server
// ============================================================================

// Reads a request body of the form {handler: "<source of a
// (req, res, ...args) => {...} function>", args}, evals the handler source,
// and hands {fn, args} to cb. This is how tests register their own handlers
// on our servers, on the fly. The args are JSON-serialized values the test
// wants passed to the handler after (req, res) on each request -- handy
// because the handler runs server-side, so it can't close over test-side
// variables. (The eval happens at module scope, so handler source can still
// use test.js globals like braidify, port, ...)
function read_posted_handler(req, cb) {
    var chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
        var { handler, args } = JSON.parse(Buffer.concat(chunks).toString())
        cb({ fn: eval('(' + handler + ')'), args })
    })
}

// A registry of handlers that tests have added to a server on the fly: POST a
// handler to /add-handler (in the format read_posted_handler expects), and we
// mount it at a fresh path and return that path for the test to hit. Each
// server makes its own registry, and calls handle() on incoming requests --
// it returns true if it consumed the request (registering a new handler, or
// running a mounted one).
function create_added_handlers() {
    var handlers = new Map()
    return {
        handle(req, res) {
            if (req.url === '/add-handler' && req.method === 'POST') {
                read_posted_handler(req, entry => {
                    var path = '/added-handler/' + Math.random().toString(36).slice(2)
                    handlers.set(path, entry)
                    res.end(path)
                })
                return true
            }
            var entry = handlers.get(req.url.split('?')[0])
            if (entry) {
                entry.fn(req, res, ...entry.args)
                return true
            }
        }
    }
}

function create_test_server() {
    var added_handlers = create_added_handlers()
    var pre_braidify_handlers = []
    var server = require('http2').createSecureServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem')),
        allowHTTP1: true
    }, async (req, res) => {
        console.log('Request:', req.url, req.method)

        // Lets tests register a handler that runs *before* braidify (and before
        // the magic multiplex routes below), on every request, so it can
        // intercept things braidify would otherwise consume -- e.g. MULTIPLEX
        // and /.well-known/multiplexer/ requests. POST a handler in the format
        // read_posted_handler expects; it should return true if it handled the
        // response (so we stop processing this request).
        if (req.url === '/add-pre-braidify-handler' && req.method === 'POST')
            return read_posted_handler(req, entry => {
                pre_braidify_handlers.push(entry)
                res.end('ok')
            })
        for (var { fn, args } of pre_braidify_handlers)
            if (fn(req, res, ...args)) return

        // MULTIPLEX
        var is_mux = req.method === 'MULTIPLEX' || req.url.startsWith('/.well-known/multiplexer/')

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

        // Braidifies our server
        braidify(req, res)
        if (req.is_multiplexer) return

        if (req.url.startsWith('/eval') && req.method === 'POST')
            if ((await eval_func()) !== 'keep going') return

        // MULTIPLEX
        if (is_mux) res.end('hm..')

        // Lets tests register their own handlers on the fly, and serves the
        // handlers they've registered (see create_added_handlers above)
        if (added_handlers.handle(req, res)) return

        // Static routes for browser mode: the test page and the files it loads
        var pathname = req.url.split('?')[0]
        if (pathname === '/' || pathname === '/client.html')
            res.end(fs.readFileSync(path.join(__dirname, 'client.html')))
        else if (req.url === '/braid-http-client.js')
            res.end(fs.readFileSync(path.join(__dirname, '..', 'braid-http-client.js')))
        else if (req.url === '/tests.js')
            res.end(fs.readFileSync(path.join(__dirname, 'tests.js')))
    })

    return server
}

function create_express_middleware_server() {
    var express_app = require("express")()


    express_app.use(braidify)

    express_app.use((req, res, next) => {
        free_cors(res)
        if (req.method === 'OPTIONS') return res.end('')
        next()
    })

    // Lets tests register their own express handlers on the fly, and serves
    // the handlers they've registered (see create_added_handlers above)
    var added_handlers = create_added_handlers()
    express_app.use((req, res, next) => {
        if (!added_handlers.handle(req, res)) next()
    })

    return https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    }, express_app)
}

function create_wrapper_server() {
    var added_handlers = create_added_handlers()
    return https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    }, braidify(async (req, res) => {
        if (mode === 'browser') console.log('Wrapped-Handler-Request:', req.url, req.method)

        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        // Lets tests register their own handlers on the fly, and serves the
        // handlers they've registered (see create_added_handlers above)
        if (added_handlers.handle(req, res)) return

        res.writeHead(404)
        res.end('Not found')
    }))
}

// Server using the new braidify.server() entry point (attaches to an
// existing http.Server, intercepts 'request' events).  Listens on port+3.
function create_wrapped_server() {
    var added_handlers = create_added_handlers()
    var server = https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem'))
    })

    braidify.server(server)

    server.on('request', (req, res) => {
        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        // Lets tests register their own handlers on the fly, and serves the
        // handlers they've registered (see create_added_handlers above)
        if (added_handlers.handle(req, res)) return

        res.writeHead(404)
        res.end('Not found')
    })

    return server
}

function create_no_mux_server() {
    var added_handlers = create_added_handlers()
    var server = require('http2').createSecureServer({
        key: fs.readFileSync(path.join(__dirname, 'localhost-privkey.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem')),
        allowHTTP1: true
    }, async (req, res) => {
        free_cors(res)
        if (req.method === 'OPTIONS') return res.end()

        braidify_no_mux(req, res)

        // Lets tests register their own handlers on the fly, and serves the
        // handlers they've registered (see create_added_handlers above)
        if (added_handlers.handle(req, res)) return

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
    var failed_test_names = []
    var hung_test = false

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
    Object.defineProperty(wrapped_braid_fetch, 'subscription_counts', {
        get: () => braid_fetch.subscription_counts
    })

    // multiplex_fetch is imported from braid-http-client.js

    function add_section_header(header_text) {
        add_section_header.current_section = header_text
    }

    function assert(condition, message) {
        if (!condition) throw new Error(message || 'Assertion failed')
    }

    function run_test(test_name, test_function, expected_result, params) {
        // Apply filter if specified
        if (filter_arg && !test_name.toLowerCase().includes(filter_arg.toLowerCase())) {
            skipped_tests++
            return
        }

        total_tests++
        var section = add_section_header.current_section
        tests_to_run.push({ test_name, test_function, expected_result, section, ...params })
    }

    console.log('Starting braid-http tests...\n')

    // Start the servers
    var main_server = create_test_server()
    var express_server = create_express_middleware_server()
    var wrapper_server = create_wrapper_server()
    var wrapped_server = create_wrapped_server()
    var no_mux_server = create_no_mux_server()

    await new Promise(resolve => main_server.listen(port, 'localhost', resolve))
    await new Promise(resolve => express_server.listen(port + 1, 'localhost', resolve))
    await new Promise(resolve => wrapper_server.listen(port + 2, 'localhost', resolve))
    await new Promise(resolve => wrapped_server.listen(port + 3, 'localhost', resolve))
    await new Promise(resolve => no_mux_server.listen(port + 4, 'localhost', resolve))

    console.log(`Test server running on https://localhost:${port}`)

    // Define all tests
    // Note: tests.js manages braid_fetch.enable_multiplex itself
    define_tests(run_test, {
        fetch: wrapped_fetch,
        og_fetch,  // Already configured with base_url
        port,
        add_section_header,
        multiplex_fetch,
        braid_fetch: wrapped_braid_fetch,
        reliable_update_channel,
        http_bus,
        base_url: `https://localhost:${port}`,  // For building expected values in tests
        assert
    })

    // Run tests sequentially
    var current_section = null
    for (var item of tests_to_run) {
        var { test_name, test_function, expected_result, section,
              timeout = 2000 } = item
        if (section && section !== current_section) {
            current_section = section
            console.log(`\n--- ${section} ---`)
        }

        try {
            var timer = null
            var timed_out = new Promise((_, reject) =>
                timer = setTimeout(() => {
                    hung_test = true
                    if (show_hangs) show_hangs.show()
                    reject(new Error(`Test timed out after ${timeout/1000}s`))
                }, timeout))

            // mark() after creating the timeout promise, so it doesn't
            // itself appear in the report of the test's hung promises
            if (show_hangs) show_hangs.mark()

            var result = await Promise.race([test_function(), timed_out])
            if (expected_result === undefined) {
                // Assertion-style test: success simply means it returned
                // (without throwing). An assert() failure throws and is
                // handled by the catch below.
                passed_tests++
                console.log(`✓ ${test_name}`)
            } else if (result == expected_result) {
                passed_tests++
                console.log(`✓ ${test_name}`)
            } else if (result === 'old node version') {
                skipped_tests++
                console.log(`○ ${test_name} (skipped: old node version)`)
            } else {
                failed_tests++
                failed_test_names.push(test_name)
                console.log(`✗ ${test_name}`)
                console.log(`  Expected: ${expected_result}`)
                console.log(`  Got: ${result}`)
            }
        } catch (error) {
            failed_tests++
            failed_test_names.push(test_name)
            console.log(`✗ ${test_name}`)
            console.log(`  Error: ${error.message || error}`)
        } finally {
            // otherwise a passing test's timer fires 10s later, and with
            // --hangs would print a bogus report during a later test
            clearTimeout(timer)
        }
    }

    // Print summary
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${total_tests} | ✓ : ${passed_tests} | ✗ : ${failed_tests} | Skipped: ${skipped_tests}`)
    console.log('='.repeat(50))

    if (failed_test_names.length) {
        console.log('\nFailed tests:')
        for (var name of failed_test_names)
            console.log(`  ✗ ${name}`)

        // Guide the reader to the two debugging tools: narrowing the run
        // to one test, and (for hangs) the pending-promise report.
        // Nothing prints if this run already used both.
        var suggest_filter = !filter_arg
        var suggest_hangs = hung_test && !show_hangs
        if (suggest_filter || suggest_hangs) {
            console.log(`\nTo debug, rerun a failing test by itself:`)
            console.log(`  node test/test.js`
                + (hung_test ? ' --hangs' : '')
                + ` --filter='${filter_arg || failed_test_names[0]}'`)
            if (suggest_hangs)
                console.log(`  (--hangs prints what a hung test is stuck waiting on)`)
        }
    }

    // Close servers
    main_server.close()
    express_server.close()
    wrapper_server.close()
    wrapped_server.close()
    no_mux_server.close()

    // Close all connections if available (Node 18.2+)
    if (typeof main_server.closeAllConnections === 'function') {
        main_server.closeAllConnections()
        express_server.closeAllConnections()
        wrapper_server.closeAllConnections()
        wrapped_server.closeAllConnections()
        no_mux_server.closeAllConnections()
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
    var no_mux_server = create_no_mux_server()

    await new Promise(resolve => main_server.listen(port, 'localhost', resolve))
    await new Promise(resolve => express_server.listen(port + 1, 'localhost', resolve))
    await new Promise(resolve => wrapper_server.listen(port + 2, 'localhost', resolve))
    await new Promise(resolve => wrapped_server.listen(port + 3, 'localhost', resolve))
    await new Promise(resolve => no_mux_server.listen(port + 4, 'localhost', resolve))

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
