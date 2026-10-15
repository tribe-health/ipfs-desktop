# Search (vector index) on IPFS Desktop

Change `desktop-search-sidecar` (kubo repo, `openspec/changes/desktop-search-sidecar`). Search lets
the agent find files on your node by meaning. It is **off by default**: it spends CPU and disk, and
it is not one of the agent features that ship on.

## What you provide

Desktop downloads and installs nothing for Search (operator decision OG-19). You install:

- `surreal` (SurrealDB 3.0.0 or newer) and `xberg` (1.3.10 or newer, the document reader). Give Desktop
  the **absolute path** of each; it never looks them up on `PATH`. Keep the `xberg` directory whole:
  its tarball has dylibs next to the executable.
- An embedder, an OpenAI-compatible HTTP endpoint you run (for example Ollama with `bge-m3`), with its
  model name and vector size.
- Optionally a vision model for image descriptions (a local OpenAI-compatible endpoint). Video
  description stays off: it needs a hosted model, and Desktop does not turn it on.

Both programs, and the folder each sits in, must belong to you (or root) and must not be writable by
group or others, because `xberg` loads libraries from its own folder. Otherwise Search stays
unavailable and the window says which program (`binary_unsafe`). A folder such as Homebrew's
`/opt/homebrew/bin` is group-writable on many Macs: copy the program into a folder only you can
write to, or run `chmod go-w` on the file and its folder. Windows has no mode bits to read, so the
check is skipped there.

On macOS, a program you downloaded in a browser may be blocked on its first run. Clear the quarantine
flag on the directory you unpacked it into: `xattr -dr com.apple.quarantine <directory>`. Desktop does
not do this for you. The evidence for xberg 1.3.10 on macOS arm64 (checksum, quarantine, flags, cache
path, offline switch) is in the kubo repo, `openspec/changes/desktop-search-sidecar/evidence/2026-10-15-task-1.1/`.

## Known limit: the document reader's port

While Search is on, the embedded `xberg` listens on a loopback port that has no authentication. Other
programs on this computer, and web pages that find the port (simple cross-origin POSTs work, and DNS
rebinding can read the responses), can make it extract files they send, fetch public URLs, or clear its
model cache. `ipfs mcp` itself reaches it only through an authenticated proxy. The operator accepted
this until `xberg` gains authentication. To avoid it, turn Search off.

## Turning it on

Tray, Settings, **Search settings...** opens a native window (not the Web UI): choose both programs,
fill in the embedder address, model and vector size, tick **Turn on Search** and save. Saving restarts
the local agent endpoint once (embedding settings are not hot-reloaded). A bulk indexing run that was
going comes back **paused**; the window says so. Resume it from the agent chat. Runs never start by
themselves.

## What is written

When Search is on and everything checks out, the generated `sidecar-config.json` gets an `embeddings`
block (`mcp/contract/config/ipfs-mcp-config.schema.json`): `mode: embedded` for the store and the
extractor, `data_dir` and `cache_dir` under `<userData>/mcp/search/` (created `0700`; the cache must be
yours and not writable by group or others, or Search stays unavailable), `allow_model_downloads: false`,
`ocr` and `transcribe` off, `bulk` and `search_route` at the contract defaults, a `policy.mime_allowlist`
of the types xberg reads offline (images only when a describer is set) and the `describer` for images.

When Search is off, or the programs, the embedder or a host are not usable, **no `embeddings` block is
written**: no `surreal` or `xberg` process starts, and `ipfs mcp` does not mount `/index/*`, so
`/index/status` answers 404 and the Web UI hides its search entry. The tray shows "Search: needs
attention" and the window shows the reason in words.

## Where content may go

The Desktop `ui` principal's `egress_ack` is `local` (any loopback host) plus each non-loopback host
you confirmed by name. Saving a non-loopback embedder or describer host asks first, naming the host
and saying what goes there (the text of your files; your image files): Touch ID where the computer has
it, otherwise a native dialog, through the same gate as the agent backend (`src/agent/host-confirm.js`).
The dialog is Search's own wording (`agentSearch.dialog.*`: "Send the text of your files to <host>?" or
"Send your image files to <host>?"), never the agent-backend text, and it is parented to the Search
window. A refusal changes nothing. A host you decline in the Search window is not asked about again
until you close that window (declines for the agent backend are kept apart and follow the Web UI
window). A host that is removed, or turning Search off, drops its entry.

The address fields warn as you type: a host that is not on this computer shows where the text or the
files would go before you save (the window asks the main process, which owns the wording; nothing is
stored).

Not covered: a hosted embedder or describer that needs an API key. Desktop writes no key into the
config; use a loopback endpoint (or a local proxy that holds the key) until a key field is added.

## Capturing the window (development builds only)

The Search window sets content protection, so other programs cannot record it (it shows paths and
hosts). An unpackaged build started with `IPFS_DESKTOP_DEV_ALLOW_CAPTURE=1` skips that for design
review and logs a warning. A packaged app ignores the variable (`captureAllowed` in
`src/agent/search/window.js`).

## Off switch and tests

`search.enabled` in the Desktop store (`config.json`), default `false`, or untick it in the window.
Disabled-state tests: `test/unit/agent-search.spec.js` (fresh profile: no `embeddings` block, only the
`ipfs` binary is spawned, tray and window show off), plus the existing sidecar specs.
