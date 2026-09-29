/**
 * Keeping the floating copilot on screen. Pure, so it is unit-tested.
 *
 * @module desktop/renderer/browser/geometry
 */

/** Keep a floating panel inside the area it floats over. */
export function clampFloat(ui: { x: number; y: number; w: number; h: number }, area: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const margin = 8;
  const w = Math.max(320, Math.min(ui.w, area.width - 2 * margin));
  const h = Math.max(300, Math.min(ui.h, area.height - 2 * margin));
  const x0 = ui.x < 0 ? area.width - w - 16 : ui.x;
  const x = Math.max(margin, Math.min(x0, area.width - w - margin));
  const y = Math.max(margin, Math.min(ui.y, area.height - h - margin));
  return { x, y, w, h };
}
