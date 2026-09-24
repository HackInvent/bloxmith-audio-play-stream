import { withProperties } from "./properties.js";

/** Mount properties and controls for the existing, DOM-independent player. */
import { mountControls } from "./common.js";

/** Bind this surface and return UI-only cleanup, never player teardown. */
function mountOwned(root, api) {
  return mountControls(root, api);
}

/** Keep the block behavior and add properties-only accessibility. */
export function mount(root, ...args) {
  return withProperties(mountOwned).call(this, root, ...args);
}
