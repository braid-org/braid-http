# Braid-HTTP

This [ponyfill](https://ponyfill.com/) library extends the HTTP
implementations of Browsers and Nodejs with Braid-HTTP; transforming them from
*state transfer* to *state synchronization* systems.

These features are provided in an elegant, backwards-compatible way:
- Browsers: get a drop-in replacement for `fetch()`
- Nodejs: get a route handler that adds abilities to the `http`, `https`, and `http2` modules

It conforms to the [Braid-HTTP
v04](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-braid-http-04.txt)
specification, with the additional [HTTP
Multiresponse](https://braid.org/meeting-89) and [Multiplexing
v1.0](https://braid.org/protocol/multiplexing) extensions.

Developed in [braid.org](https://braid.org).


## Installing

Browsers:

```html
<script src="https://unpkg.com/braid-http/braid-http-client.js"></script>
<script>
  // To live on the cutting edge, you can now replace the browser's fetch() if desired:
  // window.fetch = braid_fetch
</script>
```

Node.js:

```shell
npm install braid-http
```

```javascript
// Import with require()
require('braid-http').fetch       // A polyfill for fetch
require('braid-http').http_client // A polyfill for require('http') clients
require('braid-http').http_server // A polyfill for require('http') servers

// Or as es6 module
import {fetch, http_client, http_server} from 'braid-http'
```

## Using it in Browsers

This library adds a `{subscribe: true}` option to `fetch()`, and lets you
access the result of a subscription with these new fields on the fetch response:

- `response.subscribe( update => ... )`
- `response.subscription`: an iterator that can be used with `for await`
- `response.version`: the parsed version from the response headers (if present)

### Example Subscription with Promises

Here is an example of subscribing to a Braid resource using promises:

```javascript
fetch('https://braid.org/chat', {subscribe: true}).then(
    res => res.subscribe(
        (update) => {
            console.log('We got a new update!', update)
            // {
            //   version: ["me"],
            //   parents: ["mom", "dad"],
            //   patches: [{
            //.      unit: "json",
            //       range: ".foo",
            //       content: new Uint8Array([51]),
            //       content_text: "3" <-- getter
            //.  }],
            //   body: new Uint8Array([51]),
            //   body_text: "3" <-- getter
            // }
            //
            // Note that `update` will contain either patches *or* body
        }
    )
)
```

### Example Subscription with Async/Await

```javascript
(await fetch('/chat', {subscribe: true, retry: true})).subscribe(
    (update) => {
        // We got a new update!
    })
```

### Example Subscription with `for await`

```javascript
var subscription_iterator = (await fetch('/chat',
    {subscribe: true, retry: true})).subscription
for await (var update of subscription_iterator) {
    // Updates might come in the form of patches:
    if (update.patches)
        chat = apply_patches(update.patches, chat)

    // Or complete snapshots:
    else
        // Beware the server doesn't send these yet.
        chat = JSON.parse(update.body_text)

    render_stuff()
}
```

### Advanced client features

#### Automatic reconection

Pass a `{retry: true}` option to `fetch()` to automatically reconnect:

```javascript
fetch('https://braid.org/chat', {subscribe: true, retry: true}).then(
    res => res.subscribe(
        (update) => {
            console.log('We got a new update!', update)
            // Do something with the update
        }
    )
)
```


To update the parent version that you reconnect from, set the `parents`
paramter to a function rather than an array of strings:

```javascript
fetch('https://braid.org/chat', {
    subscribe: true,
    retry: true,
    parents: () => current_parents
}).then(
    res => res.subscribe(
        (update) => {
            console.log('We got a new update!', update)
            // Do something with the update
        }
    )
)
```

It will call the `parents` function each time it reconnects to learn the
current parents to connection from.

#### Monitor the connection status

The `onSubscriptionStatus(status)` callback informs you when the connection
goes online and offline:

```javascript
fetch('https://braid.org/chat', {
    subscribe: true,
    retry: true,
    onSubscriptionStatus: ({online, error, status, statusText}) => {
        if (online)
            console.log('Connected!')
        else
            console.log('Disconnected:', error)
    }
}).then(
    res => res.subscribe(
        (update) => { console.log('Got update!', update) }
    )
)
```

The callback receives an object with only the fields relevant to the event:
- `{online: true}` — the subscription is connected
- `{online: false, error}` — the subscription went offline, with the error/reason for disconnection


## `reliable_update_channel`: reliable sync in one call

`reliable_update_channel(url, options)` is a higher-level API built on top of
`braid_fetch` that gives you a reliably-synced subscription plus a PUT queue
that survives network failures. It implements the [Reliable Updates
spec](https://braid.org/protocol/reliable-updates): it reconnects
automatically, detects dead connections via heartbeats, retries failed PUTs,
honors `Retry-After`, warns on unexpected status codes, and aborts on
unrecoverable errors.

```javascript
var { reliable_update_channel } = require('braid-http')

var current_version = []

var channel = reliable_update_channel('https://braid.org/chat', {
    reconnect_from_parents: () => current_version,
    on_update: (update) => {
        if (update.version) current_version = update.version
        // Apply the update to your local state
    },
    on_status: ({online, outstanding_puts}) => {},
    on_warning: (msg) => console.warn('reliable_update_channel:', msg),
    on_error:   (err) => console.error('reliable_update_channel shut down:', err),
    get_headers: {},
    put_headers: {},
    timeout: 30
})

// PUTs are queued and retried automatically. The returned promise
// resolves when the server has acknowledged this specific PUT.
await channel.put({
    version: ['me-1'],
    patches: [{unit: 'text', range: '[0:0]', content: 'hello'}]
})

// Shut down the controller
channel.close()
```

### Options

| Option        | Default      | Description |
|---------------|--------------|-------------|
| `signal`      | —            | `AbortSignal`. When it aborts, the subscription stops, the PUT queue is drained with rejections, and no further retries happen. |
| `on_update`   | —            | `(update) => ...`. Called for each update received on the subscription. Same shape as `braid_fetch`'s subscribe callback. |
| `on_warning`  | `console.warn` | `(msg) => ...`. Called for unexpected-but-recoverable conditions (e.g. a 500 on a PUT retry, or a parse error that triggers shutdown). |
| `on_error`    | —            | `(err) => ...`. Called once when `reliable_update_channel` shuts itself down due to a fatal condition (e.g. a subscription parse error). Not called when the caller aborts `signal`. |
| `parents`     | —            | Array or callback returning the latest versions the client knows about. Called fresh on every reconnect so the server can resume from the right point. |
| `headers`     | —            | Extra HTTP headers to include on every GET and PUT (e.g. `Cookie`, `Authorization`, `Accept`). Per-PUT `headers` passed through `put()` override these on conflicts. |
| `heartbeats`  | `20`         | Heartbeat period in seconds. Sent as the `Heartbeats` request header; if the server echoes it back and the client doesn't see any bytes for `1.2 × heartbeats + 3` seconds, it reconnects. |
| `put_timeout` | `heartbeats` | Per-PUT timeout in seconds. If a PUT doesn't complete in time, all in-flight PUTs are aborted and the queue is retried. |

### Returned API

`reliable_update_channel()` returns `{ put }`:

- **`put(update)`** — enqueues a PUT. `update` is whatever you'd pass to
  `braid_fetch` for a PUT (e.g. `{version, parents, patches}` or
  `{version, body}`). Returns a promise that resolves with the fetch
  response when the server acknowledges the PUT, or rejects if the
  caller's `signal` is aborted first.

### What the spec gets you

Once you've wired up `reliable_update_channel`, you get the reliable-updates
behaviors for free:

- **Auto-reconnection with backoff.** First failure retries after 1s;
  subsequent failures wait 3s. Any successful reconnection resets the
  counter.
- **Status-code handling per spec.** `209` is a successful subscription
  response; `309`, `408`, `425`, `429`, `432`, `502`, `503`, `504` (and
  any response carrying a `Retry-After` header) retry silently; any other
  non-`209` status warns via `on_warning` and retries.
- **`Retry-After` honored.** If the server sends `Retry-After: N`
  (seconds), the next reconnect waits that long instead of using the
  default backoff.
- **Heartbeat liveness detection.** The client asks the server to emit
  data every `heartbeats` seconds; if it doesn't, the connection is
  considered dead and gets re-established.
- **PUT queue with probe-first retries.** PUTs are fired in parallel. If
  any in-flight PUT fails, all siblings are aborted and the queue is
  retried — starting with a single probe PUT. The rest fan out only
  after the probe succeeds, avoiding a thundering-herd of doomed PUTs
  against a still-sick server.
- **Per-PUT timeouts.** If a PUT hangs longer than `put_timeout` seconds,
  it's aborted and the queue is retried.
- **Resume from your latest version.** On every reconnect, the `parents`
  callback is invoked fresh, so the server picks up from wherever your
  application's state actually is.
- **Parse-error shutdown.** If the subscription stream contains
  un-parseable bytes, `reliable_update_channel` warns, calls `on_error`, and stops
  retrying — the stream is corrupt and reconnecting won't fix it.


## Using it in Nodejs

You can braidify your nodejs server with:

```javascript
var braidify = require('braid-http').http_server
```

Braidify adds these new abilities to requests and responses:

- `req.subscribe`
- `req.startSubscription({onClose: cb})`
- `await req.parseUpdate()`
- `res.sendUpdate()`

You can call it in two ways:

1. `braidify((req, res) => ...)` wraps your HTTP request handler, and gives it
   perfectly braidified requests and responses.
2. `braidify(req, res, next)` will add arguments to your existing requests and
   responses.  You can use this as express middleware.

### Example Nodejs server with the built-in HTTP module

```javascript
var braidify = require('braid-http').http_server
// or:
import {http_server as braidify} from 'braid-http'

require('http').createServer(
    braidify((req, res) => {
        // Now braid stuff is available on req and res

        // So you can easily handle subscriptions
        if (req.subscribe)
            res.startSubscription({ onClose: _=> null })
            // startSubscription automatically sets statusCode = 209
        else
            res.statusCode = 200

        // And send updates over a subscription
        res.sendUpdate({
            version: ['greg'],
            body: JSON.stringify({greg: 'greg'})
        })
    })
).listen(9935)
```

If you are working from a library, or from code that does not have access to
the root of the HTTP handler or `next` in `(req, res, next)`, you can also
call `braidify` inline:

```javascript
require('http').createServer(
    (req, res) => {
        braidify(req, res); if (req.is_multiplexer) return
        // Now braid stuff is available on req and res

        // ...
    })
).listen(9935)
```

This works, but the inline form [leaks the multiplexing
abstraction](#inline-braidifyreq-res-leaks-the-abstraction) in three minor
ways.

### Example Nodejs server with Express

Or if you're using `express`, you can just call `app.use(braidify)` to get
braid features added to every request and response.

```javascript
var braidify = require('braid-http').http_server
// or:
import {http_server as braidify} from 'braid-http'

var app = require('express')()

app.use(braidify)    // Add braid stuff to req and res

app.get('/', (req, res) => {
    // Now use it
    if (req.subscribe)
        res.startSubscription({ onClose: _=> null })
        // startSubscription automatically sets statusCode = 209
    else
        res.statusCode = 200

    // Send the current version
    res.sendUpdate({
        version: ['greg'],
        parents: ['gr','eg'],
        body: JSON.stringify({greg: 'greg'})
    })

    // Or you can send patches like this:
    // res.sendUpdate({
    //     version: ['greg'],
    //     parents: ['gr','eg'],
    //     patches: [{range: '.greg', unit: 'json', content: '"greg"'}]
    // })
})

require('http').createServer(app).listen(8583)
```


### Example Nodejs client with `require('http')`

```javascript
// Use this line if necessary for self-signed certs
// process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0

var https = require('braid-http').http_client(require('https'))
// or:
// import braid_http from 'braid-http'
// https = braid_http.http_client(require('https'))

https.get(
   'https://braid.org/chat',
   {subscribe: true},
   (res) => {
      res.on('update', (update) => {
          console.log('well we got one', update)
      })
   }
)
```

To get auto-reconnections use:

```javascript
function connect () {
    https.get(
        'https://braid.org/chat',
        {subscribe: true},
        (res) => {
            res.on('update', (update) => {
                // {
                //   version: ["me"],
                //   parents: ["mom", "dad"],
                //   patches: [{
                //.      unit: "json",
                //       range: ".foo",
                //       content: new Uint8Array([51]),
                //       content_text: "3" <-- getter
                //.  }],
                //   body: new Uint8Array([51]),
                //   body_text: "3" <-- getter
                // }
                // Update will contain either patches *or* body, but not both
                console.log('We got a new update!', update)
            })

            res.on('end',   e => setTimeout(connect, 1000))
            res.on('error', e => setTimeout(connect, 1000))
        })
}
connect()
```


### Example Nodejs client with `fetch()`

```javascript
var fetch = require('braid-http').fetch
// or:
import {fetch} from 'braid-http'

// process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0

fetch('https://localhost:3009/chat',
      {subscribe: true}).andThen(
          x => console.log('Got ', x)
      )
```

## Testing

Run all tests from the command line:

```bash
npm test
```

Run tests in a browser (auto-opens):

```bash
npm run test:browser
```

You can also filter tests by name:

```bash
node test/test.js --filter="version"
```

## Multiplexing

This library automatically
[multiplexes](https://braid.org/protocol/multiplexing) subscriptions behind
the scenes to overcome web browsers' 6-connection limit (with HTTP/1) and
100-connection limit (with HTTP/2).  When you setup a server's `braidify` in
the recommended ways, you don't need to know it's happening — the abstraction
is completely transparent.

```javascript
// Recommendation #1: Wrapping the entire request handler
require('http').createServer(
  braidify((req, res) => {
    ...
  })
)
```

```javascript
// Recommendation #2: As middleware
var app = require('express')()
app.use(braidify)
```

```javascript
// Recommendation #3: With braidify(req, res, next)
// (Equivalent to the middleware form.)
app.use(
  (req, res, next) => {
    ...
    braidify(req, res, next)
    ...
  }
)
```


### Inline `braidify(req, res)` leaks the abstraction

If you are using braidify from within a library, or in another context without
access to the entire request handler, or a `next()` method, then you can use
the inline `braidify(req, res)` form:

```javascript
require('http').createServer(
  (req, res) => {
    ...
    braidify(req, res); if (req.is_multiplexer) return
    ...
  }
)
```

Just know that there are three abstraction leaks when using this form:

1. You must add `if (req.is_multiplexer) return` after
   the `braidify(req, res)` call.
2. The library will disable the [buffering
   optimization](https://braid.org/protocol/multiplexing#buffering-optimization)
   on optimistic multiplexer creation.  This buffering prevents two minor
   inconveniences that occur on about ~15% of page loads:
   1. One round trip of additional latency on the first subscription to a host
   2. A harmless `424` error in the javascript console, which can be safely
      ignored:
     ![424 error in browser console](https://braid.org/files/424-error.png)

The buffering works like this: when the client connects to a new host, it
sends a POST to create the multiplexer and GETs to subscribe — all in
parallel.  Sometimes a GET arrives before the POST.  With the recommended
forms, the server briefly buffers the GET (70ms, event-driven) until the
POST lands, then processes it normally.  Without `next`, the server can't
re-run the handler, so it returns 424 immediately and the client retries.

### Configuring multiplexing

You can tune multiplexing on the client, per-request or globally:

```javascript
braid_fetch('/a', {multiplex: true})      // force on for this request
braid_fetch('/a', {multiplex: false})     // force off for this request

braid_fetch.enable_multiplex = true       // on for all GETs
braid_fetch.enable_multiplex = false      // off globally
braid_fetch.enable_multiplex = {after: 1} // on after N connections (default)
```

And on the server:

```javascript
braidify.enable_multiplex = true    // default; set false to disable
braidify.multiplex_wait = 10        // ms; timeout for the buffering optimization (default 10)
                                    // set to 0 to disable buffering
```

