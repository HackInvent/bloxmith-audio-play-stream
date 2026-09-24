import { withProperties } from "./properties.js";

/** Bind block-owned inspector settings and local audio controls. */
import { mountControls } from "./common.js";

/** Bind this surface and return UI-only cleanup, never player teardown. */
function mountOwned(root, api) {
  return mountControls(root, api);
}

/** Keep the block behavior and add properties-only accessibility. */
export function mount(root, ...args) {
  return withProperties(mountOwned).call(this, root, ...args);
}
