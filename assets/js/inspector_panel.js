/** Bind block-owned inspector settings and local audio controls. */
import { mountControls } from "./common.js";

/** Bind this surface and return UI-only cleanup, never player teardown. */
export function mount(root, api) {
  return mountControls(root, api);
}
