/** Mount properties and controls for the existing, DOM-independent player. */
(function () {
  "use strict";
  const registry = (window.CWBlockUiBlocks = window.CWBlockUiBlocks || {});
  registry.audio_play_stream = {
    /** Bind this modal and return UI-only cleanup. */
    mount(root, api) { return window.CWAudioPlayStream.mount(root, api); },
  };
})();
