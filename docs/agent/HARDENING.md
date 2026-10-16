# Web UI window hardening and the agent chat token bridge

Change `desktop-agent-chat` (kubo repo, `openspec/changes/desktop-agent-chat`), tasks 1.1 to 1.3.
Falsifiers: G11-2 (the CSP or `webSecurity` must not break the Desktop smoke test, and
`webSecurity: false` is never restored to hide a regression) and G11-4 (no remote resource in
the island, and the `ipfs mcp` token is in no page storage).

Tasks 1.4 to 1.6 (pairing, the native confirmation window, their e2e tests) wait for
`native-confirmation-prompt` and are not part of this document.

## 1. What the Web UI window did before

Evidence from `src/webui/index.js` at HEAD `9bd9904`, and from the probe in section 6:

| Fact | Evidence |
| --- | --- |
| The window ran with `webSecurity: false` and no Content-Security-Policy. | `webPreferences` in `createWindow`; baseline probe: no `content-security-policy` header, `eval('1+1')` returns 2, an inline script runs, a fetch to `https://csp-probe.invalid` is attempted (DNS failure, not a CSP block). |
| Because `webSecurity` was off, Chromium did not enforce CORS on the Web UI's calls to the RPC API. The node's `API.HTTPHeaders["Access-Control-Allow-Origin"]` did not list `webui://localhost` and the calls still worked. | Baseline probe: every RPC call from the page returns 200 against a node whose allowed origins are only `https://webui.ipfs.io`. |
| **Pre-existing defect: the preload never ran in the sandbox.** `preload.js` did `require('./connection-status')`, `require('../common/consts')`, `require('../common/ipc-main-events')`. A sandboxed preload (the Electron default since 20, because `nodeIntegration` is false) can only require `electron` and a few built-ins. | Console in the first baseline run: `Unable to load preload script ... Error: module not found: ./connection-status`. Consequences on the unmodified tree: `window.ipfsDesktop` is undefined, the `ipfsApi` hand-off never happens (the Web UI falls back to its own default API address), and the visibility blanking and the online/offline report do not run. Linux packages escape this only because `electron-builder.yml` launches them with `--no-sandbox`. Reproduced with Electron 44.3.0 on macOS arm64 from the development tree; the installed IPFS Desktop app was not run. |
| `isWebUiUrl` in `src/webui/index.js` and the origin test in `src/webui/open-external.js` compare `new URL(x).origin` to `webui://localhost`. Node reports `origin` as the string `"null"` for a non-special scheme, so both comparisons are always false. | `node -e "console.log(new URL('webui://localhost/#/x').origin)"` prints `null`, also under `ELECTRON_RUN_AS_NODE` with Electron 44.3.0. **Not changed by this work**; `src/webui/security.js` exports a correct `isWebUiUrl` that the bridge uses, for whoever fixes the other two. |

## 2. What breaks with `webSecurity: true`

One thing breaks, and it breaks everything: **the browser now enforces CORS on the Web UI's
calls to the RPC API**, and Kubo does not list `webui://localhost` as an allowed origin.

Probe, `webSecurity: true` with the CSP, node allowing only `https://webui.ipfs.io`:

```
FAIL  files: files/ls            [status 0 TypeError: Failed to fetch]
FAIL  explore: dag/get           [status 0 TypeError: Failed to fetch]
FAIL  peers: swarm/peers         [status 0 TypeError: Failed to fetch]
FAIL  settings: config/show      [status 0 TypeError: Failed to fetch]
FAIL  add: add (multipart POST)  [status 0 TypeError: Failed to fetch]
FAIL  pin: pin/add               [status 0 TypeError: Failed to fetch]
FAIL  pin: pin/ls                [status 0 TypeError: Failed to fetch]
FAIL  route #/files ... [hash #/welcome ... failed /api/v0/stats/bw net::ERR_FAILED]
console: Access to fetch at 'http://127.0.0.1:55272/api/v0/stats/bw' from origin
'webui://localhost' has been blocked by CORS policy: No 'Access-Control-Allow-Origin'
header is present on the requested resource.
```

