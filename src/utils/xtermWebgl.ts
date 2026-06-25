import type { Terminal } from '@xterm/xterm';

/**
 * Keep the terminal on xterm's default renderer. The optional WebGL renderer
 * can corrupt the glyph atlas in some macOS webviews, which makes shell output
 * render as broken fragments even though the PTY data is correct.
 */
export function tryAttachWebglRenderer(_term: Terminal): null {
  return null;
}
