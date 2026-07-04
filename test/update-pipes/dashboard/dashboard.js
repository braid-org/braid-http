// The dashboard: run the selected scenario's pipe against the simulated hosts
// and show, per row (network / host / URL), an online dot plus a scrolling
// timeline — a state "ribbon" (green online · light-green connecting · cyan
// probing · orange maybe/retrying · blank offline), a faint time ruler ticked
// at the timeout interval, and arrows for traffic: ↓ forestgreen incoming
// updates; ↑ blue outgoing edits, hollow when issued and solid when acked (red
// outline if the write gives up); red bars for GET errors.
// State is read live from pipe.network each frame; traffic from the cb / set.

;(async () => {
    var host_of = (url) => new URL(url).host

    var name      = new URLSearchParams(location.search).get('scenario') || 'happy'
    var scenario  = scenarios[name] || scenarios.happy
    var WINDOW    = scenario.window ?? 90000
    var TIMEOUT   = (scenario.pipe_options?.timeout ?? 30) * 1000   // ruler interval

    // ── Scenario selector ────────────────────────────────────
    var sel = document.getElementById('scenario')
    for (var key in scenarios) {
        var opt = document.createElement('option')
        opt.value = key; opt.textContent = scenarios[key].name
        if (key === name) opt.selected = true
        sel.appendChild(opt)
    }
    sel.onchange = () => { location.search = '?scenario=' + sel.value }
    document.getElementById('blurb').textContent = scenario.blurb

    // Configure the server for this scenario; get its host origins back.
    var {origins} = await (await fetch('/scenario', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({name})
    })).json()
    var urls = scenario.urls.map(u => ({...u, url: origins[u.host] + u.path}))

    // ── State derivation (pipe.network → a state string per row) ──
    var online_state = (v) => v === true ? 'online' : v === 'maybe' ? 'maybe' : 'offline'
    function any_put_inflight (r) {
        for (var p of r.put_queue) if (p.aborter) return true
        return false
    }
    function any_put_retrying (r) {
        for (var p of r.put_queue) if (p.retry_timer) return true
        return false
    }
    function url_state (net, url) {
        var h = net.hosts[host_of(url)]
        if (!h) return online_state(net.online)
        var r = h.urls[url], sub = r && r.subscription
        if (sub && h.online_subs.has(sub)) return 'online'
        if (h.online === false && ((sub && sub.aborter) || (r && any_put_inflight(r))))
            return 'probing'                                  // a reconnect probe (sub or put)
        if (sub && sub.retry_timer) return 'maybe'            // retrying
        if (sub && sub.aborter)     return 'connecting'       // sent, no 209 yet
        if (r && any_put_retrying(r)) return 'maybe'          // write-only: a put is retrying (forced 503)
        return online_state(h.online)                         // else reflect the host's pipe
    }
    function host_role (hurls) {
        if (hurls.every(u => u.subscribe === 'poll')) return 'polling'
        if (hurls.every(u => u.set && !u.get))        return 'write-only'
        if (hurls.some(u => u.set))                   return 'read-write'
        return 'read-only'
    }
    var COLOR = {
        online:'rgba(46,204,64,.32)', connecting:'rgba(46,204,64,.16)',
        probing:'rgba(0,200,255,.95)',
        maybe:'rgba(255,149,0,.38)', offline:'rgba(0,0,0,0)', idle:'rgba(0,0,0,.04)'
    }
    var DOT = {online:'true', connecting:'maybe', probing:'probe', maybe:'maybe', offline:'false', idle:''}

    // Click-to-force: pin a dot off.  `forced` holds the keys we've pinned;
    // the server enforces it (cut host/network, or 503 a url).
    var forced = new Set()
    async function force (key, bodyFn, url) {
        var down = !forced.has(key)
        down ? forced.add(key) : forced.delete(key)
        await fetch('/inject', {method: 'POST', headers: {'content-type': 'application/json'},
                                body: JSON.stringify(bodyFn(down))})
        if (url) { pipe.forget(url); pipe.get(url) }   // re-subscribe to pick up the new state
    }

    // ── Build rows ───────────────────────────────────────────
    var rows = [], rowByUrl = {}
    var rowsEl = document.getElementById('rows')
    function add_row (kind, label, name, role, stateFn) {
        var el = document.createElement('div')
        el.className = 'row ' + kind
        el.innerHTML = `<span class="label"><span class="dot"></span> ${label}`
                     + (role ? ` <span class="tag">${role}</span>` : '') + `</span>`
        var canvas = document.createElement('canvas')
        el.appendChild(canvas)
        rowsEl.appendChild(el)
        var row = {kind, name, dot: el.querySelector('.dot'), canvas, ctx: canvas.getContext('2d'),
                   stateFn, transitions: [], events: []}
        rows.push(row)
        return row
    }
    var netRow = add_row('net', 'network', 'network', '', (net) => online_state(net.online))
    netRow.forceKey = 'network'
    netRow.dot.onclick = () => force('network', d => ({internet: d}))
    origins.forEach((origin, h) => {
        var hn = host_of(origin)
        var hurls = urls.filter(u => u.host === h)
        var hostRow = add_row('host', hn, hn, host_role(hurls), (net) => online_state((net.hosts[hn] || net).online))
        hostRow.forceKey = 'host:' + h
        hostRow.dot.onclick = () => force('host:' + h, d => ({host: h, down: d}))
        hurls.forEach(u => {
            var tag = u.subscribe === 'poll' ? 'poll'
                    : [u.get && 'get', u.set && 'set'].filter(Boolean).join('+')
            var urlRow = add_row('url', u.path, u.url.replace(/^https?:\/\//, ''), tag,
                                 (net) => url_state(net, u.url))
            urlRow.forceKey = u.url
            urlRow.dot.onclick = () => force(u.url, d => ({host: h, path: u.path, down: d}), u.get && u.url)
            rowByUrl[u.url] = urlRow
        })
    })

    // ── Pipe + traffic capture ───────────────────────────────
    function log (msg) {
        var el = document.getElementById('log')
        el.textContent += (performance.now() / 1000).toFixed(1).padStart(6) + 's  ' + msg + '\n'
        el.scrollTop = el.scrollHeight
    }
    var pipe = update_pipe((m) => {
        var row = rowByUrl[m.url]
        if (m.type === 'set' || m.type === 'delete')
            row?.events.push({t: performance.now(), type: 'in'})   // incoming: ↓, timeline only
        else if (m.type === 'ack')                             // write landed → solid ↑ at ack time
            row?.events.push({t: performance.now(), type: 'out', status: 'acked'})
        else if (m.type === 'error') {
            if (m.method === 'GET')
                row?.events.push({t: performance.now(), type: 'error'})
            else                                                  // write gave up → red ↑ at fail time
                row?.events.push({t: performance.now(), type: 'out', status: 'error'})
            log('error ' + m.method + ' ' + m.url.replace(/^https?:\/\//, '') + ' ' + (m.description))
        }
    }, scenario.pipe_options || {})

    // A write draws two marks at their real times: a hollow ↑ when issued, then
    // a separate solid ↑ when its ack lands — the gap between them is the latency.
    function mark_write (url) {
        rowByUrl[url]?.events.push({t: performance.now(), type: 'out', status: 'pending'})
    }
    var realSet = pipe.set.bind(pipe)
    pipe.set = (url, update) => { mark_write(url); return realSet(url, update) }
    var realDel = pipe.delete.bind(pipe)
    pipe.delete = (url, params) => { mark_write(url); return realDel(url, params) }

    scenario.run(pipe, urls)

    // ── Render ───────────────────────────────────────────────
    function sample (row, state, now) {
        var last = row.transitions[row.transitions.length - 1]
        var changed = !last || last.state !== state
        if (changed) row.transitions.push({t: now, state})
        var cutoff = now - WINDOW * 2
        while (row.transitions.length > 1 && row.transitions[1].t < cutoff) row.transitions.shift()
        while (row.events.length && row.events[0].t < cutoff) row.events.shift()
        return changed
    }
    // Log the connection lifecycle (not the data updates): drops, probes, recoveries.
    function log_event (row, state) {
        if (row.kind === 'net')        log('NETWORK ' + state)
        else if (row.kind === 'host')  log('host ' + row.name + ' ' + state)
        else if (state === 'probing')  log('  probe ' + row.name)
    }
    function tri (ctx, ex, cy, dir, color, filled) {  // dir: -1 up, +1 down; filled=false → hollow
        ctx.beginPath()
        ctx.moveTo(ex, cy + dir * 5); ctx.lineTo(ex - 3, cy); ctx.lineTo(ex + 3, cy)
        ctx.closePath()
        if (filled === false) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke() }
        else { ctx.fillStyle = color; ctx.fill() }
    }
    function draw (row, now) {
        var cv = row.canvas, ctx = row.ctx
        if (cv.width  !== cv.clientWidth)  cv.width  = cv.clientWidth
        if (cv.height !== cv.clientHeight) cv.height = cv.clientHeight
        var W = cv.width, H = cv.height, cy = H / 2
        var x = (t) => W * (1 - (now - t) / WINDOW)
        ctx.clearRect(0, 0, W, H)

        // state ribbon (a centered band)
        var by = H * 0.18, bh = H * 0.64, tr = row.transitions
        for (var i = 0; i < tr.length; i++) {
            var x0 = Math.max(0, x(tr[i].t)), x1 = i + 1 < tr.length ? x(tr[i + 1].t) : W
            if (x1 <= 0) continue
            ctx.fillStyle = COLOR[tr[i].state] || COLOR.idle
            ctx.fillRect(x0, by, Math.max(0, x1 - x0), bh)
        }
        // time ruler: a tick every timeout, so durations are readable
        for (var tk = TIMEOUT; tk <= WINDOW; tk += TIMEOUT) {
            var tx = W * (1 - tk / WINDOW)
            ctx.fillStyle = 'rgba(0,0,0,.05)'; ctx.fillRect(tx, 0, 1, H)
            ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(tx, 0, 1, 4)
        }
        // traffic + errors
        for (var e of row.events) {
            var ex = x(e.t)
            if (ex < 0) continue
            if (e.type === 'in')       tri(ctx, ex, cy, +1, '#228B22')   // ↓ incoming update
            else if (e.type === 'out') {                                 // ↑ outgoing edit
                var col = e.status === 'error' ? '#c1121f' : '#1565c0'
                tri(ctx, ex, cy, -1, col, e.status === 'acked')          // hollow pending, solid on ack
            }
            else { ctx.fillStyle = '#b71c1c'; ctx.fillRect(ex - 1, 0, 2, H) }  // error bar (GET)
        }
    }
    function frame () {
        var now = performance.now(), net = pipe.network

        // Status line: narrate what the poll is doing right now.
        var probing = null
        for (var name in net.hosts) {
            var h = net.hosts[name]
            if (h.online === false && h.active_requests_count > 0) {
                for (var u in h.urls) {
                    var rr = h.urls[u]
                    if ((rr.subscription && rr.subscription.aborter) || any_put_inflight(rr)) {
                        probing = u.replace(/^https?:\/\//, ''); break
                    }
                }
                if (probing) break
            }
        }
        document.getElementById('status').textContent =
            net.online === true    ? 'network online'
          : net.online === 'maybe' ? 'network maybe'
          : probing                ? 'network DOWN, probing ' + probing
          :                          'network DOWN'

        for (var row of rows) {
            var state = row.stateFn(net)
            if (sample(row, state, now)) log_event(row, state)
            row.dot.className = 'dot ' + (DOT[state] || '') + (forced.has(row.forceKey) ? ' pinned' : '')
            draw(row, now)
        }
        requestAnimationFrame(frame)
    }
    frame()
})()
