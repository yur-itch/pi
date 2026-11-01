# Code formatting: current implementation and deferred extension idea

## Decision at handoff

**Keep the working implementation as-is.** The user tested it with a real model response and terminal resizing and considers it satisfactory. Do not start extracting an extension, adding settings, or replacing workers without a new request.

This document preserves the alternative design and measurements so that work can resume later.

## Working checkout and installation

- Local checkout: `C:/Users/PCyur/pi-code-fit`, based on Pi 1.4.0.
- Existing installed Pi 1.3.0 remains unchanged.
- Fork CLI: `packages/coding-agent/dist/bundle/cli.js`.
- Changes are uncommitted; the new source and test files are still untracked at handoff.
- No remote fork, commit, push, or installation replacement was performed.

The user's PowerShell `truth` and `dare` functions invoke `C:/Users/PCyur/pi-setup/tod/tod.py`. That launcher establishes the working connection and uses `C:/Users/PCyur/pi-setup/pi-agent` for configuration. Do not assume the default Pi configuration has usable authentication.

For the interactive test, a temporary Python helper imported that launcher, replaced its `PI_CLI` constant with the fork CLI, omitted its model-side terminal-width hint, and called its `main()` in `truth` mode. It opened Windows Terminal titled **Pi code-fit resize test**. The helper was removed; the original launcher and PowerShell profile were not edited. Reuse that approach if another authenticated interactive test is needed. Do not print credentials.

## What currently works

Code fences use real syntax-aware formatting before highlighting; ordinary terminal wrapping handles remaining overflow. Wrapping after formatting was explicitly approved by the user.

- Formatting affects display only, not saved messages or model context.
- Closed fences only; incomplete streaming fences and indented blocks are not formatted.
- Language coverage: JS/TS/JSX/TSX, JSON/JSONC, Python.
- Unsupported languages, parse failures, and runtime failures retain original code and existing wrapping.
- Actual available width accounts for outer padding, code indentation, lists, and blockquotes.
- First render can show original code; worker completion invalidates the affected layout and requests a repaint.
- Source tabs are preserved for parsing/formatting and expanded only for display.

The user's screenshot showed TypeScript, JSON, and Python adapting structurally to different widths, with a long unbreakable string falling back to wrapping. This exercised the real-model-to-terminal path. Screenshots do not establish cache hits or worker eviction.

## Resource policy

| Resource | Current policy |
|---|---|
| Formatted-result cache | LRU, 256 entries or 4 MiB, whichever is reached first |
| Cache key | SHA-256 source hash + file type + width bucket |
| Width buckets | 8 columns, rounded down; minimum target width 1 |
| Loaded runtimes | At most 2 workers, grouped by formatter plugin family |
| Runtime eviction | Idle LRU when another plugin needs room; 30-second idle expiry |
| Pending work | At most 64 requests; matching requests are coalesced |
| Input limit | 128 KiB using `source.length * 2`: at most 65,536 UTF-16 code units |
| Worker timeout | 5 seconds; original code is the fallback |

Result strings and workers have independent lifetimes. Evicting a worker does not discard cached results. Stopping the last active TUI disposes workers/pending work but retains completed results.

The 4 MiB cache budget is **not a total process-memory bound**; worker/WASM memory is separate. JS/TS/JSX/TSX share the TypeScript plugin family.

Most limits already have programmatic `CodeFormatterOptions`, but they are not wired to Pi user settings. Bucket size is currently hardcoded. `MarkdownOptions.formatCode` allows disabling formatting per component, not through `/settings`.

## Implementation map

New files:

- `packages/tui/src/code-formatter.ts`: scheduling, result cache, runtime cache, redraw coordination.
- `packages/tui/src/code-formatter-worker.ts`: dprint WASM formatting in a worker.
- `packages/tui/test/code-formatter.test.ts`: formatter/cache/runtime tests.
- `packages/tui/test/markdown-code-format.test.ts`: rendering integration tests.

