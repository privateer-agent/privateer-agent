import { useEffect, useState } from "react";
import { useStdout } from "ink";

// Current terminal column count, re-read on every resize.
//
// The dynamic region below <Static> is erased and redrawn on each render. Ink
// counts the previous frame by its newlines, so any line that soft-wraps — or
// that the terminal reflows when dragged narrower — desyncs the erase and leaves
// stale copies in the scrollback (the classic stack of duplicated status bars).
// Subscribing to resize lets those lines re-truncate to the new width and stay a
// single row, which keeps Ink's erase count correct.
export function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns ?? 80);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return cols;
}
