#!/usr/bin/env node
// Build dist-boot/ — Pi and the moat extensions compiled into a handful of files, so a
// launch stops paying per-file costs. See docs/startup-performance.md.
//
//   node scripts/build-boot.mjs
//
// WHY. A launch from source loaded ~3,700 modules, ran ~560 TypeScript files through
// Jiti and made ~18,000 stat calls. Almost none of that time was running code: the
// profile was ModuleWrap, read, open and stat, once per file. Node's compile cache
// can't help with that, because it only saves the compile. Fewer files can.
//
// WHAT HAS TO STAY TRUE. The build changes how code is packaged and nothing else:
//   • Every file keeps its own identity. `import.meta.url`, `__dirname` and friends are
//     rewritten to the file's ORIGINAL location in node_modules, so themes, wasm,
//     workers, `createRequire` and package.json lookups behave exactly as from source.
//   • Extensions see the same host modules Pi's loader gives them through Jiti
//     (VIRTUAL_MODULES): one Pi, one Typebox.
//   • Only the first load of a shipped extension comes from here. `/reload` and any
//     user or project extension still go through Jiti (see LOADER_ANCHOR).
//
// It compiles whatever is in node_modules, so it applies the patches first and refuses
// to continue without them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { applyPatchesIfNeeded, resolveDep } from "../bin/apply-patches.mjs";
import { BOOT_DIR } from "../bin/boot-bundle.mjs";

const THIS_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Native addons and anything that locates its own files by more than a path expression
// load from node_modules, where they already work.
const EXTERNAL = ["*.node", "jiti", "koffi", "@napi-rs/*", "@mariozechner/clipboard*"];

// Pi's loader, in the bundled copy only: a shipped extension's first load uses the
// build, and every later one falls through to Jiti, so /reload re-evaluates from source
// exactly as it always has. Matched literally so an upstream change fails the build
// rather than quietly loading everything the slow way.
const LOADER_ANCHOR = "    const createJitiImpl = await getCreateJiti();\n";

function posix(p) {
  return p.split(path.sep).join("/");
}

/** The specifiers Pi's loader serves from the host (core/extensions/virtual-modules.js). */
const HOST_SPECIFIER = /^(?:@earendil-works|@mariozechner)\/pi-(?:coding-agent|agent-core|tui|ai)(?:\/.*)?$|^(?:@sinclair\/)?typebox(?:\/(?:compile|value))?$/;

