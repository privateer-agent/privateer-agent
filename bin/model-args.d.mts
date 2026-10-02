// Types for bin/model-args.mjs — plain .mjs because bin/ runs under a bare `node`.

export function modelArgs(o: {
  launchArgs: string[];
  envModel?: string;
  savedDefault?: string | null;
  signedIn: boolean;
  computed: string;
}): string[];
