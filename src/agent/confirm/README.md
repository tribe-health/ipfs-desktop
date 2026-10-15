# Desktop confirmation window (`desktop-agent-chat` 1.4 to 1.12)

Answers the pending writes of `ipfs mcp` in a native window. It speaks the server's channel
protocol, version 2 (kubo `mcp/server/confirm/MECHANISMS.md`, "Channel authentication,
version 2"); it adds nothing to it.

## Turn it on, turn it off, the way back

It is on by default except on Windows (`src/agent/defaults.js` writes `desktopConfirm.enabled: true` at app start only when the key is absent; a stored `false` is kept) and independent of the agent chat. The tray menu, under Settings, has
**Desktop Confirmations**:

- **Confirm agent writes in this app** (checkbox) turns it on or off. On, with no pairing key, the
  pairing window opens.
- **Pair with ipfs mcp...** opens the pairing window (and turns the feature on first).
- **Remove pairing** forgets the key. The feature stays on and contacts nothing until a key is stored.
- The confirmation window and the pairing window both have **Turn off Desktop confirmations**.

Turning it off is the same as unticking the tray checkbox: it persists `desktopConfirm.enabled: false`
and destroys the windows. The way back is to tick the same checkbox. By hand, in the Desktop store
(`config.json`), `desktopConfirm.enabled` reads as on only for `true`, `1`, `"true"`, `"on"`, `"yes"` or
`"1"`; every other value, including `"false"`, `"off"` and `"0"`, is off. A deleted key is written as `true` again at the next start; keep `false` to stay off.

Not on Windows: Node cannot connect to the server's Unix socket there. The entries are greyed out.

## Pairing

1. Stop `ipfs mcp` (`ipfs mcp pair` refuses while a server holds a confirmation socket).
2. Run `ipfs mcp pair` in a terminal. It prints a key once (43 characters) and keeps only a hash.
3. Enter the key in the pairing window. Desktop keeps it as `safeStorage` ciphertext
   (`desktopConfirm.pairingCipher`) and never makes a key itself.
4. Start the server again with `--confirm=native,desktop`. `desktop` is opt-in on the server too.

If a running server rejects the stored key (for example after pairing again), the pairing window
reopens and says so.

## Protocol (version 2)

`K = SHA-256(key)`. Every request carries `X-IPFS-MCP-Auth-Version: 2`, a timestamp, a random
nonce and `HMAC-SHA-256(K, request string)`; the key is never sent. Every answer must carry
`X-IPFS-MCP-Server-Proof`, checked before one byte of it is read. A socket that cannot prove it holds
the verifier is ignored for the session: nothing from it is shown, nothing is resolved on it.
`channel-client.js` reproduces the specification's test vector (`test/unit/agent-confirm.spec.js`).

Only sockets named `<pid>-<seq>.sock` of live processes, in a directory this user owns that no other
user can write, are used (`IPFS_MCP_CONFIRM_DIR`, else `$XDG_RUNTIME_DIR/ipfs-mcp`, else
`<tmpdir>/ipfs-mcp-<uid>`). Each request has one total deadline.

## What the window does

- It is shown **without taking focus** (`showInactive`; never always on top; the app is not
  activated), and with content protection on.
- **Approve arms only after the window has been in front and focused for 1.5 s**, disarms when it loses
  focus and whenever the request on screen changes (with a notice), and answers only to a trusted
  activation. The main process enforces this; an approval that arrives unarmed is dropped.
- **Approving asks for Touch ID** (`systemPreferences.promptTouchID`, reason: the action and the first
  target). A failed or cancelled prompt sends nothing and leaves the request pending. **On a computer
  without Touch ID (every non-macOS platform, or a Mac without it) this app cannot approve and says so;
  it can still deny.** Approve those requests at the system prompt (`--confirm=native`).
- Deny needs nothing, is never delayed, and is the initial focus. Escape and closing the window deny.
- Each target is shown with its kind (CID, MFS path, key ...) in full, with a marker when the server's
  text was cut. Invisible, joining and bidirectional characters in text from an agent are replaced.
- The log (Desktop's own, local) records each decision with its tool, id, outcome, arming time and
  focus state. It holds no key and no content.

## Isolation

The windows are their own `BrowserWindow`s: in-memory session partition, `contextIsolation`,
`sandbox`, no node integration, no devtools, no webview, no navigation, no new windows, no permission
grants, and a request filter that lets only the files of `ui/` load. Each page carries a CSP with
`default-src 'none'`. The Web UI preload does not know the IPC channels (`CONFIRM_CHANNELS`), and each
handler answers only the main frame of its own window loaded from its own page (`windows.js`). Every
user-facing string comes from i18next (`agentConfirm.*` in `assets/locales/en.json`) through the main
process; the pages hold no text of their own.

## Known limits

- A same-user process that can click can press Approve once it is armed; Touch ID is what it cannot
  supply. Desktop is not a presence resolver and cannot answer a `requires_native_prompt` request.
- The pairing file now holds the key's hash that is also the HMAC key (version 2): keep it private.
- Linux CI has no keyring, so the e2e probe uses a reversible stand-in for `safeStorage` there; the
  store's `isAvailable` rules are not relaxed in the app.

## Tests

- `test/unit/agent-confirm.spec.js`: pairing store, the version 2 vector and client, controller,
  Touch ID flows, arming and window behaviour (fake `BrowserWindow`), manager and tray actions,
  disabled state, strings, colour contrast of the window.
- `test/e2e/agent-confirm.e2e.test.js` (`npm run test:e2e:agent`): a real `ipfs mcp --confirm=desktop`
  against a throwaway offline node; needs the kubo binary (`IPFS_KUBO_BIN`, else
  `../kubo/cmd/ipfs/ipfs`). The probe's windows are off-screen, transparent and deaf to OS mouse events.
