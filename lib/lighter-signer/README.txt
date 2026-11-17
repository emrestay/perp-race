Lighter WASM signer, built from https://github.com/elliottech/lighter-go
commit 74e2b996dcbb44e58ebf133ae463b1ea1c6b51fc (2026-11-13), go1.26.5
GOOS=js GOARCH=wasm go build -trimpath -o lighter-signer.wasm ./wasm/
wasm_exec.js is the glue file from the same Go install.
sha256 lighter-signer.wasm: e52cec458d9448d432be2a5ee350b5d5accacc03627a65020614fe03cbb5db1c
