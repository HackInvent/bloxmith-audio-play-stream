/** Bind block-owned inspector settings and local audio controls. */
(function () {
  "use strict";
  const registry = (window.CWBlockUiBlocks = window.CWBlockUiBlocks || {});
  registry.audio_play_streamInspectorPanel = {
    /** Return UI cleanup, never player teardown. */
    mount(root, api) { return window.CWAudioPlayStream.mount(root, api); },
  };
})();
