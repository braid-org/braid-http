// Answers "what is this hung test actually waiting on?"  Run the tests
// with --hangs, and when a test times out, the runner prints every
// promise that was created during the test and never resolved, with a
// stack trace of where each was created.  Every unfinished `await` and
// `new Promise` shows up, so the report reads like an async stack trace
// of the hang, replacing console.log bisection.
//
// Implementation: async_hooks tells us every time a promise is born,
// resolves, or is GC'd.  We record a stack trace at birth and forget the
// promise once it settles; whatever remains at show() time is the hang.
// Tracking every promise is why this hides behind a flag: the hook robs
// V8 of its promise fast paths.  The stacks themselves are cheap, though:
// Error.captureStackTrace just saves frame pointers, and the expensive
// formatting happens only when show() reads .stack.

var async_hooks = require('async_hooks')
var path = require('path')

var root = path.dirname(__dirname) + path.sep
var pending = new Map()   // asyncId -> {trace, born}
var last_id = 0           // asyncId of the newest promise we've seen
var mark_id = 0           // promises with id <= mark_id are old news

async_hooks.createHook({
    init: function on_born (id, type) {
        if (type !== 'PROMISE') return
        var trace = {}
        var prev_limit = Error.stackTraceLimit
        Error.stackTraceLimit = 25
        Error.captureStackTrace(trace, on_born)
        Error.stackTraceLimit = prev_limit
        pending.set(id, {trace, born: Date.now()})
        last_id = id
    },
    promiseResolve (id) { pending.delete(id) },
    destroy (id) { pending.delete(id) }
}).enable()

// The runner calls mark() as each test starts, so show() can ignore
// promises that predate the test (listening servers, earlier tests...).
// We mark by asyncId rather than by clock, because asyncIds are
// monotonic while a whole flurry of promises can be born in the same
// millisecond as the mark.
exports.mark = () => mark_id = last_id

exports.show = () => {
    // Group the pending promises by creation site, since one hung await
    // typically leaves several identical-looking promises behind
    var groups = new Map()
    for (var [id, {trace, born}] of pending) {
        if (id <= mark_id) continue
        var frames = clean_frames(trace.stack)
        if (frames.length) {
            var key = frames.join('\n')
            var g = groups.get(key)
            if (g) {
                g.born = Math.min(g.born, born)
                g.id = Math.max(g.id, id)
            } else groups.set(key, {frames, born, id})
        }
    }

    // A stack that is a suffix of another group's stack is the same
    // await chain seen one level further out (an outer await's frames
    // are its inner await's tail), so it adds nothing: drop it.  This is
    // what eats the runner's own race/await machinery, too.
    //
    // Sorting newest-first puts the deepest wait -- the usual hang --
    // at the top, with each entry's waiters beneath it.
    var reports = [...groups.values()]
        .filter((g, _, all) => !all.some(other =>
            other !== g && is_suffix(g.frames, other.frames)))
        .sort((a, b) => b.id - a.id)

    console.log(`
  ---- Timed out.  Where is the test stuck? ----

  Probably at the top entry below; the lower entries are usually just
  waiting on the ones above them.  (Though a stream that is meant to
  stay open can innocently appear here too.)`)

    if (!reports.length)
        console.log(`
  (nothing is pending in this project's own code -- the hang is inside
  node internals, or something like a bare setTimeout)`)

    for (var g of reports) {
        var age = ((Date.now() - g.born) / 1000).toFixed(1)
        console.log(`\n  waiting ${age}s at ${g.frames[0]}`)
        for (var frame of g.frames.slice(1))
            console.log(`      called from ${frame}`)
    }
    console.log()
}

function is_suffix (a, b) {
    return a.length < b.length
        && b.slice(-a.length).every((frame, i) => frame === a[i])
}

// Keep only the frames from this project's code -- node internals and
// node_modules just bury the line the reader wants -- and trim each down
// to a readable file:line.  The "at (async )?" prefix goes too, so that
// the same line reached synchronously vs through an await still matches
// in the suffix comparison above.
function clean_frames (stack) {
    return stack.split('\n')
        .filter(line => line.includes(root)
            && !line.includes('node_modules')
            && !line.includes('show-hangs.js'))
        .map(line => line.trim()
            .replace(/^at (async )?/, '')
            .replaceAll(root, '')
            .replace(/:(\d+):\d+(\)?)$/, ':$1$2'))
}
