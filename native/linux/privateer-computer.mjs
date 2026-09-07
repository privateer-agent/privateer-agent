#!/usr/bin/env node
/**
 * privateer-computer (Linux) — the Linux screen-control helper.
 *
 * Same newline-delimited JSON protocol as the macOS and Windows helpers; the client is
 * src/computer/helper.ts and the coordinate contract is src/computer/space.ts. Read that
 * file before changing anything here.
 *
 * ── Why this one is a script and not a compiled binary ───────────────────────
 *
 * There is no Linux equivalent of CGEvent or SendInput — no single system API that every
 * desktop implements. X11 has XTEST, Wayland deliberately has nothing (a client cannot
 * see or synthesise input outside its own surface, which is a security property, not an
 * oversight). What exists instead is a set of small, standard command-line tools that
 * already hold the necessary privileges. Shelling out to those is not a shortcut around
 * writing a real helper; it IS the Linux way to do this, and it means no compiler, no
 * per-distro binary, and nothing to keep signed.
 *
 * The cost is that they must be installed, so every one is PROBED and the absence is
 * reported as a sentence naming the package — the posture the sprite pipeline's ffmpeg
 * probe already takes. A missing tool must never surface as a spawn error at the moment
 * the user asks for something.
 *
 * ── What is supported, honestly ──────────────────────────────────────────────
 *
 *   X11      — fully. xrandr to enumerate, xdotool for input, and any of
 *              ImageMagick / maim / ffmpeg to capture.
 *   Wayland  — wlroots compositors only (Sway, Hyprland, river): wlr-randr + grim +
 *              ydotool. GNOME and KDE on Wayland expose no generic screenshot or input
 *              CLI at all — everything goes through xdg-desktop-portal, which is an
 *              interactive, per-request consent flow that cannot serve an agent loop.
 *              Those sessions are told exactly that rather than being left to fail.
 *
 * ── The exact-size rule ──────────────────────────────────────────────────────
 *
 * A capture MUST come back at exactly the requested size, because that size defines the
 * coordinate space the model is given. Unlike CoreGraphics and System.Drawing, nothing
 * here resizes natively — so when no resizer is installed the capture is REFUSED. It is
 * tempting to return the native frame instead; that would put agent space and the
 * picture into silent disagreement and every click would be off by the reduction factor.
 */

import { spawnSync } from 'node:child_process';

// ─── Frames ──────────────────────────────────────────────────────────────────
// stdout carries protocol frames ONLY; diagnostics go to stderr, or the client's line
// reader desynchronises.

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
const ok = (id, fields = {}) => emit({ id: id ?? null, ok: true, ...fields });
const fail = (id, error) => emit({ id: id ?? null, ok: false, error });

// ─── Tool discovery ──────────────────────────────────────────────────────────

const isWayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';

/** Is `bin` on PATH? Cached per process — PATH does not change under us. */
const haveCache = new Map();
function have(bin) {
  if (!haveCache.has(bin)) {
    const r = spawnSync('sh', ['-c', `command -v ${bin} >/dev/null 2>&1`]);
    haveCache.set(bin, r.status === 0);
  }
  return haveCache.get(bin);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { maxBuffer: 128 * 1024 * 1024, ...opts });
}

/** The ImageMagick entry point, which changed name in v7. */
function magick() {
  if (have('magick')) return ['magick'];
  if (have('convert')) return ['convert'];
  return null;
}

// ─── Displays ────────────────────────────────────────────────────────────────

/**
 * X11: `xrandr --listmonitors` is the right source rather than `xrandr --query`, because
 * it reports the MONITOR layout (what the user sees as screens, including any the
 * compositor has combined) with position, in one stable line each:
 *
 *   0: +*eDP-1 1920/344x1080/193+0+0  eDP-1
 *
 * The `*` marks the primary. The `/344` and `/193` are physical millimetres and are
 * deliberately ignored — they are the panel's size, not its pixels.
 */
