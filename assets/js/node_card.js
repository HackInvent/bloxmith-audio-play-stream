/** Display browser-local audio state without owning a receiver. */
import { mountControls } from "./common.js";

/** Bind this surface and return UI-only cleanup, never player teardown. */
export function mount(root, api) {
  return mountControls(root, api);
}