Modified files:

- `packages/tui/src/components/markdown.ts`: closed-fence detection, width calculation, formatting/highlighting integration, invalidation.
- `packages/tui/src/tui.ts`: subscribe/unsubscribe to formatter redraws.
- `scripts/build-coding-agent-bundle.mjs`: emit the worker beside the relevant bundle chunk.
- `packages/tui/package.json`, root `package-lock.json`, and `packages/coding-agent/install-lock/package-lock.json`: pinned dependencies.
- `packages/tui/README.md`, `packages/tui/CHANGELOG.md`: documentation.

Pinned dependencies: `@dprint/formatter` 0.6.0, `@dprint/typescript` 0.96.1, `@dprint/json` 0.25.2, `@dprint/ruff` 0.11.3.

Before this handoff document, the patch was 712 insertions and 13 deletions across 12 files, including new files: 340 implementation/build insertions, 291 test insertions, 21 documentation insertions, and 60 dependency/lockfile insertions.

## Deferred idea: make this an optional extension

Pi already exposes **`pi.registerMarkdownTransformer()`**, including in the user's installed 1.3.0. The initial decision to use a fork did not sufficiently investigate this route.

Relevant sources in the checkout:

- `packages/coding-agent/src/core/extensions/types.ts`: `MarkdownTransformContext`, `MarkdownTransformer`, registration API.
- `packages/coding-agent/src/modes/interactive/components/markdown-transform.ts`: applies transformers and catches failures.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`: supplies the transformer to Markdown components.
- `packages/coding-agent/src/modes/interactive/components/mermaid.ts`: existing use of the same transformation mechanism.
- `packages/tui/src/components/markdown.ts`: rendering cache and invocation of `MarkdownOptions.transform`.

A transformer receives the Markdown, message type, streaming state, and available content width after outer padding. It returns replacement Markdown synchronously for display. It could find closed fences, substitute formatted source, and let Pi retain responsibility for highlighting and wrapping.

Unresolved requirements before claiming an extension-only implementation is sufficient:

1. **Asynchronous results:** the hook returns a string, not a promise. Returning original/cached text and later repainting needs a supported invalidation mechanism.
2. **Rendering caches:** `Markdown.render()` checks its text/width cache before invoking the transform. A redraw alone may not rerun it.
3. **Nested widths:** the hook sees whole-content width, not the inner width of each list/blockquote/code fence. The extension must calculate that or obtain a narrower hook.
4. **Lifecycle and packaging:** verify reliable worker cleanup, extension reload behavior, worker asset resolution, and compatibility with published Pi packages.

A possible long-term boundary is an optional package owning formatter dependencies, workers, caching, and configuration, with only a narrowly justified integration hook upstream if existing APIs prove insufficient. No such extraction has been implemented or validated.

## Deferred settings

Potential JSON settings, not implemented:

- Enable/disable formatting.
- Result-cache memory budget, default 4 MiB.
- Maximum loaded formatter workers, default 2.
- Width-bucket size, default 8 columns.

Only enable/disable clearly needs a `/settings` entry. Keep entry-count guards, timeouts, and other safety limits internal unless practical needs justify exposing them. Adding configuration alone does not make the current core integration minimal.

## Measurements: are workers necessary?

Measurements used Node 24.14.0 on the user's Windows machine. Temporary benchmark scripts were removed. These are local samples, not portable performance guarantees or interactive usability measurements.

### Small snippets, approximately 250–300 characters

Median timings:

| Language | Fresh worker + first format | Loaded worker format | Result-cache hit |
|---|---:|---:|---:|
| TypeScript | 206 ms | 2.1 ms | 0.015 ms |
| JSON | 146 ms | 0.9 ms | 0.013 ms |
| Python | 195 ms | 0.8 ms | 0.013 ms |

Fresh-worker measurements do not imply cold filesystem caches. Direct synchronous formatting with an initialized engine took approximately 1.5 ms for TypeScript and 0.3–0.4 ms for JSON/Python.

### Larger snippets, direct synchronous formatting

Synthetic valid code with nested structures and many syntax elements; initialized engines; nine measured runs targeting 80–88 columns. Median formatting-only times:

| Approximate source characters | TypeScript | JSON | Python |
|---:|---:|---:|---:|
| 4K | 9 ms | 3 ms | 3 ms |
| 16K | 29 ms | 11 ms | 8 ms |
| 33K | 67 ms | 20 ms | 12 ms |
| 62K | 101 ms | 35 ms | 21 ms |
| 131K | 195 ms | 73 ms | 44 ms |
| 262K | 392 ms | 145 ms | 86 ms |

The last two rows exceed the current input limit. Formatting at 40 columns was also tested; it did not eliminate the larger-input cost, and some individual runs were slower.

Batches of distinct approximately 4K-character TypeScript blocks took 33 ms for 5 blocks, 66 ms for 10, 131 ms for 20, and 326 ms for 50. These simulate uncached work in one render, not cache-hit rendering.

Real source was sometimes cheaper than synthetic code: `code-formatter.ts` (7,734 characters, 238 lines as counted) took 8.6 ms median; `markdown.ts` (40,865 characters, 1,175 lines) took 40 ms. Syntax density matters, not just length.

In the larger benchmark's first initialization plus approximately 1K-character formatting, synchronous time was 126 ms for TypeScript, 31 ms for JSON, and 98 ms for Python. These numbers exclude top-level JS module import time and vary with initialization/caching state.

Interpretation:

- Synchronous cached formatting could be reasonable for small snippets with a smaller input cap and a guard against expensive batches.
- Rough UI guidelines: under 10 ms is generally cheap; 20–50 ms may hitch; around 100 ms is noticeable; repeated 250+ ms stalls are unpleasant. These are heuristics, not measured perception thresholds.
- The existing workers keep formatting costs off the UI thread. Removing them wholesale would regress responsiveness on larger inputs and batches.
- Prefer investigating async extension invalidation before sacrificing the current behavior. A synchronous-only design would be a different performance trade-off, not an equivalent simplification.

## Upstream suitability

Read the checkout's `CONTRIBUTING.md` before any contribution. It explicitly prioritizes a minimal core, recommends extensions for non-core features, and requires discussion even for new extension hooks.

The current patch is a working local implementation, not an upstream-ready proposal: it puts language-specific dependencies and runtime/cache policy in the general-purpose TUI library and enables the behavior by default. An optional extension is a more natural fit. Do not assume maintainers would reject or accept a particular design without discussion.

New contributors need maintainer `lgtm` approval before opening a PR. Follow their issue templates and human-authored issue guidance. Maintainers also request no contributor edits to changelogs; the fork currently has a changelog edit that would need addressing if preparing an approved upstream patch.

## Verification history and resuming work

Earlier implementation work passed `npm run check`, `npm run build:offline`, formatter/Markdown/tab-width tests, broader terminal rendering tests, compiled/bundled worker smoke tests, CLI startup/version checks, and `git diff --check`. The user subsequently completed the real-model/resizing test. These checks were not all rerun for this documentation-only handoff.

For builds, model catalog data was hydrated with `npm run hydrate:model-data`; `npm run build:offline` avoids regenerating committed typed catalog wrappers. Follow repository `AGENTS.md` for current build/test requirements.

When returning to the idea:

1. Recheck upstream APIs and contribution policy; this document describes the checkout at handoff.
2. Inspect existing invalidation/UI APIs before proposing a new hook.
3. Prototype the transformer route without removing the working fork behavior.
4. Verify code fences inside lists/quotes, streaming closure, resize/cache behavior, reload/shutdown, and source/context preservation.
5. Re-measure large inputs and multiple blocks if considering synchronous formatting.

No publishing, commits, profile edits, or installed-package changes are authorized by this handoff.