function x11Displays() {
  const r = run('xrandr', ['--listmonitors']);
  if (r.status !== 0) return [];
  const out = [];
  for (const line of String(r.stdout).split('\n')) {
    const m = line.match(/^\s*\d+:\s+\+(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/);
    if (!m) continue;
    out.push({
      id: m[2],
      label: m[2],
      width: Number(m[3]),
      height: Number(m[4]),
      // X11 hands out one flat pixel grid; there is no per-monitor scale factor in the
      // coordinate space xdotool works in, so this is always 1 and the agent never
      // converts through it.
      scale: 1,
      originX: Number(m[5]),
      originY: Number(m[6]),
      primary: m[1] === '*',
    });
  }
  return out;
}

/**
 * Wayland (wlroots): `wlr-randr --json` where available, falling back to its text form.
 * Both report logical size and scale; the agent's device pixels are logical x scale,
 * which is what grim writes.
 */
function waylandDisplays() {
  if (!have('wlr-randr')) return [];
  const asJson = run('wlr-randr', ['--json']);
  if (asJson.status === 0) {
    try {
      const parsed = JSON.parse(String(asJson.stdout));
      return parsed
        .filter((o) => o.enabled !== false)
        .map((o, i) => {
          const mode = (o.modes || []).find((m) => m.current) || {};
          const scale = Number(o.scale) || 1;
          return {
            id: o.name,
            label: o.description || o.name,
            width: Math.round(Number(mode.width) || 0),
            height: Math.round(Number(mode.height) || 0),
            scale,
            originX: Math.round(Number(o.position?.x) || 0),
            originY: Math.round(Number(o.position?.y) || 0),
            primary: i === 0,
          };
        })
        .filter((d) => d.width > 0 && d.height > 0);
    } catch {
      /* fall through to the text parser */
    }
  }

  // Text form: an output name at column 0, then indented fields until the next name.
  const r = run('wlr-randr', []);
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of String(r.stdout).split('\n')) {
    const head = line.match(/^(\S+)\s+"(.*)"/);
    if (head) {
      if (cur) out.push(cur);
      cur = { id: head[1], label: head[2] || head[1], width: 0, height: 0, scale: 1, originX: 0, originY: 0, primary: out.length === 0 };
      continue;
    }
    if (!cur) continue;
    const pos = line.match(/Position:\s*(-?\d+),(-?\d+)/);
    if (pos) { cur.originX = Number(pos[1]); cur.originY = Number(pos[2]); }
    const scale = line.match(/Scale:\s*([\d.]+)/);
    if (scale) cur.scale = Number(scale[1]) || 1;
    const mode = line.match(/(\d+)x(\d+)\s+px.*current/);
    if (mode) { cur.width = Number(mode[1]); cur.height = Number(mode[2]); }
  }
  if (cur) out.push(cur);
  return out.filter((d) => d.width > 0 && d.height > 0);
}

function displays() {
  return isWayland ? waylandDisplays() : x11Displays();
}

function findDisplay(id) {
  const all = displays();
  if (!id) return all.find((d) => d.primary) ?? all[0];
  return all.find((d) => d.id === id);
}

// ─── Grants ──────────────────────────────────────────────────────────────────
//
// Linux has no TCC. "Granted" here means the tools that do the work are actually
// present — which is the same question from the user's point of view (can it act?) and
// the only one with an answer we can give honestly.

function screenTool() {
  if (isWayland) return have('grim') ? 'grim' : null;
  if (have('import')) return 'import';
  if (have('maim')) return 'maim';
  if (have('ffmpeg')) return 'ffmpeg';
  return null;
}

function inputTool() {
  if (isWayland) return have('ydotool') ? 'ydotool' : null;
  return have('xdotool') ? 'xdotool' : null;
}

function grants() {
  return {
    screen: !!screenTool() && !!magick(),
    input: !!inputTool(),
    // No Linux equivalent of macOS secure input: nothing tells a client that a password
    // field has focus. Reported false rather than guessed.
    secureInput: false,
    frontmostPid: frontmostPid(),
  };
}

