// One simulated braid server — a "host".  We're testing pipes, so it holds no
// real state: it ACKs writes and pushes arbitrary updates to subscribers on a
// schedule.  Behavior is reconfigurable at runtime (per scenario) via
// configure().  CORS is wide open so the dashboard (another port) can reach it.

var http = require('http')
var {braidify} = require('../../braid-http-server.js')

function make_sim_server () {
    var config      = {urls: {}}     // {urls: {path: behavior}}, swapped by configure()
    var sockets     = new Set()      // every live TCP connection (for drops)
    var dropper     = null           // recurring outage timer
    var net_down    = false          // whole network forced down (internet outage)
    var host_down   = false          // this host forced down (host click)
    var fault_down  = false          // this host transiently down (flaky-host fault)
    var forced_urls = new Set()      // individual urls forced to fail (503)
    var version     = 0
    var is_down = () => net_down || host_down || fault_down   // independent sources

    var server = http.createServer((req, res) => {
        cors(res)
        if (req.method === 'OPTIONS') return res.end()
        // Down: hang ~250ms then cut — so a reconnect probe is visible failing.
        if (is_down()) return void setTimeout(() => req.socket.destroy(), 250)
        // A forced url answers 503: the client retries it (orange) without
        // taking the host down.
        if (forced_urls.has(req.url)) { res.statusCode = 503; return res.end() }

        braidify(req, res, async () => {
            var cfg = config.urls[req.url] || {subscribe: '209'}

            if (req.subscribe) {
                if (cfg.subscribe === 'poll') {              // no stream — a plain GET
                    var body = 'state ' + ++version
                    res.statusCode = 200
                    res.setHeader('version', JSON.stringify('v' + version))
                    res.setHeader('content-type', 'text/plain')
                    res.setHeader('content-length', Buffer.byteLength(body))  // res.update() needs it
                    return res.end(body)
                }
                if (cfg.subscribe_fail) {                    // refuse the first N subscribes
                    cfg._fails = (cfg._fails || 0) + 1
                    if (cfg._fails <= cfg.subscribe_fail.times) {
                        res.statusCode = cfg.subscribe_fail.status
                        return res.end()
                    }
                }
                if (typeof cfg.subscribe === 'number') {     // refuse with a status
                    res.statusCode = cfg.subscribe
                    return res.end()
                }
                var timer
                res.startSubscription({onClose: () => clearInterval(timer)})
                res.sendUpdate({version: ['v' + ++version], body: 'hello'})
                if (cfg.push) timer = setInterval(() =>
                    res.sendUpdate({version: ['v' + ++version], body: 'update ' + version}),
                    cfg.push * 1000)

            } else if (req.method === 'PUT') {
                await req.parseUpdate()                       // drain the body
                res.statusCode = cfg.put ?? 200
                res.end()
            } else if (req.method === 'DELETE') {
                res.statusCode = cfg.put ?? 200
                res.end()
            } else {
                res.statusCode = 404
                res.end()
            }
        })
    })

    // Track every TCP connection so an outage can cut them all (whatever the
    // client multiplexed onto them).
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

    // A "down" fault: every down_every seconds the host goes down for down_for
    // seconds — cut all connections and refuse new ones — so the client sits
    // red until it recovers and reconnects.
    function configure (host_config) {
        config.urls = host_config.urls || {}
        clearInterval(dropper); dropper = null
        net_down = host_down = fault_down = false
        forced_urls.clear()
        var f = host_config.fault
        if (f && f.down_every)
            dropper = setInterval(() => {
                fault_down = true
                sockets.forEach(s => s.destroy())
                setTimeout(() => { fault_down = false }, (f.down_for ?? 2) * 1000)
            }, f.down_every * 1000)
    }

    // External fault control.  Network and host forces are independent, so
    // releasing one doesn't revive the other.
    function set_net  (v) { net_down  = v; if (v) sockets.forEach(s => s.destroy()) }
    function set_host (v) { host_down = v; if (v) sockets.forEach(s => s.destroy()) }
    function set_url  (path, v) { v ? forced_urls.add(path) : forced_urls.delete(path) }

    return {server, configure, set_net, set_host, set_url}
}

function cors (res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Expose-Headers', '*')
}

module.exports = {make_sim_server}
