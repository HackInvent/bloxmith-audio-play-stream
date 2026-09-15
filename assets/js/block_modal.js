/** Mount properties and controls for the existing, DOM-independent player. */
import { mountControls } from "./common.js";

/** Bind this surface and return UI-only cleanup, never player teardown. */
export function mount(root, api) {
  return mountControls(root, api);
}