/**
 * The pid of the focused window's process, for the caller's refuse-to-click-our-own-
 * window interlock. X11 only — Wayland gives a client no way to ask what else is
 * focused, which is the point of Wayland. Absent rather than wrong.
 */
function frontmostPid() {
  if (isWayland || !have('xdotool')) return undefined;
  const r = run('xdotool', ['getactivewindow', 'getwindowpid']);
  if (r.status !== 0) return undefined;
  const pid = Number(String(r.stdout).trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/** Why screen control cannot work here, as a sentence naming the fix. */
function missingReason() {
  if (isWayland && !have('grim')) {
    return (
      'This is a Wayland session with no grim. Screen control on Wayland is supported on ' +
      'wlroots compositors (Sway, Hyprland, river) — install grim, wlr-randr and ydotool. ' +
      'GNOME and KDE on Wayland expose no screenshot or input command at all (everything ' +
      'goes through xdg-desktop-portal, which asks the user per request), so an X11 ' +
      'session is the only option there.'
    );
  }
  if (!screenTool()) return 'No screen capture tool. Install ImageMagick, maim or ffmpeg.';
  if (!magick()) return 'No image resizer. Install ImageMagick (it provides `magick`, or `convert` on v6).';
  if (!inputTool()) {
    return isWayland
      ? 'No ydotool, so the mouse and keyboard cannot be driven. Install ydotool and start ydotoold.'
      : 'No xdotool, so the mouse and keyboard cannot be driven. Install xdotool.';
  }
  return null;
}

// ─── Capture ─────────────────────────────────────────────────────────────────

/** The monitor's pixels as a PNG, at native size, on stdout. */
function captureRaw(display) {
  const geom = `${display.width}x${display.height}+${display.originX}+${display.originY}`;
  if (isWayland) {
    const r = run('grim', ['-o', display.id, '-']);
    return r.status === 0 ? r.stdout : null;
  }
  const tool = screenTool();
  if (tool === 'import') {
    // +repage discards the crop's virtual canvas offset. Without it the resize below
    // sees a canvas the size of the whole desktop with the crop placed inside it, and
    // pads the output — so the picture would be right and its geometry wrong.
    const r = run('import', ['-window', 'root', '-crop', geom, '+repage', 'png:-']);
    return r.status === 0 ? r.stdout : null;
  }
  if (tool === 'maim') {
    const r = run('maim', ['-g', geom, '-f', 'png', '/dev/stdout']);
    return r.status === 0 ? r.stdout : null;
  }
  if (tool === 'ffmpeg') {
    const r = run('ffmpeg', [
      '-loglevel', 'error', '-f', 'x11grab',
      '-video_size', `${display.width}x${display.height}`,
      '-i', `${process.env.DISPLAY || ':0'}+${display.originX},${display.originY}`,
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
    ]);
    return r.status === 0 ? r.stdout : null;
  }
  return null;
}

/**
 * Resize to EXACTLY w x h. The `!` suffix is what makes it exact — without it
 * ImageMagick preserves the aspect ratio and returns something a pixel or two off,
 * which is precisely the silent disagreement the size contract exists to prevent.
 * (The plan's aspect already matches the display's, so nothing is distorted; `!` only
 * removes ImageMagick's rounding.)
 */
function resizeTo(png, w, h) {
  const mk = magick();
  if (!mk) return null;
  const r = run(mk[0], [...mk.slice(1), 'png:-', '-resize', `${w}x${h}!`, 'png:-'], { input: png });
  return r.status === 0 ? r.stdout : null;
}

// ─── Input ───────────────────────────────────────────────────────────────────
//
// Display-local pixels → the global desktop, the one conversion this file makes. On X11
// that global space is what xdotool takes directly. ydotool likewise works in absolute
// desktop coordinates.

const BUTTON = { left: 1, middle: 2, right: 3 };

function xdo(args) {
  const r = run('xdotool', args);
  if (r.status !== 0) throw new Error(String(r.stderr || 'xdotool failed').trim());
}

function ydo(args) {
  const r = run('ydotool', args);
  if (r.status !== 0) {
    const err = String(r.stderr || '').trim();
    // The overwhelmingly common failure, and one whose bare message ("failed to open
    // /dev/uinput") sends people to the wrong place.
    if (/uinput|permission|socket/i.test(err)) {
      throw new Error('ydotool cannot reach its daemon — start ydotoold and make sure your user can use /dev/uinput.');
    }
    throw new Error(err || 'ydotool failed');
  }
}

function pointer(req, display) {
  const gx = display.originX + Number(req.x || 0);
  const gy = display.originY + Number(req.y || 0);
  const button = BUTTON[req.button] || 1;

  if (isWayland) {
    ydo(['mousemove', '--absolute', '-x', String(gx), '-y', String(gy)]);
    switch (req.action) {
      case 'move': return;
      // ydotool's click codes are a bitfield: 0x00-0x02 select the button, 0x40 is
      // press and 0x80 is release, so 0xC0|n is a full click.
      case 'click': return ydo(['click', `0x${(0xc0 | (button - 1)).toString(16)}`]);
      case 'double_click':
        ydo(['click', `0x${(0xc0 | (button - 1)).toString(16)}`]);
        return ydo(['click', `0x${(0xc0 | (button - 1)).toString(16)}`]);
      case 'drag': {
        ydo(['click', `0x${(0x40 | (button - 1)).toString(16)}`]);
        const tx = display.originX + Number(req.toX || 0);
        const ty = display.originY + Number(req.toY || 0);
        for (let i = 1; i <= 12; i++) {
          const t = i / 12;
          ydo(['mousemove', '--absolute', '-x', String(Math.round(gx + (tx - gx) * t)), '-y', String(Math.round(gy + (ty - gy) * t))]);
        }
        return ydo(['click', `0x${(0x80 | (button - 1)).toString(16)}`]);
      }
      case 'scroll': {
        const dy = Number(req.scrollY || 0);
        const dx = Number(req.scrollX || 0);
        // ydotool's wheel is positive-up, and the tool's contract is negative-up.
        if (dy) ydo(['mousemove', '--wheel', '-y', String(-dy)]);
        if (dx) ydo(['mousemove', '--wheel', '-x', String(dx)]);
        return;
      }
      default: throw new Error(`unknown pointer action "${req.action}"`);
    }
  }

  xdo(['mousemove', String(gx), String(gy)]);
  switch (req.action) {
    case 'move': return;
    case 'click': return xdo(['click', String(button)]);
    case 'double_click': return xdo(['click', '--repeat', '2', String(button)]);
    case 'drag': {
      const tx = display.originX + Number(req.toX || 0);
      const ty = display.originY + Number(req.toY || 0);
      xdo(['mousedown', String(button)]);
      // Interpolated for the same reason as the other two helpers: a press and release
      // at the destination is ignored by anything that starts its gesture on the first
      // motion event — drag-and-drop, sliders, text selection.
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        xdo(['mousemove', String(Math.round(gx + (tx - gx) * t)), String(Math.round(gy + (ty - gy) * t))]);
      }
      return xdo(['mouseup', String(button)]);
    }
    case 'scroll': {
      const dy = Number(req.scrollY || 0);
      const dx = Number(req.scrollX || 0);
      // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. Negative scrolls UP.
      if (dy) xdo(['click', '--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4']);
      if (dx) xdo(['click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6']);
      return;
    }
    default: throw new Error(`unknown pointer action "${req.action}"`);
  }
}

/** Chord names → the spellings xdotool's `key` understands. */
const XDO_KEYS = {
  return: 'Return', enter: 'Return', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', forwarddelete: 'Delete',
  escape: 'Escape', esc: 'Escape',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
};
const XDO_MODS = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift',
  // super is the Linux equivalent of cmd; accepted so a model that learned "cmd+s"
  // elsewhere does not silently send nothing.
  cmd: 'super', command: 'super', meta: 'super', super: 'super', win: 'super',
};

