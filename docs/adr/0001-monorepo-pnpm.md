# ADR 0001: pnpm monorepo with TypeScript project references

Status: accepted

One engine with several front doors (CLI, MCP, plugins) needs shared, independently testable packages with enforced boundaries. A pnpm workspace with `tsc -b` project references gives fast incremental builds and workspace links; ESLint `no-restricted-imports` keeps `core` free of AWS, MCP and model SDKs. Vitest resolves workspace packages to sources so tests need no build (except the byte-for-byte example test and the stdio smoke test, which use built output). Turborepo was rejected: the repository is small enough that it adds nothing.