function hostSpecifier(spec) {
  const s = spec.replace(/^@mariozechner\//, "@earendil-works/").replace(/^@sinclair\/typebox/, "typebox");
  return s === "@earendil-works/pi-ai" ? "@earendil-works/pi-ai/compat" : s;
}

function isPiPackage(file) {
  return /[\\/]node_modules[\\/]@earendil-works[\\/]pi-/.test(file);
}

/** Banner helpers that map a path relative to dist-boot/ back to a URL or file path. */
const BANNER = [
  'import{createRequire as __pvCR}from"node:module";',
  'import{fileURLToPath as __pvF}from"node:url";',
  'import{dirname as __pvD}from"node:path";',
  "const require=__pvCR(import.meta.url);",
  "const __pvUrl=(r)=>new URL(r,import.meta.url).href;",
  "const __pvFile=(r)=>__pvF(new URL(r,import.meta.url));",
].join("");

export const NON_LITERAL_IMPORT = /\bimport\(\s*(?!["'])|\bimport\(\s*`[^`]*\$\{|\brequire\(\s*(?!["'`])/;

// Computed imports in the tool packs, replaced with the literal that means the same
// thing inside the build. pi-subagents loads "the running host" by absolute path so a
// child can't get an extension-owned copy, but here the running host is this bundle,
// and following the path on disk would load a second Pi into the process. Matched
// literally: an upstream change fails the build instead of reintroducing that.
const PACK_REWRITES = [
  {
    file: "pi-subagents/src/runs/shared/child-session.js",
    replace: [
      ["import(__rewriteRelativeImportExtension(pathToFileURL(entry).href))", 'import("@earendil-works/pi-coding-agent")'],
      ["import(__rewriteRelativeImportExtension(PI_CODING_AGENT_PACKAGE))", 'import("@earendil-works/pi-coding-agent")'],
    ],
  },
  {
    file: "pi-subagents/src/runs/shared/structured-output.js",
    replace: [["import(__rewriteRelativeImportExtension(pathToFileURL(resolved).href))", 'import("typebox/compile")']],
  },
];

function applyPackRewrites(source, file) {
  const rule = PACK_REWRITES.find((r) => posix(file).endsWith(`/node_modules/${r.file}`));
  if (!rule) return source;
  for (const [from, to] of rule.replace) {
    if (!source.includes(from)) throw new Error(`build-boot: ${rule.file} changed; update PACK_REWRITES`);
    source = source.replaceAll(from, to);
  }
  return source;
}

// Text that matches NON_LITERAL_IMPORT without being a module import of ours to compile:
// this one is inside the source string pi-subagents hands to a Worker to eval.
const NOT_A_COMPILED_IMPORT = ["require(workerData.acornPath)"];

export function importScanText(source) {
  let text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const known of NOT_A_COMPILED_IMPORT) text = text.replaceAll(known, "");
  return text;
}

const LOADERS = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" };

// Packages written as Privateer tool packs, which hold extension state like our own src/.
const PER_EXTENSION_PACKAGES = /^(?:pi-privacy|pi-background-tasks|pi-subagents|privateer-speak|privateer-workflow|@juicesharp\/[^/]+)\//;

function isPerExtension(file, repo) {
  const rel = posix(path.relative(repo, file));
  if (rel.startsWith("../")) return false;
  const at = rel.lastIndexOf("node_modules/");
  return at < 0 || PER_EXTENSION_PACKAGES.test(rel.slice(at + "node_modules/".length));
}

const identityPlugin = ({ repo, out, piDist, extMap, extByEntry }) => ({
  name: "privateer-boot",
  setup(build) {
    // One Pi and one Typebox, as Pi's loader guarantees for Jiti-loaded code. Pi's own
    // packages resolve normally so the host keeps its plain pi-ai entry.
    build.onResolve({ filter: HOST_SPECIFIER }, async (args) => {
      if (args.pluginData?.skip || isPiPackage(args.importer) || args.kind === "entry-point") return undefined;
      const r = await build.resolve(hostSpecifier(args.path), {
        kind: args.kind,
        resolveDir: piDist,
        pluginData: { skip: true },
      });
      return r.errors.length ? undefined : r;
    });

    // Each extension keeps its own copy of first-party modules, as under Jiti (a new
    // instance per extension, with moduleCache off). Modules here hold real state, such
    // as once-guards around global fetch and spend grants, so sharing one copy across
    // extensions would change what those guards do. The suffix makes esbuild treat each
    // extension's copy as a separate module.
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skip) return undefined;
      if (args.kind === "entry-point") {
        const ext = extByEntry.get(args.path);
        return ext ? { path: args.path, suffix: `?ext=${ext}`, pluginData: { ext } } : undefined;
      }
      const ext = args.pluginData?.ext;
      if (!ext) return undefined; // Pi's own graph, or a shared third-party library
      const r = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        namespace: args.namespace,
        resolveDir: args.resolveDir,
        pluginData: { skip: true },
      });
      // Left to esbuild, which allows an unresolved optional import inside a try block.
      if (r.errors.length) return undefined;
      if (r.external || !isPerExtension(r.path, repo)) return r;
      return { ...r, suffix: `?ext=${ext}`, pluginData: { ext } };
    });

    build.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async (args) => {
      let source = await fs.promises.readFile(args.path, "utf8");
      const loader = LOADERS[path.extname(args.path)] ?? "js";
      const rel = posix(path.relative(out, args.path));

      if (posix(args.path).endsWith("/dist/core/extensions/loader.js") && isPiPackage(args.path)) {
        if (!source.includes(LOADER_ANCHOR)) {
          throw new Error("build-boot: Pi's extension loader changed; update LOADER_ANCHOR");
        }
        source = source.replace(LOADER_ANCHOR, `    {
        const __pvRel = __pvBootExtensions[__pvRelative(extensionPath)];
        if (__pvRel && !__pvBootConsumed.has(extensionPath)) {
            __pvBootConsumed.add(extensionPath);
            const __pvFactory = (await import(__pvBootUrl(__pvRel))).default;
            if (typeof __pvFactory === "function") {
                if (isCurrentCacheToken(cacheToken)) extensionCache.set(extensionPath, __pvFactory);
                return __pvFactory;
            }
        }
    }
${LOADER_ANCHOR}`);
        source += `
const __pvBootExtensions = ${JSON.stringify(extMap)};
const __pvBootConsumed = new Set();
const __pvBootRoot = fileURLToPath(new URL("../", __PV_CHUNK_URL__));
const __pvBootUrl = (f) => new URL("./" + f, __PV_CHUNK_URL__).href;
const __pvRelative = (p) => path.relative(__pvBootRoot, p).split(path.sep).join("/");
`;
      }

      source = applyPackRewrites(source, args.path);

      // An import esbuild can't read stays a runtime import of the source file. For a
      // .ts file inside node_modules Node refuses that, and an optional-pack `catch`
      // turns the refusal into a feature that quietly isn't there.
      if (args.pluginData?.ext && NON_LITERAL_IMPORT.test(importScanText(source))) {
        throw new Error(
          `build-boot: ${posix(path.relative(repo, args.path))} has a dynamic import with a computed specifier. ` +
            "Use a string literal so it can be compiled.",
        );
      }

      const hasMeta = /\bimport\.meta\.(?:url|dirname|filename)\b/.test(source);
      const hasDirname = /\b__(?:dirname|filename)\b/.test(source);
      const declaresDirname = /\b(?:const|let|var|function)\s+__(?:dirname|filename)\b/.test(source);
      let prefix = "";

      if (hasMeta) {
        const out = await esbuild.transform(source, {
          loader,
          format: undefined,
          target: "node22",
          sourcefile: args.path,
          define: {
            "import.meta.url": "__pvMetaUrl",
            "import.meta.dirname": "__pvMetaDirname",
            "import.meta.filename": "__pvMetaFilename",
          },
          logLevel: "silent",
        });
        const code = out.code;
        const uses = (n) => new RegExp(`\\b${n}\\b`).test(code);
        if (uses("__pvMetaUrl")) prefix += `const __pvMetaUrl=__pvUrl(${JSON.stringify(rel)});`;
        if (uses("__pvMetaFilename")) prefix += `const __pvMetaFilename=__pvFile(${JSON.stringify(rel)});`;
        if (uses("__pvMetaDirname")) prefix += `const __pvMetaDirname=__pvD(__pvFile(${JSON.stringify(rel)}));`;
        return {
          contents: (prefix + code).replaceAll("__PV_CHUNK_URL__", "import.meta.url"),
          loader: "js",
          resolveDir: path.dirname(args.path),
          pluginData: args.pluginData,
        };
      }

      // CommonJS: no import.meta here, or esbuild would reclassify the file as ESM.
      if (hasDirname && !declaresDirname) {
        prefix = `var __filename=__pvFile(${JSON.stringify(rel)}),__dirname=__pvD(__filename);`;
      }
      return { contents: prefix + source, loader, resolveDir: path.dirname(args.path), pluginData: args.pluginData };
    });
  },
});

