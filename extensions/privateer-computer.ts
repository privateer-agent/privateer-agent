// GUI control for Pi's TUI: see the screen, move the mouse, type.
//
// Registered ONLY when the machine has been armed — `privateer --allow-computer-control`,
// or the desktop's Screen control switch. Omitting the factory rather than hiding the
// tools is the same call privateer-media.ts makes for the same reason: a tool that
// exists and refuses every call teaches the model to keep retrying, where a tool that
// isn't there makes it say what the user would need to do and move on.
//
// A SUBAGENT CHILD NEVER GETS THESE, and unlike media there is no grant that lifts it.
// A child is a headless process with nobody to approve an action, and every computer
// action asks (permissions/mode.ts) — so the tools could only ever wedge on a prompt
// with no one to answer it. Media has childSpend.ts because a parent can meaningfully
// pre-authorize a bounded, billed call it named itself; there is no equivalent for
// "click wherever you decide to click", and inventing one would be inventing the
// unattended GUI agent this whole design is arranged to avoid.
import { makeComputerTools } from "../src/tools/computer.ts";
import { computerControlArmed } from "../src/config/computerControl.ts";
import { isSubagentChild } from "../src/remote/subagentRelay.ts";

export default function privateerComputer(pi: any): void {
  if (!computerControlArmed()) return;
  if (isSubagentChild()) return;
  makeComputerTools()(pi);
}
