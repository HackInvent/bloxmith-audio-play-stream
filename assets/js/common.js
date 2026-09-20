/** Shared, page-local controls. Neither runtime state nor gain is persisted to the graph. */
const sessions = new Map();
const subscribers = new Set();

  /** Key the local player by all public scopes, including the current Run. */
export const key = (scope) => JSON.stringify([scope.workspaceProjectId, scope.graphId, scope.instanceId,
    scope.runId, scope.nodeId]);
export const get = (sessionKey) => sessions.get(sessionKey);
export const notify = () => { for (const refresh of subscribers) refresh(); };
  /** Keep only bounded diagnostic snapshots after cleanup, never disposed audio resources. */
export const set = (sessionKey, record) => {
  sessions.delete(sessionKey);
  sessions.set(sessionKey, record);
    for (const [oldKey, old] of sessions) {
      if (sessions.size <= 128) break;
      if (!old.player) sessions.delete(oldKey);
    }
  notify();
  };

  /** Bind live controls and validated next-Run settings to a modal, inspector or card.
   * @param {HTMLElement} root - The owning UI surface, not the player lifetime.
   * @param {object} api - Public block UI facade; no private routes or shared shell changes.
   * @returns {Function} Remove only UI subscriptions; closing a surface never stops audio.
   */
export function mountControls(root, api) {
    const fields = Array.from(root.querySelectorAll("[data-player-setting]"));
    const title = root.querySelector("[data-player-title]");
    const controls = title ? [title, ...fields] : fields;
    const applyButton = root.querySelector("[data-player-apply]");
    const feedback = root.querySelector("[data-player-feedback]");
    const status = root.querySelector("[data-player-status]");
    const volume = root.querySelector("[data-player-volume]");
    const volumeValue = root.querySelector("[data-player-volume-value]");
    const mute = root.querySelector("[data-player-mute]");
    let busy = false;
    let disposed = false;
    const snapshot = () => ({ ...(title ? { title: title.value } : {}), config: Object.fromEntries(
      fields.map(field => [field.dataset.playerSetting, field.type === "checkbox" ? field.checked : field.value])) });
    let saved = JSON.stringify(snapshot());
    const changed = () => JSON.stringify(snapshot()) !== saved;
  const record = () => get(key(api.runtimeAudioStreams?.getContext?.() || {}));
    /** Refresh local state without replacing user edits or changing graph configuration. */
    const refresh = () => {
      if (disposed) return;
      const entry = record();
      const state = entry?.player?.snapshot() || entry?.snapshot;
      if (status) {
        status.textContent = state?.message || "Run, then enable the sound.";
        status.dataset.error = String(Boolean(state?.error));
      }
      if (volume) { volume.disabled = !entry?.player; if (state) volume.value = String(state.volume); }
      if (volumeValue) volumeValue.textContent = state ? `${Math.round(state.volume)} %` : "—";
      if (mute) {
        mute.disabled = !entry?.player;
        mute.textContent = state?.muted ? "Unmute" : "Mute";
        mute.setAttribute("aria-pressed", String(Boolean(state?.muted)));
      }
      if (applyButton) {
        applyButton.disabled = busy || !changed() || Boolean(api.isReadOnly?.());
        applyButton.textContent = busy ? "Applying…" : "Apply";
      }
    };
    const announce = (message, error = false) => {
      if (!disposed && feedback) { feedback.textContent = message; feedback.dataset.error = String(error); }
    };
    const dirty = () => { announce(changed() ? "Unapplied changes." : "No change."); refresh(); };
    /** Apply one validated snapshot and preserve any newer changes typed during the request. */
    const apply = async () => {
      if (disposed || busy || !changed() || api.isReadOnly?.()) return;
      const invalid = controls.find(field => !field.checkValidity());
      if (invalid) {
        const disclosure = invalid.closest("details");
        if (disclosure) disclosure.open = true;
        invalid.reportValidity(); announce("Check the highlighted field.", true); return;
      }
      const patch = snapshot();
      busy = true;
      refresh();
      try {
        const result = await api.applyAction("save_properties", patch);
        if (result?.error) throw new Error(result.error);
        saved = JSON.stringify(patch);
        announce(changed() ? "Saved; some changes still need to be applied." : "Applied at the next Run.");
      } catch (error) { announce(error.message || "Saving failed.", true); }
      finally { busy = false; refresh(); }
    };
    const setVolume = () => record()?.player?.setVolume(Number(volume.value));
    const toggleMute = () => { const player = record()?.player; if (player) player.setMuted(!player.snapshot().muted); };
    for (const field of controls) { field.addEventListener("input", dirty); field.addEventListener("change", dirty); }
    applyButton?.addEventListener("click", apply);
    volume?.addEventListener("input", setVolume);
    mute?.addEventListener("click", toggleMute);
    subscribers.add(refresh);
    refresh();
    /** Disconnect a detached card even when its renderer discards a mount return value. */
    const observer = new MutationObserver(() => { if (!root.isConnected) cleanup(); });
    observer.observe(document.body, { childList: true, subtree: true });
    function cleanup() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      subscribers.delete(refresh);
      for (const field of controls) { field.removeEventListener("input", dirty); field.removeEventListener("change", dirty); }
      applyButton?.removeEventListener("click", apply);
      volume?.removeEventListener("input", setVolume);
      mute?.removeEventListener("click", toggleMute);
    }
    return cleanup;
}
