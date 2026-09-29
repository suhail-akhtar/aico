/**
 * How many overlays (menus, dialogs, the palette) are open right now.
 *
 * The built-in browser is a native view drawn *above* the interface, so a menu
 * opened over it would be hidden underneath. While anything is open, the
 * browser pane steps aside and shows a still of the page instead — captured by
 * main in the moment before it hides the page, so it is the page as it was —
 * and the floating copilot (a native view too) steps aside the same way.
 *
 * @module desktop/renderer/lib/overlay
 */

import { useEffect } from 'react';
import { create } from 'zustand';

export const useOverlays = create<{ count: number; add: () => void; remove: () => void }>((set, get) => ({
  count: 0,
  add: () => set({ count: get().count + 1 }),
  remove: () => set({ count: Math.max(0, get().count - 1) }),
}));

export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    useOverlays.getState().add();
    return () => useOverlays.getState().remove();
  }, [open]);
}
