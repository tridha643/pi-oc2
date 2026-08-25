# pi-oc2 contributor rules

## Safety boundary

- Static analysis must never import, evaluate, or execute a source Pi package.
- Generated OpenCode 2 code must never import Pi or depend on `/Users/tri-modem/Desktop/opencode-pi`.
- Generated Pi code must never import OpenCode.
- Treat `pioc.port.json` and `portable/` as authored source. Treat `generated/` as disposable output.

## Determinism

- Sort filesystem matches, findings, tools, resources, imports, and emitted files lexically.
- Normalize serialized paths to `/`.
- Never put timestamps, absolute source paths, environment values, or filesystem iteration order in generated output.
- Every generator change needs a byte-stability test that runs generation twice.

## TypeScript

- Use strict domain types and tagged results for expected failures.
- Avoid `any`, non-null assertions, and unchecked casts.
- Add JSDoc to exported symbols.
- Keep tests beside source files.

## Commands

Run from the repository root:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm verify
```
