// Scenarios shared by the server-sim (node) and the dashboard (browser).
//
// We test PIPES, not state.  The server pushes arbitrary updates (a version
// counter) and just ACKs writes — it never echoes the client's own sets back
// (a real braid server dedups the sender by its `peer` header).  So a URL can
// be read-only (server pushes, client subscribes), write-only (client writes,
// server ACKs), or both.
//
// Each scenario:
//   hosts        — how many simulated hosts (ports) it uses
//   urls[]       — per-URL: {host, path, get, set, and server behavior}
//                  server behavior: subscribe '209'|'poll'|status,
//                  push (secs between server updates), put (ack status),
//                  subscribe_fail {status, times} (refuse the first N subscribes)
//   fault        — per-host faults, e.g. {0: {drop_every: 6}}
//   pipe_options — passed straight into update_pipe (set the clock)
//   window       — timeline width in ms
//   run(pipe, urls) — the client-side script

// hosts × per urls.  Each host serves a mix of read-only, read-write and
// write-only routes.  The last host is polling-only (no 209 subscriptions);
// the rest have real subscriptions.
function mixed_grid (hosts, per) {
    var combo = [
        {get: true,  set: false},   // read-only
        {get: true,  set: true},    // read-write
        {get: false, set: true},    // write-only
    ]
    var a = []
    for (var h = 0; h < hosts; h++) {
        var polling = h === hosts - 1
        for (var i = 0; i < per; i++) {
            var c = combo[(i + h) % 3]              // offset per host so they differ
            var u = {host: h, path: '/' + i}
            if (c.get) { u.get = true; u.subscribe = polling ? 'poll' : '209'; if (!polling) u.push = 2 + i % 3 }
            if (c.set) { u.set = true; u.put = 200 }
            a.push(u)
        }
    }
    return a
}

var scenarios = {
    throttle: {
        name: 'Reconnection throttling — 25 urls / 5 hosts',
        blurb: 'Reconnecting without a thundering herd.',
        hosts: 5,
        window: 30000,
        pipe_options: {timeout: 5, reconnect_interval: 0.5, poll_interval: 4},
        urls: mixed_grid(5, 5),
        run (pipe, urls) {
            for (var u of urls) if (u.get) pipe.get(u.url)
            var tick = 0
            setInterval(() => {                       // keep the writers writing (slower when offline)
                tick++
                for (var u of urls) if (u.set) {
                    var host = pipe.network.hosts[new URL(u.url).host]
                    if ((host && host.online) || tick % 4 === 0)   // offline: write 1/4 as often
                        pipe.set(u.url, {version: ['v' + Date.now()], body: 'edit'})
                }
            }, 3000)
            var inject = (b) => fetch('/inject', {
                method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)
            })
            var at = (ms, b) => setTimeout(() => inject(b), ms)
            function cycle () {
                at(3000,  {host: 2, down: true})    // one host drops…
                at(6500,  {host: 2, down: false})   // …the poll brings it back
                at(9000,  {internet: true})         // the whole internet drops…
                at(16000, {internet: false})        // …the poll round-robins it back
            }
            cycle()
            setInterval(cycle, 19000)               // loop the story
        }
    },

    routes: {
        name: '30 routes',
        blurb: 'Click any dot to force it offline.',
        hosts: 5,
        window: 30000,
        pipe_options: {timeout: 5, reconnect_interval: 0.5, poll_interval: 4},
        urls: mixed_grid(5, 6),
        run (pipe, urls) {
            for (var u of urls) if (u.get) pipe.get(u.url)
            var tick = 0
            setInterval(() => {                       // keep the writers writing (slower when offline)
                tick++
                for (var u of urls) if (u.set) {
                    var host = pipe.network.hosts[new URL(u.url).host]
                    if ((host && host.online) || tick % 4 === 0)   // offline: write 1/4 as often
                        pipe.set(u.url, {version: ['v' + Date.now()], body: 'edit'})
                }
            }, 3000)
        }
    },

    happy: {
        name: 'Happy path',
        blurb: 'Two hosts; read-only, write-only, and read-write URLs all healthy.',
        hosts: 2,
        urls: [
            {host: 0, path: '/read',  get: true,  set: false, subscribe: '209', push: 2},
            {host: 0, path: '/write', get: false, set: true,  put: 200},
            {host: 0, path: '/both',  get: true,  set: true,  subscribe: '209', push: 4, put: 200},
            {host: 1, path: '/read',  get: true,  set: false, subscribe: '209', push: 3},
        ],
        run (pipe, urls) {
            for (var u of urls) if (u.get) pipe.get(u.url)
            return setInterval(() => {
                for (var u of urls) if (u.set)
                    pipe.set(u.url, {version: ['v' + Date.now()], body: 'edit'})
            }, 2500)
        }
    },

    poll: {
        name: 'Polling fallback',
        blurb: 'A server with no 209 subscriptions. We poll it, so it stays orange.',
        hosts: 1,
        window: 60000,
        pipe_options: {poll_interval: 4},
        urls: [
            {host: 0, path: '/poll', get: true, subscribe: 'poll'},
            {host: 0, path: '/read', get: true, subscribe: '209', push: 2},
        ],
        run (pipe, urls) { for (var u of urls) if (u.get) pipe.get(u.url) }
    },

    flaky_host: {
        name: 'Flaky host (outage & reconnect)',
        blurb: 'The host goes down for about 3 seconds every 8.',
        hosts: 1,
        window: 30000,
        pipe_options: {timeout: 5, reconnect_interval: 1},
        fault: {0: {down_every: 8, down_for: 3}},
        urls: [
            {host: 0, path: '/a', get: true, subscribe: '209', push: 2},
            {host: 0, path: '/b', get: true, subscribe: '209', push: 3},
        ],
        run (pipe, urls) { for (var u of urls) if (u.get) pipe.get(u.url) }
    },

    retry: {
        name: 'Refused, then connects',
        blurb: 'The subscribe is refused with a 503 a few times before it succeeds.',
        hosts: 1,
        window: 30000,
        pipe_options: {reconnect_interval: 2},
        urls: [
            {host: 0, path: '/slow', get: true, subscribe: '209', subscribe_fail: {status: 503, times: 3}, push: 2},
        ],
        run (pipe, urls) { for (var u of urls) if (u.get) pipe.get(u.url) }
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = scenarios
