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

If you want automatic reconnections, this library add a `{retry: true}` option to `fetch()`.

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

For use in conjunction with `{retry: true}`, it's possible to make the `parents` param equal to a function, which will be called to get the current parents each time the fetch establishes a new connection.

```javascript
fetch('https://braid.org/chat', {subscribe: true, retry: true, parents: () => {
        return current_parents
    }}).then(
    res => res.subscribe(
        (update) => {
            console.log('We got a new update!', update)
            // Do something with the update
        }
    )
)
```

You can monitor the subscription's connection status with `onSubscriptionStatus`:

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

## Using it in Nodejs

You can braidify your nodejs server with:

```
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

You can also use `braidify` within a request handler like this:

```javascript
require('http').createServer(
    (req, res) => {
        braidify(req, res); if (req.is_multiplexer) return
        // Now braid stuff is available on req and res

        // ...
    })
).listen(9935)
```

The `is_multiplexer` test in this form is only necessary if multiplexing is
enabled.

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

## Configuring Multiplexing

You shouldn't need to, but can, configure which requests the library will
[multiplex](https://braid.org/protocol/multiplexing).  You can configure
multiplexing on both the client and the server.  They both need multiplexing
enabled for it to happen.

### Client

A client can globally disable multiplexing on `braid_fetch()` with:

```javascript
braid_fetch.enable_multiplex = false
```

It can enable multiplexing for all GET requests with:

```javascript
braid_fetch.enable_multiplex = true
```

It can also set it to multiplex after `N` connections to an origin with:

```javascript
braid_fetch.enable_multiplex = {after: N}
```

The default value is `{after: 1}`.

A client can override this global setting per-request by passing the same
value into `braid_fetch(url, {multiplex: <value>})`, such as with:

```javascript
braid_fetch('/example', {multiplex: true, subscription: true})
braid_fetch('/example', {multiplex: false, subscription: true})
// or
braid_fetch('/example', {multiplex: {after: 1}, subscription: true})
```

### Server

Configure mutliplexing with:

```javascript
var braidify = require('braid-http').http-server
nbraidify.enable_multiplex = true   // or false
```

## Testing

Run all tests from the command line:

```
npm test
```

Run tests in a browser (auto-opens):

```
npm run test:browser
```

You can also filter tests by name:

```
node test/test.js --filter="version"
```

