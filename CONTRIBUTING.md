# Contributing

DurableBoy is an experiment in server-authoritative emulation. Changes should
preserve the central invariant: SameBoy and the Durable Object own all canonical
machine state; the browser remains a screen and controller.

## Setup

```sh
vp install --frozen-lockfile
vp run wasm:download # or: vp run wasm:build
vp run check
vp test run
vp run smoke
vp build
```

Use `vp fmt` before opening a pull request. Native core changes must also pass
`vp run wasm:inspect`, `vp run smoke`, and `vp exec wrangler deploy --dry-run`.

## Pull requests

- Keep SameBoy pinned unless the pull request intentionally upgrades it.
- Never add commercial ROMs, proprietary boot ROMs, or copyrighted game assets.
- Add tests for protocol, persistence, or ABI behavior changes.
- Call out changes that affect checkpoint compatibility or determinism.
- Keep one Durable Object per console; do not introduce a global console registry.

By contributing, you agree that your contribution is licensed under the MIT
License.
