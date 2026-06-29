// The server simulator.  Serves the dashboard at / and the client lib, and
// stands up a fleet of simulated braid hosts on their own ports (a port is
// part of the HTTP host, so each port is a distinct host to the client).
//
//   node test/update-pipes/run-sim.js   →   open http://localhost:8000

var http = require('http')
var fs   = require('fs')
var path = require('path')
var {make_sim_server} = require('./sim-server.js')
function load_scenarios () {        // re-read fresh, so scenario edits need no restart
    delete require.cache[require.resolve('./scenarios.js')]
    return require('./scenarios.js')
}
var scenarios = load_scenarios()

var DASHBOARD_PORT = 8000
var HOST_BASE_PORT = 8001
var MAX_HOSTS      = 5

// Stand up a pool of simulated hosts; configure_scenario() points them at a
// scenario's behavior (and is re-run whenever the dashboard selects one).
var sims = [], origins = []
for (var h = 0; h < MAX_HOSTS; h++) {
    var sim = make_sim_server()
    sim.server.listen(HOST_BASE_PORT + h)
    sims.push(sim)
    origins.push(`http://localhost:${HOST_BASE_PORT + h}`)
}

function configure_scenario (name) {
    var sc = scenarios[name]
    for (var h = 0; h < MAX_HOSTS; h++) {
        var urls = {}
        if (sc && h < sc.hosts)
            for (var u of sc.urls) if (u.host === h)
                urls[u.path] = {subscribe: u.subscribe, push: u.push, put: u.put,
                                subscribe_fail: u.subscribe_fail}
        sims[h].configure({urls, fault: sc && sc.fault && sc.fault[h]})
    }
}
configure_scenario('happy')

var files = {
    '/':                     ['dashboard/index.html',      'text/html'],
    '/dashboard.js':         ['dashboard/dashboard.js',    'text/javascript'],
    '/scenarios.js':         ['scenarios.js',              'text/javascript'],
    '/braid-http-client.js': ['../../braid-http-client.js','text/javascript'],
}
http.createServer((req, res) => {
    var pathname = req.url.split('?')[0]
    // Configure the sim for a scenario and hand back its host origins.
    if (pathname === '/scenario' && req.method === 'POST') {
        var body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
            scenarios = load_scenarios()        // pick up any scenario edits
            var name = JSON.parse(body || '{}').name
            if (scenarios[name]) configure_scenario(name)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({origins: origins.slice(0, scenarios[name]?.hosts ?? 0)}))
        })
        return
    }
    // Inject a fault: {internet} cuts everything, {host, down} cuts one host,
    // {host, path, down} forces one url to 503.
    if (pathname === '/inject' && req.method === 'POST') {
        var body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
            var b = JSON.parse(body || '{}')
            if ('internet' in b)                           sims.forEach(s => s.set_net(b.internet))
            else if (typeof b.host === 'number' && b.path) sims[b.host]?.set_url(b.path, b.down)
            else if (typeof b.host === 'number')           sims[b.host]?.set_host(b.down)
            res.end('{}')
        })
        return
    }
    var f = files[pathname]
    if (!f) { res.statusCode = 404; return res.end() }
    res.setHeader('content-type', f[1])
    fs.createReadStream(path.join(__dirname, f[0])).pipe(res)
}).listen(DASHBOARD_PORT, () =>
    console.log(`dashboard:  http://localhost:${DASHBOARD_PORT}\n`))
