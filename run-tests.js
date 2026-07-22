// Runs the tests of a client/server braid-http project: tests drive real
// braid requests -- subscriptions, PUTs, multiplexed streams -- against
// live local servers.
//
//  - Tests run in a parallel pool (--in-parallel=N, default 16; --serial;
//    --hangs implies --serial; --filter=/--grep= narrow the run)
//  - Each test accumulates a report -- every line it provokes, plus its
//    verdict -- which prints whole, in completion order
//  - A footer, pinned below the scrollback on a TTY, shows the whole
//    suite live: a glyph per test, counts, what's running. Piped output
//    stays plain text, and dies quietly on EPIPE (e.g. piped into `head`)
//  - console.log/debug/warn/error route into the report tree while tests
//    run: test code, library chatter, and test-supplied server-side
//    handler code all file under the right test
//  - test_context (an AsyncLocalStorage) follows each test across awaits
//    and timers; outgoing requests are stamped with a test-id header
//    (pass `braid_fetch` to wrap its transport), and the host's servers
//    call claim_request(req) at their doors to read -- and scrub -- it
//  - A late line (its test already printed) hits the margin tagged
//    (t<id>); an unattributable line hits the margin untagged
//
// Usage (braid-http's own test/test.js is the reference host):
//
//   var runner = require('braid-http/run-tests')({
//       braid_fetch,                        // stamp its transport
//       rerun_command: 'node test/test.js', // for the failure hint
//       timeout: 2000,                      // per-test default ms
//   })
//   // start your servers, calling runner.claim_request(req) at the door,
//   // and runner.log(req) wherever you log a request
//   define_tests(runner.run_test, your_context)
//   var failed = await runner.run()

var util = require('util')
var { AsyncLocalStorage } = require('async_hooks')

