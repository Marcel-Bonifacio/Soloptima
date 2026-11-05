# Monocypher 4.0.3

Unmodified files from `monocypher-4.0.3.tar.gz` (https://monocypher.org/download/), whose SHA-512 matched the published
`monocypher-4.0.3.tar.gz.sha512`:

```
40904ada5c7ee4f7741733e38b69a30a4b0561cbffba5ffe7c2dce16136d540251ec0d9056ff606510d3b5b708fb8a40db7e0870d4a0b2dc17ba2bfb880f8965
```

The four source files are also identical to the `4.0.3` tag of https://github.com/LoupVaillant/Monocypher, apart from the
version line the release tarball fills in.

| File | From | SHA-256 |
|---|---|---|
| monocypher.c | src/ | 57eb914fc88136119bd41655cccb8c250048bf54d470540625186f8ab16f64be |
| monocypher.h | src/ | c494da712122da7ff679fdcf318a5317e84972b6c950fe9d896212947797facd |
| monocypher-ed25519.c | src/optional/ | 60fce3578fb00b00da96490653d993c4cb427b1e1be38183285c66e04d22cc18 |
| monocypher-ed25519.h | src/optional/ | abc4fad381879f5c29176ebe014b9189956b3dfe0a3e36459b6990bc57212380 |
| LICENCE.md | . | 5f8360e4c06ddcc584bdb4b210c6af824c4bb301e6a9a521869b6d90795ca4b3 |

Soloptima uses Ed25519 and BLAKE2b to check minisign signatures of update checksum lists (`src/signature.cpp`). The files
are compiled as C++ through `src/monocypher.cpp` and `src/monocypher_ed25519.cpp`. To update, replace them with a newer
release checked the same way and run `make test`.
