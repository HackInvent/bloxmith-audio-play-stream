/** Display browser-local audio state without owning a receiver. */
(function () {
  "use strict";
  const registry = (window.CWBlockUiBlocks = window.CWBlockUiBlocks || {});
  registry.audio_play_streamNodeCard = {
    /** Keep mute/state attached only for this canvas card's lifetime. */
    mount(root, api) { return window.CWAudioPlayStream.mount(root, api); },
  };
})();