The Web UI then bounces every route to `#/welcome`.

Nothing else in the smoke set depends on `webSecurity`: the page loads from its own scheme,
loopback `http://` is a potentially trustworthy origin so there is no mixed-content block
(`allowRunningInsecureContent` stays false), the preload and IPC are unaffected, and `file:`
URLs are not used.

### The CORS configuration that keeps the Web UI working

Add exactly one origin to the node's `API.HTTPHeaders["Access-Control-Allow-Origin"]`:
`webui://localhost`. Kubo already enforces this list for browsers (`allowOrigin` in
go-ipfs-cmds), it is an existing config key, and no Kubo behavior or default changes.

IPFS Desktop owns the config of the repos it creates, so it writes the origin itself:

- New repos: `applyDefaults` in `src/daemon/config.js` writes
  `{"Access-Control-Allow-Origin": ["webui://localhost"]}` (before: `{}`), so the first launch
  works. Without this a new repo would break until the second launch, because
  `migrateConfig` does not run on the launch that creates the repo.
- Existing repos: `migrateConfig` revision 9 appends `webui://localhost` to the existing
  list (accepting a single string or a missing block), keeps every other origin, and never
  repeats it. Covered by `test/unit/daemon-config.spec.js`.
- Operators who run Desktop against a remote or hand-managed node must add the origin
  themselves: `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["webui://localhost"]'`
  (keep any origins already there). Desktop does not rewrite the config of a repo it did not create.

Consequence worth knowing: the Web UI's Settings page lets a user point the UI at a different
API address. With the CSP, `connect-src` names only the daemon's own API origin, so Desktop's
Web UI talks to its own node only. That is intended (G11-4) and is a behavior change.

## 3. Smoke baseline (task 1.1)

Method, same for every column: `test/hardening/run-probe.js` starts a throwaway Kubo (binary
from the kubo repo build, `ipfs init --profile=test`, own `IPFS_PATH`, API/Gateway/Swarm on
OS-assigned ports, no bootstrap peers, no discovery) and an Electron instance (Electron 44.3.0)
with an isolated `userData` and `HOME`, loads the bundled Web UI from `webui://localhost`
and drives it with Playwright. A request guard cancels anything aimed at 4001, 5001 or 8080,
and the runner aborts if the node itself lands on one. "RPC from the page" means a `fetch` made
by the page's own JavaScript from origin `webui://localhost`, so it exercises CORS exactly as
the Web UI's calls do. "Route renders" means the hash stays on the requested route (the Web UI
bounces to `#/welcome` when it cannot reach the API), no `/api/v0` call fails, and the page has
content. It does **not** click through the UI; see section 8.

| Smoke item | Check | Before (`webSecurity:false`, no CSP) | After, node without the CORS origin | After, node with `webui://localhost` |
| --- | --- | --- | --- | --- |
| Files | `files/ls`; route `#/files` | pass; pass | FAIL; FAIL | pass; pass |
| Explore | `dag/get` of a just-added CID; route `#/explore` | pass; pass | FAIL; FAIL | pass; pass |
| Peers | `swarm/peers`; route `#/peers` | pass; pass | FAIL; FAIL | pass; pass |
| Settings | `config/show`; route `#/settings` | pass; pass | FAIL; pass (static page) | pass; pass |
| Add | `add` multipart POST | pass | FAIL | pass |
| Pin | `pin/add`, `pin/ls` | pass; pass | FAIL; FAIL | pass; pass |
| Status | route `#/` | pass | FAIL | pass |
| Window and Web UI load from `webui://localhost` | URL and title | pass | pass | pass |
| Preload bridge `window.ipfsDesktop` | object present | **FAIL (pre-existing, section 1)** | pass (preload fixed) | pass |
| CSP header present | `content-security-policy` on a `webui://` response | n/a (absent) | pass | pass |
| External fetch blocked | `fetch('https://csp-probe.invalid/x')`, CSP violation event | FAIL (not blocked) | pass | pass |
| Inline script, remote script, `eval` blocked | script elements, `eval('1+1')` | FAIL (all run or load) | pass | pass |
| CSP violations while using the Web UI | `securitypolicyviolation` events across the five routes | none (no CSP) | none | none |

