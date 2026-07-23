# MCP over the relay — live verification

Everything in this feature is typecheck-clean and covered by automated checks, but until
you run this, **no MCP frame has crossed a real relay to a real harbor.** This is the
checklist that closes that.

It is ordered so each step can only fail in one place. Don't skip ahead — if step 2
fails, step 4's failure tells you nothing new.

Automated coverage that already passes (run these first; they're free):

```bash
# agent: control logic, projection, secret-hiding
cd privateer-agent && node --import tsx --test tests/mcpControl.test.ts

# agent: app-signer ⇄ agent-verifier contract (incl. the sealedSecrets:null case)
node --import tsx --test tests/accountVerify.test.ts

# integration: REAL client seal/sign ⇄ REAL agent verify/open ⇄ config projection
cd ../treeview/desktop && node --import tsx scripts/check-mcp-relay.mjs
```

Those cover the crypto and the config layer. What they **cannot** cover — and what this
document exists for — is: the relay actually routing `mcp_*` frames, the harbor's
callbacks firing, the adapter really spawning a server, and MCP tools passing the moat.

---

## Prerequisites

- A computer signed in to Privateer with the harbor running: `privateer harbor`
  (or `privateer harbor install` for the always-on service).
- The phone or web app signed in to the **same account**, with that machine linked.
- The harbor's terminal appears in the app as **Privateer Routines** (`routines-…`).

Useful throughout — watch the harbor while you drive from the phone:

```bash
tail -f ~/.privateer/harbor.log     # adjust if your log path differs
```

Config the harbor reads (both should change as you act from the app):

```bash
cat ~/.privateer/agent/mcp-desktop.json   # source of truth, incl. `enabled`
cat ~/.privateer/agent/mcp.json           # projection the adapter reads
```

**Isolating the relay from everything else.** Since 0.6.9 the terminal edits those two
files directly, through `/connect` — the same makeMcpControl() the relay drives, minus
the relay. So you can set a connector up locally, confirm it *runs* (step 5 is the part
worth caring about), and only then bring the phone in. If `/connect` can add a working
GitHub connector but the app can't, the fault is in the frame plumbing or the seal, and
steps 1–4 below will tell you which. If `/connect` can't either, nothing about the relay
is involved and step 5 is where to look.

Note that `/connect` deliberately does NOT exercise the sealed-box path — on this
machine the credential is simply written in plaintext, which is what the adapter needs.
Step 3 remains the only test of the seal.

---

## Step 1 — The screen loads and the list round-trips

Open the app → **Code** tab → the harbor card → **MCP connectors**.

- [ ] The screen opens and does not sit on "Connecting…"
- [ ] Any connectors already in `mcp-desktop.json` are listed

**Proves:** relay routing works for a new frame type, `mcp_list` reaches
`onMcpList`, and `sendMcp` comes back and parses.

If it hangs on "Connecting…", the drive session isn't focused on the harbor terminal —
that's navigation/`familyId`, not MCP. If it connects but the list is empty when the file
isn't, the failure is in `sendMcp` / the `mcp` frame parser.

## Step 2 — Add a connector with NO credential

Quick-add → **Memory** (or any `needs: none` entry) → Save.

- [ ] The editor closes on its own (the "Saved…" result line drives that)
- [ ] It appears in the list, toggle on
- [ ] `mcp.json` on the host now contains it

**Proves:** `mcp_save` signs, verifies, and persists — with the sealed-box path *not*
exercised. This is the clean separation: if step 3 later fails, it's the crypto, not the
frame plumbing.

If it fails here with a refusal message, read it — the harbor's copy distinguishes
"couldn't verify this change came from your account" (signature) from a validation error.

## Step 3 — Add a connector WITH a credential

Quick-add → **GitHub** → paste a real PAT → Save.

- [ ] The credential field was editable (if it was read-only, this terminal isn't
      "sealable" — its identity key doesn't match the link-time pin; re-link it)
- [ ] Saves cleanly
- [ ] `mcp.json` on the host shows the token **in plaintext** — correct, it's on your own
      machine, that's where it has to be for the adapter to use it
- [ ] Back in the app, the connector shows "Credentials set" and **never** displays the
      token itself

**Proves:** the seal → relay → unseal path works against a real terminal keypair, and
the non-secret projection holds.

**The privacy check worth doing once:** the server must never see that token. It's a
blind forwarder, so the strongest practical evidence is that the app only ever transmits
a sealed box — confirmed by the harness (`token is NOT present in the wire frame`). If
you want to see it directly, watch the relay frames in the app's dev console and confirm
`sealedSecrets` is opaque base64 and no field carries the PAT.

## Step 4 — Toggle and remove

- [ ] Toggle the connector off → it disappears from `mcp.json` but stays in the app list
- [ ] Toggle on → returns to `mcp.json`
- [ ] Remove → gone from both

**Proves:** `mcp_set_enabled` / `mcp_remove` sign and apply, and the projection tracks.

## Step 5 — The connector actually runs (the Phase-5 wiring)

This is the one that proves MCP *executes*, not just that config was written.

With the GitHub (or Memory) connector enabled, spawn a task from the app that needs it —
**Spawn a task**, with a prompt that forces a tool call, e.g.
*"List my most recent GitHub issues."* If the routine/task takes an explicit tool list,
include the MCP tool by its `server__tool` name (e.g. `github__list_issues`); the
allow-list now passes `split.mcp` through.

- [ ] The harbor log shows the MCP server starting (an `npx` child process for stdio)
- [ ] The task result reflects real MCP data, not a refusal or a hallucination
- [ ] A tool the routine did **not** list is still refused

**Proves:** `runSession` loads the adapter, the moat gates MCP tools like any other, and
the signed tool list is the real authorization boundary.

This is the most likely step to surface something, because it's the least covered by
automated checks. Expect first-run `npx` download latency.

## Step 6 — OAuth connector (only if you use one)

Add **Linear** (or any `needs: oauth` entry) from the phone.

- [ ] The amber callout appears naming the host machine
- [ ] Saving works, but its tools fail until you authorize
- [ ] Open Privateer **on the host computer**, authorize in the browser
- [ ] The harbor can now use it — tokens land in
      `~/.privateer/agent/mcp-oauth/sha256-<hash>/tokens.json` and are shared with the
      desktop app, and refresh headlessly from there

**Known limitation, not a bug:** the harbor can't *initiate* that browser flow itself.
On a genuinely headless host (VPS/container) an OAuth connector can't be authorized at
all. See `mcp-over-relay` notes for the options if that ever matters.

---

## If something fails

| Symptom | Look at |
|---|---|
| Screen stuck "Connecting…" | drive session / `familyId`, not MCP |
| List empty but file isn't | `sendMcp` payload, `mcp` frame parser in `RemoteDriveContext` |
| "Couldn't verify this change came from your account" | signature — app `signControlFrame` args vs harbor `authorizeControl` args must canonicalize identically |
| "Couldn't decrypt the connector credentials" | sealed to the wrong terminal key — re-link to re-pin |
| "This terminal can't accept changes… re-link it" | no pinned account key on that terminal |
| Saves fine, tools never fire | Step 5 — adapter loading or the tool allow-list, not the relay |

Record what you find in the `mcp-over-relay` memory so the next pass starts from reality
rather than from this checklist's assumptions.
