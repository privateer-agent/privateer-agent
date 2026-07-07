// Permission modes, split out from the (Phase 7) zod config schema so the
// permission layer can depend on just this without pulling zod. Ported from
// tree-cli/src/config/schema.ts.
export const PERMISSION_MODES = ["default", "acceptEdits", "bypass", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