Totals from the probe: before 20/26 on the original tree (the six failures are the preload
bridge, the preload console error and the four containment checks; every RPC and route item
passes); after, without the origin, 16/27; after, with the origin, 27/27. Commands and full output are in
section 7. The "before" column for the preload row was recorded against the unmodified
`preload.js`; `git show HEAD:src/webui/preload.js` is that file.

## 4. The CSP (task 1.2)

Served by `installCsp` in `src/webui/security.js` on every `webui://localhost` response, from
`session.defaultSession.webRequest.onHeadersReceived`. The origins are read per response from
the running daemon, so a restart on a new port applies on the next load. Built by `buildCsp`;
only `http(s)` origins without credentials or wildcards are accepted, so a bad value can only
narrow the policy.

```
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: <gateway origin>;
media-src 'self' blob: <gateway origin>;
font-src 'self' data:;
connect-src 'self' <api origin> <gateway origin> [<ipfs mcp origin>];
worker-src 'self' blob:; manifest-src 'self';
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- No `unsafe-eval`, no `unsafe-inline` for scripts, no remote asset origin, no wildcard.
- `connect-src` lists the daemon's API origin, its gateway origin, and, only when the agent chat
  is on, the one `ipfs mcp` origin the operator configured. The island is loaded by dynamic
  import from `webui://localhost/agent-chat/...`, so `script-src 'self'` covers it.
- `'wasm-unsafe-eval'`: the probe showed a `script-src wasm-eval` violation without it. It
  lets WebAssembly compile; it does not allow `eval` or `new Function` (the probe confirms
  `eval` is blocked). Which Web UI feature needs it was not traced.
- `style-src 'unsafe-inline'`: required. With `style-src 'self'` the probe reported seven
  `style-src-elem inline` violations across the routes, because the Web UI injects `<style>`
  elements. It does not permit script execution; the exfiltration surface it opens is bounded
  by the `img-src`, `connect-src` and `font-src` lists above.
- The gateway origin is in `img-src`/`media-src` for file previews and in `connect-src` for
  the Web UI's gateway checks. `frame-src 'none'` means an in-page iframe preview (for example a
  PDF served from the gateway) is blocked; not exercised by the smoke (section 8).

### G11-2 verification

```
PASS  external fetch is blocked by CSP connect-src  [fetch rejected; violations: connect-src https://csp-probe.invalid/x]
PASS  inline script does not run                    [ran=false]
PASS  remote script is blocked by CSP script-src    [script-src-elem inline | script-src-elem https://csp-probe.invalid/a.js | script-src eval]
PASS  eval is blocked (no unsafe-eval)              [eval -> blocked]
PASS  CSP violations while using the Web UI (expected none)  [none]
```

and the smoke table above is green with the origin present. `webSecurity` is `true`, set by
`webPreferences()` in `src/webui/security.js` (`test/unit/webui-security.spec.js` pins it, with
`contextIsolation`, `sandbox`, `nodeIntegration: false`, `webviewTag: false`). Only
`NODE_ENV=test` can pass `allowNodeIntegration`, as before, and that drops the sandbox for the
existing e2e tests only.

## 5. The `safeStorage` token bridge (task 1.3, G11-4)

### Parts

