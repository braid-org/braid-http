#!/usr/bin/env node

// Test: multiplexed subscription onClose fires when multiplexer closes
//
// Bug: The multiplexer proxy forwards `_closed` from the original HTTP
// response to the fake multiplexed response (res2).  When the original
// socket closes after sending "293 Responded via multiplexer",
// res._closed=true leaks into res2._closed=true.  Later, when the
// multiplexer cleanup calls res2.destroy(), Node.js's emitCloseNT()
// sees _closed=true and skips emitting the 'close' event, so the
// subscription's onClose callback never fires.
//
// This only affects HTTP/1.1.  In HTTP/2, the original response uses
// a stream (not a raw socket), so the _closed leak doesn't occur.

var http = require('http')
var {braidify} = require('../braid-http-server.js')

var passed = 0
var failed = 0

async function run_test(name, fn) {
    try {
        await fn()
        passed++
        console.log(`✓ ${name}`)
    } catch (e) {
        failed++
        console.log(`✗ ${name}`)
        console.log(`  ${e.message}`)
    }
}

async function run_all() {
    var close_events = []

    var handler = (req, res) => {
        if (req.url === '/test-resource') {
            res.startSubscription({
                onClose: () => close_events.push(Date.now())
            })
            res.write('data: hello\r\n\r\n')
        }
    }

    var server = http.createServer(braidify(handler))
    await new Promise(r => server.listen(0, r))
    var port = server.address().port
    var origin = `http://127.0.0.1:${port}`

    // ==================================================================
    // Test 1: Non-multiplexed subscription — abort fires onClose
    // ==================================================================
    await run_test(
        'direct subscription: onClose fires on abort',
        async () => {
            close_events = []
            var ac = new AbortController()
            await fetch(`${origin}/test-resource`, {
                headers: { Subscribe: 'true' },
                signal: ac.signal,
            })
            await sleep(100)
            ac.abort()
            await sleep(500)
            if (close_events.length !== 1)
                throw new Error(`expected 1 onClose, got ${close_events.length}`)
        }
    )

    // ==================================================================
    // Test 2: Multiplexed subscription — kill multiplexer fires onClose
    // ==================================================================
    await run_test(
        'multiplexed subscription: onClose fires when multiplexer is killed',
        async () => {
            close_events = []

            // Create multiplexer
            var mux_id = 'mux-' + Math.random().toString(36).slice(2)
            var {req: mux_req} = await new Promise((resolve, reject) => {
                var req = http.request({
                    hostname: '127.0.0.1', port,
                    path: `/.well-known/multiplexer/${mux_id}`,
                    method: 'POST',
                    headers: { 'Multiplex-Version': '1.0' },
                }, res => resolve({res, req}))
                req.on('error', reject)
                req.end()
            })

            // Subscribe through multiplexer
            var req_id = 'req-' + Math.random().toString(36).slice(2)
            await new Promise((resolve, reject) => {
                var req = http.request({
                    hostname: '127.0.0.1', port,
                    path: '/test-resource',
                    method: 'GET',
                    headers: {
                        Subscribe: 'true',
                        'Multiplex-Through':
                            `/.well-known/multiplexer/${mux_id}/${req_id}`,
                        'Multiplex-Version': '1.0',
                    },
                }, res => resolve(res))
                req.on('error', reject)
                req.end()
            })
            await sleep(200)

            // Kill multiplexer by destroying its socket
            mux_req.socket.destroy()
            await sleep(500)

            if (close_events.length !== 1)
                throw new Error(`expected 1 onClose, got ${close_events.length}`)
        }
    )

    // ==================================================================
    // Test 3: Multiplexed subscription — server-side kill fires onClose
    // ==================================================================
    await run_test(
        'multiplexed subscription: onClose fires when server ends multiplexer',
        async () => {
            close_events = []

            var mux_id = 'mux-' + Math.random().toString(36).slice(2)
            await new Promise((resolve, reject) => {
                var req = http.request({
                    hostname: '127.0.0.1', port,
                    path: `/.well-known/multiplexer/${mux_id}`,
                    method: 'POST',
                    headers: { 'Multiplex-Version': '1.0' },
                }, res => resolve(res))
                req.on('error', reject)
                req.end()
            })

            var req_id = 'req-' + Math.random().toString(36).slice(2)
            await new Promise((resolve, reject) => {
                var req = http.request({
                    hostname: '127.0.0.1', port,
                    path: '/test-resource',
                    method: 'GET',
                    headers: {
                        Subscribe: 'true',
                        'Multiplex-Through':
                            `/.well-known/multiplexer/${mux_id}/${req_id}`,
                        'Multiplex-Version': '1.0',
                    },
                }, res => resolve(res))
                req.on('error', reject)
                req.end()
            })
            await sleep(200)

            // Kill multiplexer from the server side (simulates server shutdown)
            var m = braidify.multiplexers?.get(mux_id)
            if (!m) throw new Error('multiplexer not found on server')
            m.res.destroy()
            await sleep(500)

            if (close_events.length !== 1)
                throw new Error(`expected 1 onClose, got ${close_events.length}`)
        }
    )

    // ==================================================================
    // Summary
    // ==================================================================
    console.log()
    console.log(`Total: ${passed + failed} | ✓ : ${passed} | ✗ : ${failed}`)

    server.close()
    process.exit(failed > 0 ? 1 : 0)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
run_all().catch(e => { console.error(e); process.exit(1) })
