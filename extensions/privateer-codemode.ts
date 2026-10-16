// codemode — the model writes a short script that calls tools, and only the script's
// output comes back. It is how Pi's built-in MCP support reaches server tools by
// default, and it runs in a QuickJS sandbox with no file system, network or timers:
// every effect is a tool call, each one sent through the permission gate like a direct
// call (see classifyToolCall).
//
// Loaded here instead of as Pi's `builtin:codemode` (which the launcher turns off) for
// one option: `models: false`. Pi's copy gives scripts a `models` global that runs
// classifier and image models with the session's credentials — model calls the gate
// never sees, to whichever provider has a key, not necessarily the one this session was
// chosen for. Registering a tool named `codemode` replaces the built-in one, and Pi's
// MCP support activates it exactly as it would its own.
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

export default createCodemodeExtension({ models: false });