| File | Role |
| --- | --- |
| `src/agent/settings.js` | Reads `agentChat.enabled` and `agentChat.endpoint` from the Desktop store. `agentChat.enabled` is written as `true` at app start when the store lacks the key (`src/agent/defaults.js`); the endpoint is empty by default. The chat is on only when the switch is `true` AND the endpoint is valid (https, or http on loopback; path ends `/agui`; no credentials, query or fragment; the island's own rules). A half-configured chat behaves as off. |
| `src/agent/token-store.js` | The bearer for the chat's `ui` principal. Encrypted with `safeStorage`, kept as base64 ciphertext in the store key `agentChat.tokenCipher`. Refuses to store when `isEncryptionAvailable()` is false or, on Linux, when the backend is `basic_text` or `unknown` (a fixed key is no protection). Never logs a token. A ciphertext that no longer decrypts reads as no token. |
| `src/agent/bridge.js` | Registers two `ipcMain.handle` channels, only when the chat is enabled. Each answers only the Web UI window's own `webContents`, only its main frame, only while that frame's URL is `webui://localhost`. Anything else gets `undefined`/`null`. |
| `src/webui/preload.js` | Exposes `window.ipfsDesktop.agentChat = { getEndpoint(), getToken() }` (frozen) only when the window was created with `--ipfs-desktop-agent-chat=1`, which the main process passes only when the chat is enabled. No setter, no storage, no event. |

The preload is now self-contained (section 1): it requires only `electron`; the version and
Countly key arrive as `additionalArguments`, and its copies of the IPC names are checked against
`src/common/ipc-main-events.js` and `src/agent/consts.js` by `test/unit/webui-security.spec.js`.

### Off switch (and what "off" means)

Default: `agentChat.enabled` is written `true` at start, but with no endpoint, no `agentChat` key on
`window.ipfsDesktop`, no IPC channel in the main process, and no `ipfs mcp` origin in the CSP.
It is read once at window creation: a change applies on the next launch. Disabled state is
tested at three levels: unit (`test/unit/agent-chat.spec.js`: no `ipcMain.handle` call),
probe C and D (`test/hardening/run-agent-probe.js`: no bridge key, `ipcMain._invokeHandlers`
holds neither channel, a fetch to the former mcp origin is CSP-blocked, and "on but no
endpoint" behaves as off).

To turn it on today an operator edits the Desktop `config.json` (tray: Advanced, Open config
file): `"agentChat": { "enabled": true, "endpoint": "http://127.0.0.1:<port>/agui" }`, then
restarts. **There is no user path yet to put the token into `safeStorage`**: that is the
pairing flow in task 1.4, which depends on `native-confirmation-prompt`. `tokenStore.set` is
the call it will use. I deliberately did not add a tray item or a renderer setter: a renderer
that can set the token or the endpoint can widen its own CSP.

### Defaults: the agent features ship on, an opt-out survives

Kubo's `AGENTS.md` (User Agency) lists the agent features that are the fork's purpose as on by
default, each with an off switch. At every app start `src/agent/defaults.js` writes `true` for
`agentChat.enabled`, `desktopConfirm.enabled` (never on Windows, where Node cannot reach the
server's Unix socket) and `mcpSidecar.enabled`, **only for a key the store does not hold**. Any stored
value, `false` above all, is the operator's decision and is not rewritten, now or on any later start.
Deleting a key gives the default again. The line logged when it writes names the keys and the way off.

| Feature | On by default | Off switch | Disabled-state test |
|---------|---------------|------------|---------------------|
| Local `ipfs mcp` endpoint (sidecar) | yes, `mcpSidecar.enabled` | tray "Run the local agent endpoint", or `false` in `config.json` | `test/unit/mcp-sidecar.spec.js`, `test/unit/agent-defaults.spec.js` |
| Web UI agent chat | switch yes; inert until `agentChat.endpoint` is set | `agentChat.enabled: false` | `test/unit/agent-chat.spec.js`, `test/unit/agent-defaults.spec.js` |
| Desktop confirmation window | yes (not on Windows) | tray "Confirm agent writes in this app", or `desktopConfirm.enabled: false` | `test/unit/agent-confirm.spec.js`, `test/unit/agent-defaults.spec.js` |
| Agent settings bridge | yes, `agentSettings.enabled` | `agentSettings.enabled: false` | `test/unit/agent-settings-bridge.spec.js` |

Writes still need a confirmation, and no third-party service is enabled without the operator choosing it.
With the confirmation window on and no pairing key, the pairing window opens in the back (no focus steal).

### Off switches of the agent endpoint and its settings bridge

Both are Desktop store keys in `config.json` (tray: Advanced, Open config file). They are
plain booleans, on by default, and only the literal `false` turns a feature off. Both are
read at launch (the bridge) or applied live (the sidecar), as noted.

| Key | What `false` removes | How to set it |
|-----|----------------------|---------------|
| `mcpSidecar.enabled` | The supervised `ipfs mcp` child: no process, no bound port, no desktop-ui or desktop-admin principal in use, so nothing for the settings bridge to talk to. The tray item "Run the local agent endpoint" writes this key and applies it at once; a hand edit takes effect on the next sidecar start. | Tray: untick "Run the local agent endpoint", or `"mcpSidecar": { "enabled": false }` in `config.json`. |
| `agentSettings.enabled` | The settings bridge: the window is created without the `--ipfs-desktop-agent-settings=1` flag, so `window.ipfsDesktop.agentSettings` does not exist; no `ipcMain.handle` channel for it is registered; the change stream to the sidecar is never opened; the sidecar's loopback origin is not added to the CSP. The sidecar itself keeps running (it is `mcpSidecar.enabled` that stops it). | `"agentSettings": { "enabled": false }` in `config.json`, then restart IPFS Desktop (read once per launch). |

With `mcpSidecar.enabled` false every bridge call answers that the local agent endpoint is not running. Both disabled states are covered by
`test/unit/agent-settings-bridge.spec.js`.

The sidecar reports a `starting` state from the spawn until the child prints its bound address.
In that window the bridge sends nothing to the port (the port is a request, not yet a fact), and
every spawn gets a fresh `desktop-admin` token, held as safeStorage ciphertext for the life of that child.

### Where the token is, and is not

- In the main process, in memory, only while a handler is answering.
- On disk as `safeStorage` ciphertext in the Desktop store. Probe A/B: the plaintext token is in
  no file under `userData`, including Chromium's leveldb and cache directories.
- In the renderer only inside the island's private field, after the island calls
  `getToken()`; never in `localStorage`, `sessionStorage`, cookies, IndexedDB or CacheStorage
  (probe A/B audit of 96701 serialized bytes).
- Strength depends on the OS (design.md): macOS Keychain is app-bound; Windows DPAPI binds to
  the user account; Linux libsecret/KWallet is readable by other same-user processes. Documented,
  not fixable here.

### Exact wiring needed in the Web UI fork (not edited, per the design)

The island already has the hook: `el.tokenProvider = () => string | Promise<string | undefined>`
(`mcp/chat/src/element.ts`, read per request, private field). In
`ipfs-webui/src/agent-chat/`:

1. `AgentChatLauncher.js`, both places that set `el.token = token`: when
   `globalThis.ipfsDesktop?.agentChat` exists, set `el.tokenProvider = bridge.getToken` and do
   not set `el.token`.
2. The endpoint: when the bridge exists, take it from `await bridge.getEndpoint()` instead of
   `localStorage` (`settings-store.js`), because the CSP is built from Desktop's value; a
   different value typed in Settings would be blocked. `enabled` should follow the bridge
   (present means on).
3. `AgentChatSettings.js`: when the bridge exists, hide the token field and the endpoint field
   (Desktop owns both).
4. A launcher test with a fake `window.ipfsDesktop.agentChat` and a launcher test without one
   (the disabled-state test already there stays).

Browser `/webui` is unchanged: no bridge, token in memory only, as now.

A stronger alternative the security reviewer may prefer: let the main process add the
`Authorization` header itself in `webRequest.onBeforeSendHeaders` for requests to the mcp
origin, so the token never reaches renderer memory at all. It was not done because the ADR says
"attaches it through a new preload bridge method" and the island's `tokenSet` contract expects a
provider; it needs a placeholder value in the island and a CORS preflight allowing `authorization`.

## 6. Files

New: `src/webui/security.js`, `src/agent/{consts,settings,token-store,bridge}.js`,
`test/unit/{webui-security,agent-chat}.spec.js`, `test/hardening/{probe-main,run-probe,run-agent-probe}.js`,
this file.
Changed: `src/webui/index.js` (webPreferences, CSP, bridge wiring), `src/webui/preload.js`
(self-contained, agent bridge), `src/daemon/config.js` (CORS origin, revision 9),
`test/unit/daemon-config.spec.js`, `test/e2e/launch.e2e.test.js` (expected CORS lists).
Removed: `src/webui/connection-status.js` (inlined into the preload).

## 7. Re-running the evidence

```bash
npm test && npm run lint
# needs a kubo binary; defaults to ../kubo/cmd/ipfs/ipfs, override with --ipfs=/path
node test/hardening/run-probe.js --mode=baseline              # shipped options
node test/hardening/run-probe.js --mode=hardened              # webSecurity on, node without the origin
node test/hardening/run-probe.js --mode=hardened --acao-webui # webSecurity on, node with the origin
node test/hardening/run-agent-probe.js                        # token bridge, storage audit, restart, disabled state
```

The probes use `test/hardening/probe-main.js`, not the real main process, so they cover
`security.js`, `preload.js` and `src/agent/*` with the same options the window uses, but not
`src/webui/index.js` itself (section 8). `--mode=baseline` today still uses the fixed
preload; to reproduce the original preload failure, run it with `git stash` on
`src/webui/preload.js` or check out `HEAD:src/webui/preload.js`.

## 8. Not verified

- The full app (`src/index.js`) was not launched: `npm run test:e2e` needs the `kubo` npm
  binary (`node_modules/kubo/bin` is absent here), opens real windows, and starts the app's
  own daemon and analytics. `src/webui/index.js` wiring (arguments, `installCsp` call, bridge
  registration, `gatewayAddr` plumbing) is covered by reading and by lint only. Run
  `npm run test:e2e` in CI or on a machine with the kubo binary.
- The installed IPFS Desktop app was not run or modified. The preload defect in section 1 is
  reproduced on the development tree only.
- UI-driven add (file picker), pin from the Files page, image/PDF previews from the gateway,
  the "Check for updates" and Countly paths, IPNS/DNSLink views and the Web UI's remote
  gateway checks are not clicked through. The probe drives the same RPC calls from the page.
  Previews that need `frame-src` are expected to be blocked.
- macOS Keychain, Windows DPAPI and Linux libsecret were not exercised: the probe runs with
  Chromium's mock keychain (`--use-mock-keychain`) so it never touches the login Keychain. The
  ciphertext format, persistence across a restart and the storage audit are real; the OS
  keystore's strength is not tested. The operator should do one real-Keychain run.
- Windows and Linux were not run.

## Model key on a backend kind change (ADR-0012)

On a backend kind change, or a move to another host, the new model key goes with Apply, in `set` as the write-only `backend.api_key` next to `base_url` and the typed `egress_confirmation`; Desktop asks for Touch ID or the native dialog even when the host is unchanged, clears the stored key it held (reported as `key_not_carried`), stores the new key in safeStorage only after the backend write, and restores the previous backend and key if the apply fails; Save key and Remove key (`setApiKey`, `clearApiKey`) ignore `kind` and act on the current backend only. The write response still reports the withheld key as `key_not_carried` with `reason: "host_changed"` for a kind change (ADR-0012 amendment of 2026-10-16: no contract change this round), so Desktop words its notice from the backend kind, not from the reason. A key given to the node by a run flag is not Desktop's and follows as configured.
