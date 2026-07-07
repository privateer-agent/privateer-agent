// The Privateer account provider as a Pi extension (for `-e` into Pi's TUI).
// Registers the `privateer` subscription channel when a machine login exists; Pi's
// own OAuth /login flow drives the child-session credential.
import { makeAccountProvider } from "../src/providers/account.ts";

export default makeAccountProvider();