/** Compile `repo` (a checkout, or a release staging tree) into `<repo>/dist-boot`. */
export async function buildBoot({ repo = THIS_REPO, quiet = false } = {}) {
  const log = (m) => { if (!quiet) console.log(`build-boot: ${m}`); };

  // Skipped and failed both mean node_modules isn't what we ship: patches carry the
  // retry guard, session sealing and the project config dir.
  const patches = applyPatchesIfNeeded(repo);
  if (patches !== "current" && patches !== "applied") {
    throw new Error(`build-boot: patch step returned "${patches}"; refusing to compile unpatched Pi`);
  }

  const out = path.join(repo, BOOT_DIR);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "src", "config", "moatManifest.json"), "utf8"));
  const piCli = resolveDep(repo, "@earendil-works/pi-coding-agent", "dist", "cli.js");
  if (!piCli) throw new Error("build-boot: pi-coding-agent is not installed");
  const piDist = path.dirname(fs.realpathSync(piCli));
  const piPkg = JSON.parse(fs.readFileSync(path.join(piDist, "..", "package.json"), "utf8"));

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const entryPoints = { cli: piCli };
  const extMap = {};
  const extByEntry = new Map();
  for (const s of manifest.shims) {
    const abs = s.entry ? path.join(repo, s.entry) : resolveDep(repo, ...s.dep);
    if (!abs || !fs.existsSync(abs)) continue; // optional pack not installed; the launcher drops it too
    entryPoints[`ext-${s.name}`] = abs;
    extByEntry.set(abs, s.name);
    // Keyed by the path the launcher passes as `-e`, which is not resolved through symlinks.
    extMap[posix(path.relative(repo, abs))] = `ext-${s.name}.mjs`;
  }

  const result = await esbuild.build({
    absWorkingDir: repo,
    entryPoints,
    outdir: out,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outExtension: { ".js": ".mjs" },
    chunkNames: "c-[hash]",
    keepNames: true, // error and tool code switches on constructor names
    mainFields: ["module", "main"],
    conditions: ["node", "import", "module"],
    external: EXTERNAL,
    banner: { js: BANNER },
    metafile: true,
    logLevel: quiet ? "error" : "warning",
    logLimit: 0,
    loader: { ".json": "json", ".wasm": "file", ".node": "file" },
    plugins: [identityPlugin({ repo, out, piDist, extMap, extByEntry })],
  });

  // The real entry. Node has already read argv[1] by the time user code runs, so
  // restoring it here costs nothing and leaves everything that asks "where is Pi
  // installed?" with the answer it gets from source, including at module load.
  const piCliRel = posix(path.relative(out, piCli));
  fs.writeFileSync(
    path.join(out, "boot.mjs"),
    `import { fileURLToPath } from "node:url";\n` +
      `process.argv[1] = fileURLToPath(new URL(${JSON.stringify(piCliRel)}, import.meta.url));\n` +
      `await import("./cli.mjs");\n`,
  );

  const outputs = Object.entries(result.metafile.outputs);
  const bytes = outputs.reduce((n, [, o]) => n + o.bytes, 0);
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify(
      {
        version: pkg.version,
        pi: piPkg.version,
        node: process.versions.node,
        builtAt: new Date().toISOString(),
        extensions: Object.keys(extMap).length,
        modules: Object.keys(result.metafile.inputs).length,
        files: outputs.length,
      },
      null,
      2,
    ) + "\n",
  );
  log(`${Object.keys(result.metafile.inputs).length} modules → ${outputs.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBoot().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
