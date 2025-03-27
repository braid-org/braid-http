# package.json notes

This package is bundled as both a commonjs and es6-compatible NPM bundle. The
factor that enables this dual packaging is the "exports" key in the package.json
file:

## exports

- `require`: When this package is in a commonjs environment (e.g. default nodejs) 
  the ./index.js file will be the thing that is 'require'd.
- `import`: When this package is in an es6 environment (e.g. bundler, modern nodejs,
  modern browser) the ./index.mjs will be the thing 'import'ed.

## Development Notes

For code that is intended to run in all environments (e.g. browser, node) and
potentially pass through a bundler step, the following guidelines are helpful:

- Use single-value module.exports in files, and named exports in wrappers.
- If using globals, it's also important to use module.exports; for example: 
 
```
function braid_fetch(...) { ... }

if (typeof module !== 'undefined' && module.exports) {
    module.exports = braid_fetch
}
```

For a complete list of reasons for the madness, and to learn more about the method
we've used to build this package, see https://redfin.engineering/node-modules-at-war-why-commonjs-and-es-modules-cant-get-along-9617135eeca1
