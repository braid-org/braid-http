#!/usr/bin/env node

// Multiplex buffering stress test.
//
// Serves an HTML page that tests multiple multiplex_wait values,
// measuring 424 rate (server-side) and latency (client-side).
//
// Usage:
//   node test/multiplex-stress-test.js
//
// Then open https://localhost:9100 in your browser.

var fs = require('fs')
var path = require('path')
var {braidify, free_cors} = require('../braid-http-server.js')

// --- Stats tracking ---
var stats = { count_424: 0, count_293: 0, total_mux_requests: 0 }

function reset_stats() {
    stats.count_424 = 0
    stats.count_293 = 0
    stats.total_mux_requests = 0
}

// --- Request handler ---
function handler(req, res) {
    free_cors(res)
    if (req.method === 'OPTIONS') return res.end()
    if (req.is_multiplexer) return

    var url = new URL(req.url, 'https://localhost')

    if (url.pathname === '/' || url.pathname === '/multiplex-stress-test.html') {
        res.writeHead(200, {'Content-Type': 'text/html'})
        return res.end(fs.readFileSync(path.join(__dirname, 'multiplex-stress-test.html')))
    }

    if (url.pathname === '/braid-http-client.js') {
        res.writeHead(200, {'Content-Type': 'application/javascript'})
        return res.end(fs.readFileSync(path.join(__dirname, '..', 'braid-http-client.js')))
    }

    if (url.pathname === '/config') {
        var wait = parseInt(url.searchParams.get('wait'))
        if (!isNaN(wait)) braidify.multiplex_wait = wait
        console.log('Config: multiplex_wait =', braidify.multiplex_wait + 'ms')
        res.writeHead(200, {'Content-Type': 'application/json'})
        return res.end(JSON.stringify({ multiplex_wait: braidify.multiplex_wait }))
    }

    if (url.pathname === '/stats') {
        console.log('Stats:', JSON.stringify(stats))
        res.writeHead(200, {'Content-Type': 'application/json'})
        return res.end(JSON.stringify(stats))
    }

    if (url.pathname === '/reset') {
        reset_stats()
        res.writeHead(200, {'Content-Type': 'application/json'})
        return res.end(JSON.stringify({ ok: true }))
    }

    if (url.pathname === '/test') {
        res.setHeader('Content-Type', 'application/json')
        if (req.subscribe)
            res.startSubscription()
        res.sendUpdate({
            version: ['v1'],
            body: JSON.stringify({hello: 'world'})
        })
        if (!req.subscribe)
            res.end()
        return
    }

    res.writeHead(404)
    res.end('not found')
}

// --- Server setup ---
// Wrap braidify, but intercept writeHead to count 424s and 293s
var braidified_handler = braidify(handler)

var server = require('http').createServer((req, res) => {
    // Track Multiplex-Through requests
    if (req.headers['multiplex-through']) {
        stats.total_mux_requests++

        var orig_writeHead = res.writeHead.bind(res)
        res.writeHead = function(status, ...args) {
            if (status === 424) stats.count_424++
            if (status === 293) stats.count_293++
            return orig_writeHead(status, ...args)
        }
    }

    braidified_handler(req, res)
})

var port = 9100
server.listen(port, () => {
    console.log(`Multiplex stress test: http://localhost:${port}`)
    console.log(`Default multiplex_wait: ${braidify.multiplex_wait}ms`)
})
