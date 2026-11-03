// `node --import` preload for every Pi process privateer starts (the TUI, -p runs,
// subagent children): installs the session codec (bin/session-seal.mjs) BEFORE
// Pi's main() opens a session, which happens before any extension loads — so an
// extension is too late for this, and a preload is the only place it fits.
//
// A key file that exists but can't be read is NOT papered over with a new key (that
// would orphan every sealed session). Sealing stays off for this run, the agent
// tells the user (extensions/privateer-recovery.ts reads the reason below), and Pi
// writes plaintext exactly as it did before sealing existed.

import os from "node:os";
import path from "node:path";
import { installCodec } from "./session-seal.mjs";

const home = process.env.PRIVATEER_HOME || path.join(os.homedir(), ".privateer");
const result = installCodec(home);
if (!result.ok) globalThis[Symbol.for("privateer.sessionCodecError")] = result.error;