function keyAction(req) {
  if (req.action === 'type') {
    const text = String(req.text ?? '');
    if (!text) return;
    if (isWayland) return ydo(['type', text]);
    // --clearmodifiers so a modifier the user is physically holding does not turn the
    // typed text into a stream of shortcuts.
    return xdo(['type', '--clearmodifiers', '--delay', '6', text]);
  }
  if (req.action !== 'press') throw new Error('unknown key action');

  const spec = String(req.keys ?? '').toLowerCase().trim();
  if (!spec) throw new Error('empty key combination');
  const parts = spec.split('+');
  const last = parts[parts.length - 1];
  const mods = [];
  for (const p of parts.slice(0, -1)) {
    if (!XDO_MODS[p]) throw new Error(`unknown modifier "${p}" in "${spec}"`);
    mods.push(XDO_MODS[p]);
  }
  let key = XDO_KEYS[last];
  if (!key && /^f\d{1,2}$/.test(last)) key = last.toUpperCase();
  if (!key && last.length === 1) key = last;
  if (!key) throw new Error(`unknown key "${last}" in "${spec}"`);

  const combo = [...mods, key].join('+');
  if (isWayland) return ydo(['key', combo]);
  return xdo(['key', '--clearmodifiers', combo]);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

function handle(req) {
  const id = req.id;
  switch (req.op) {
    case 'displays':
      return ok(id, { displays: displays() });

    case 'grants':
      return ok(id, { grants: grants() });

    case 'capture': {
      const reason = missingReason();
      if (reason && !screenTool()) return fail(id, reason);
      const display = findDisplay(req.display);
      if (!display) return fail(id, 'no such display');
      if (!magick()) return fail(id, 'No image resizer. Install ImageMagick (it provides `magick`, or `convert` on v6).');
      const raw = captureRaw(display);
      if (!raw || !raw.length) return fail(id, 'the display could not be captured');
      const w = Number(req.targetWidth) || display.width;
      const h = Number(req.targetHeight) || display.height;
      const scaled = resizeTo(raw, w, h);
      // Refused rather than answered with the native frame — see the header.
      if (!scaled || !scaled.length) return fail(id, 'the capture could not be resized to the requested size');

      // A second, much smaller copy of the SAME grab for the permission dialog. Same
      // grab deliberately: a separate capture would be a different moment, so someone
      // could be approving a click against a screen the model never saw. Best-effort —
      // the model's frame is already good and the dialog falls back to text.
      const out = { mimeType: 'image/png', data: scaled.toString('base64'), width: w, height: h };
      const pw = Number(req.previewWidth) || 0;
      const ph = Number(req.previewHeight) || 0;
      if (pw > 0 && ph > 0) {
        const small = resizeTo(raw, pw, ph);
        if (small && small.length) out.preview = small.toString('base64');
      }
      return ok(id, out);
    }

    case 'pointer': {
      if (!inputTool()) return fail(id, missingReason() ?? 'no input tool');
      const display = findDisplay(req.display);
      if (!display) return fail(id, 'no such display');
      pointer(req, display);
      return ok(id);
    }

    case 'key': {
      if (!inputTool()) return fail(id, missingReason() ?? 'no input tool');
      keyAction(req);
      return ok(id);
    }

    default:
      return fail(id, `unknown op "${req.op}"`);
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('privateer-computer 1\n');
  process.exit(0);
}

if (argv.includes('--grants')) {
  const reason = missingReason();
  emit({ ok: true, grants: grants(), displays: displays(), ...(reason ? { reason } : {}) });
  process.exit(0);
}

if (!argv.includes('--serve')) {
  process.stderr.write('usage: privateer-computer.mjs --serve | --grants | --version\n');
  process.exit(2);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      fail(null, 'malformed request');
      continue;
    }
    try {
      handle(req);
    } catch (err) {
      // One bad frame must not take the session's screen control with it.
      fail(req?.id, err?.message ? String(err.message) : String(err));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