module.exports = function create_test_runner (options = {}) {

    var args = process.argv.slice(2)
    var filter_arg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
        || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]
    var show_hangs = args.includes('--hangs') && require('./show-hangs.js')

    // Tests run --in-parallel by default, 16 at a time (or
    // --in-parallel=N). --serial runs them one at a time (--hangs implies
    // it: a hung-promise report is only attributable when a single test
    // is running)
    var serial = args.includes('--serial') || !!show_hangs
    var in_parallel = serial ? 1
        : parseInt(args.find(arg => arg.startsWith('--in-parallel='))?.split('=')[1]
                   || options.in_parallel || 16)

    var default_timeout = options.timeout ?? 2000
    var rerun_command = options.rerun_command ?? 'node test/test.js'

    process.on("unhandledRejection", (x) =>
        console.log(`unhandledRejection: ${x?.stack || x}`)
    )
    process.on("uncaughtException", (x) =>
        console.log(`uncaughtException: ${x.stack}`)
    )

    // If our console goes away (e.g. piped into `head`), die quietly like
    // a good unix citizen -- otherwise the stdout error would bounce
    // between the uncaughtException handler and its own console.log,
    // forever
    var die_quietly = e => { if (e.code === 'EPIPE') process.exit(0) }
    process.stdout.on('error', die_quietly)
    process.stderr.on('error', die_quietly)

    var test_context = new AsyncLocalStorage()
    var reports = []            // one report per test, in registration order
    var path_owners = new Map() // host-registered path -> owning test's report
    var real_log = console.log.bind(console)

    // Color and the live footer only make sense on a real terminal --
    // piped output stays plain text
    var is_tty = !!process.stdout.isTTY
    var use_color = is_tty && !process.env.NO_COLOR
    var green  = s => use_color ? `\x1b[32m${s}\x1b[39m` : s
    var red    = s => use_color ? `\x1b[31m${s}\x1b[39m` : s
    var yellow = s => use_color ? `\x1b[33m${s}\x1b[39m` : s
    var dim    = s => use_color ? `\x1b[2m${s}\x1b[22m`  : s

    // Stamp braid_fetch's underlying transport with the running test's
    // id, so every request -- including the library's internal traffic --
    // tells the host's servers whose it is
    if (options.braid_fetch) {
        var og_transport = options.braid_fetch.set_fetch((url, params = {}) => {
            var report = test_context.getStore()
            if (report) {
                var headers = new Headers(params.headers)
                headers.set('test-id', report.index)
                params = { ...params, headers }
            }
            return og_transport(url, params)
        })
    }

    // Reads the request's test-id header, resolving the test it belongs
    // to -- by the header if it was stamped, else by who registered the
    // path it's hitting (path_owners) -- and stashes it as
    // req.test_report. The header is scrubbed off: braid servers parse
    // unrecognized request headers into updates' extra_headers, where a
    // stamp would corrupt tests' asserts
    function claim_request (req) {
        var id = req.headers['test-id']
        delete req.headers['test-id']
        return req.test_report = (id !== undefined)
            ? reports[+id]
            : path_owners.get(req.url.split('?')[0])
    }

    // log('a line')    -> the running test's report
    // log(req)         -> the request's test's report, as "GET /foo"
    function log (...args) {
        var req = args[0]?.method && args[0],
            report = req ? req.test_report : test_context.getStore(),
            line = req ? `${req.method} ${req.url}` : args[0]
        if (report && !report.printed)
            report.lines.push(line)
        else if (report)
            emit(dim(`(t${report.index}) `) + line)  // its report already printed
        else
            emit(line)
    }

    // Writes a line of scrollback, lifting the footer out of the way
    // first -- every print path goes through here so the footer always
    // sits below everything
    var footer_rows = 0
    function emit (text) {
        if (footer_rows) {
            process.stdout.write(`\x1b[${footer_rows}A\x1b[0J`)
            footer_rows = 0
        }
        real_log(text)
    }

    // Prints a finished test's whole report: its verdict line, tagged
    // with its section, then everything it logged
    function print_report (report) {
        var mark = report.mark === '✓' ? green('✓')
                 : report.mark === '✗' ? red('✗') : report.mark
        emit('')
        var tag = report.section ? ' ' + dim(`[${report.section}]`) : ''
        emit(`${mark} ${report.mark === '✗' ? red(report.test_name) : yellow(report.test_name)}${tag}`)
        for (var d of report.details) emit('    ' + d)
        for (var l of report.lines)   emit('      ' + l)
        report.printed = true
        draw_footer()
    }

    // The footer: a glyph per test (· pending, ▸ running, ✓/✗ done),
    // counts, and the currently-running tests with their elapsed times
    function draw_footer () {
        if (!is_tty) return
        if (footer_rows) {
            process.stdout.write(`\x1b[${footer_rows}A\x1b[0J`)
            footer_rows = 0
        }
        var width = process.stdout.columns || 80
        var glyphs = reports.map(r =>
            r.state === 'done'    ? (r.mark === '✗' ? red('✗') : green('✓'))
          : r.state === 'running' ? yellow('▸')
          : dim('·'))
        var rows = []
        for (var i = 0; i < glyphs.length; i += width)
            rows.push(glyphs.slice(i, i + width).join(''))

        var done    = reports.filter(r => r.state === 'done')
        var failed  = done.filter(r => r.mark === '✗').length
        var running = reports.filter(r => r.state === 'running')
        var names = running.slice(0, 2).map(r =>
            `${r.test_name} (${((Date.now() - r.started_at) / 1000).toFixed(1)}s)`
        ).join(', ') + (running.length > 2 ? `, +${running.length - 2} more` : '')
        var status = `${done.length}/${reports.length}`
            + (failed ? `  ${red('✗ ' + failed)}` : '')
            + (names ? `  ${dim('▸ ' + names.slice(0, width - 12))}` : '')
        rows.push(status)

        process.stdout.write(rows.join('\n') + '\n')
        footer_rows = rows.length
    }

    // ── Registration ────────────────────────────────────────────────

    var total_tests = 0
    var passed_tests = 0
    var failed_tests = 0
    var skipped_tests = 0
    var failed_test_names = []
    var hung_test = false
    var tests_to_run = []

    function add_section_header (header_text) {
        add_section_header.current_section = header_text
    }

    function assert (condition, message) {
        if (!condition) throw new Error(message || 'Assertion failed')
    }

    function run_test (test_name, test_function, expected_result, params) {
        // Apply filter if specified
        if (filter_arg && !test_name.toLowerCase().includes(filter_arg.toLowerCase())) {
            skipped_tests++
            return
        }

        total_tests++
        var report = {
            index: reports.length,
            test_name,
            section: add_section_header.current_section,
            state: 'pending',
            started_at: null,
            lines: [],
            mark: null,       // '✓', '✗', or '○'
            details: [],      // Expected/Got/Error lines under a failure
            printed: false
        }
        reports.push(report)
        tests_to_run.push({ report, test_function, expected_result, ...params })
    }

    // ── Running ─────────────────────────────────────────────────────

    // Runs one test, recording its verdict on its report. test_context
    // carries the report through everything the test does
    async function run_one (item) {
        var { report, test_function, expected_result,
              timeout = default_timeout } = item
        report.state = 'running'
        report.started_at = Date.now()

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

            var result = await Promise.race([
                test_context.run(report, test_function), timed_out])
            if (expected_result === undefined) {
                // Assertion-style test: success simply means it returned
                // (without throwing). An assert() failure throws and is
                // handled by the catch below.
                passed_tests++
                report.mark = '✓'
            } else if (result == expected_result) {
                passed_tests++
                report.mark = '✓'
            } else if (result === 'old node version') {
                skipped_tests++
                report.mark = '○'
                report.details.push('(skipped: old node version)')
            } else {
                failed_tests++
                failed_test_names.push(report.test_name)
                report.mark = '✗'
                report.details.push(`Expected: ${expected_result}`,
                                    `Got: ${result}`)
            }
        } catch (error) {
            failed_tests++
            failed_test_names.push(report.test_name)
            report.mark = '✗'
            report.details.push(`Error: ${error.message || error}`)
        } finally {
            // otherwise a passing test's timer fires long after, and with
            // --hangs would print a bogus report during a later test
            clearTimeout(timer)
        }

        report.state = 'done'
        print_report(report)
    }

    // Runs the registered tests, in_parallel at a time, prints the
    // summary, and returns the number of failures. While tests run, the
    // console's log/debug/warn/error route into the report tree,
    // catching the libraries' own chatter
    async function run () {
        var console_methods = ['log', 'debug', 'warn', 'error']
        var real_console = Object.fromEntries(
            console_methods.map(m => [m, console[m]]))
        for (var m of console_methods)
            console[m] = (...args) => log(util.format(...args))
        var footer_timer = is_tty && setInterval(draw_footer, 100)
        try {
            var next = 0
            await Promise.all(Array.from({ length: in_parallel }, async () => {
                while (next < tests_to_run.length)
                    await run_one(tests_to_run[next++])
            }))
        } finally {
            Object.assign(console, real_console)
            if (footer_timer) clearInterval(footer_timer)
            if (footer_rows) {
                process.stdout.write(`\x1b[${footer_rows}A\x1b[0J`)
                footer_rows = 0
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

            // Guide the reader to the two debugging tools: narrowing the
            // run to one test, and (for hangs) the pending-promise
            // report. Nothing prints if this run already used both.
            var suggest_filter = !filter_arg
            var suggest_hangs = hung_test && !show_hangs
            if (suggest_filter || suggest_hangs) {
                console.log(`\nTo debug, rerun a failing test by itself:`)
                console.log(`  ${rerun_command} --serial`
                    + (hung_test ? ' --hangs' : '')
                    + ` --filter='${filter_arg || failed_test_names[0]}'`)
                if (suggest_hangs)
                    console.log(`  (--hangs prints what a hung test is stuck waiting on)`)
            }
        }

        return failed_tests
    }

    return { run_test, add_section_header, assert, run,
             log, claim_request, test_context, path_owners,
             filter_arg, serial, in_parallel }
}
