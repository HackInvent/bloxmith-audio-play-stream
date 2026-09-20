/** FB3/FB4/FB5: real WebCodecs/Web Audio, generated audio, UI and lifecycle assertions. */
async ({ fixtures, references, modal, modules }) => {
  const ui = await import(modules.common);
  const runtime = await import(modules.browserRuntime);
  const modalSurface = await import(modules.modal);
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const context = window.testAudio;
  const sourceFactory = context.createBufferSource.bind(context);
  const observed = [];
  // Observe real Web Audio scheduling without substituting a fake decoder or context.
  context.createBufferSource = () => {
    const source = sourceFactory();
    const start = source.start.bind(source);
    const stop = source.stop.bind(source);
    const disconnect = source.disconnect.bind(source);
    const info = { stopped: false, ended: false, disconnected: false, source };
    // Already played buffers leave the live-source set normally; Stop only cancels what remains.
    source.addEventListener("ended", () => { info.ended = true; }, { once: true });
    source.start = time => { info.time = time; info.buffer = source.buffer; observed.push(info); return start(time); };
    source.stop = () => { info.stopped = true; return stop(); };
    source.disconnect = (...args) => { info.disconnected = true; return disconnect(...args); };
    return source;
  };
  let nextId = 0;
  /** Open a block lifecycle with only transport IO stubbed; player and browser audio are real. */
  async function open(config = {}) {
    const abort = new AbortController();
    const scope = { workspaceProjectId: "workspace", graphId: "graph", instanceId: "1", runId: "run", nodeId: `player-${++nextId}` };
    let callbacks;
    let closes = 0;
    let generation = new AbortController();
    abort.signal.addEventListener("abort", () => generation.abort(), { once: true });
    const api = { node: { id: scope.nodeId, config }, audioContext: context, signal: abort.signal,
      runtimeAudioStreams: { getContext: () => scope, async openInput(options) {
        assert(options.inputPort === "audio_in", "wrong port"); callbacks = options;
        assert(typeof options.onReset === "function", "interruptible readers must provide onReset");
        return { close() { closes++; generation.abort(); } };
      } } };
    const stop = await runtime.start(api);
    const state = () => { const entry = ui.get(ui.key(scope)); return entry?.player?.snapshot() || entry?.snapshot; };
    return { api, stop, abort, scope, state, player: () => ui.get(ui.key(scope))?.player,
      send: frame => callbacks.onFrame(frame, { signal: generation.signal }),
      reset() {
        generation.abort();
        generation = new AbortController();
        return callbacks.onReset({ type: "runtime_audio_stream.reset" }, { signal: generation.signal });
      },
      get closes() { return closes; }, callbacks };
  }
  const frame = (bytes, extra = {}) => ({ payload: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    stream_id: "audio-1", source_id: "source", sequence: 0, codec: "pcm_s16le", sample_rate_hz: 24000, channels: 1, ...extra });
  const rejects = async (callback, expression) => {
    let failure;
    try { await callback(); } catch (error) { failure = error; }
    assert(failure && expression.test(failure.message), `Expected ${expression}, got ${failure?.message}`);
  };

  // FB3: signed LE conversion, interleaving and arbitrary sample cuts across transport frames.
  const first = await open();
  const pcm = new Int16Array([-32768, 32767, -16384, 16384, 0, 0, 100, -100]);
  const bytes = new Uint8Array(pcm.buffer);
  let offset = 0;
  let sequence = 0;
  const startIndex = observed.length;
  for (const size of [1, 2, 4, 9]) {
    await first.send(frame(bytes.subarray(offset, offset + size), { sequence: sequence++, channels: 2 }));
    offset += size;
  }
  assert(first.state().playedSamples === 4, "PCM split samples must not be lost");
  const buffers = observed.slice(startIndex).map(info => info.buffer);
  const left = buffers.flatMap(buffer => [...buffer.getChannelData(0)]);
  const right = buffers.flatMap(buffer => [...buffer.getChannelData(1)]);
  assert(left[0] === -1 && right[0] === 32767 / 32768 && left[1] === -.5 && right[1] === .5, "signed stereo PCM conversion");

  // FB4: independent local controls never alter another player or close the shared context.
  const second = await open();
  first.player().setVolume(37); first.player().setMuted(true);
  assert(first.state().volume === 37 && first.state().muted && second.state().volume === 80 && !second.state().muted, "local gain isolation");
  await first.send(frame(new Uint8Array(960), { sequence, channels: 2 }));
  assert(first.state().receivedFrames === 5, "mute must keep draining frames");
  first.stop(); first.stop();
  assert(first.closes === 1 && !first.state().active && second.state().active && context.state === "running", "idempotent local cleanup");
  second.abort.abort();
  assert(second.closes === 1 && !second.state().active, "abort closes receiver");

  // FB6: interruption stops scheduled sources, clears stream state and keeps the receiver alive.
  const interrupted = await open();
  const interruptedBegin = observed.length;
  await interrupted.send(frame(new Uint8Array(48000)));
  const beforeResetFrames = interrupted.state().receivedFrames;
  interrupted.reset();
  assert(interrupted.state().active && interrupted.closes === 0, "reset must retain the player subscription");
  assert(/interrupted/.test(interrupted.state().message), "reset must expose an honest local state");
  assert(observed.slice(interruptedBegin).every(info => info.stopped && info.disconnected),
    "reset must stop and disconnect every scheduled source");
  await interrupted.send(frame(new Uint8Array(480), { sequence: 1 }));
  assert(interrupted.state().receivedFrames === beforeResetFrames + 1,
    "new audio must resume after reset, including the same stream id");
  interrupted.stop();

  // FB3: Opus Ogg/WebM, mono/stereo, one-byte headers and fragmented container bodies.
  const decodedResults = {};
  const fidelity = {};
  /** Compare actual scheduled samples to independent file decoding, not just duration or non-silence. */
  function compareReference(name, audio, channels) {
    const bytes = Uint8Array.from(atob(references[name]), char => char.charCodeAt(0));
    const reference = new Float32Array(bytes.buffer);
    let offset = 0, signal = 0, error = 0, actualPower = 0;
    for (const item of audio) {
      const planes = Array.from({ length: channels }, (_, channel) => item.buffer.getChannelData(channel));
      for (let i = 0; i < item.buffer.length; i++) {
        for (let channel = 0; channel < channels; channel++) {
          const expected = reference[offset++], actual = planes[channel][i];
          signal += expected * expected;
          actualPower += actual * actual;
          error += (expected - actual) ** 2;
        }
      }
    }
    assert(offset === reference.length, `${name}: scheduled/file sample counts differ`);
    const signalToErrorDb = 10 * Math.log10(signal / Math.max(error, 1e-30));
    const gain = Math.sqrt(actualPower / signal);
    assert(signalToErrorDb > 60 && Math.abs(gain - 1) < .001,
      `${name}: waveform distorted vs FFmpeg (${signalToErrorDb.toFixed(2)} dB, gain ${gain.toFixed(4)})`);
    return Number(signalToErrorDb.toFixed(2));
  }
  for (const [name, encoded] of Object.entries(fixtures)) {
    const stream = await open();
    const raw = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const channels = Number(name.split("_")[1]);
    const begin = observed.length;
    let partialPlayback = false;
    for (let offset = 0, sequence = 0; offset < raw.length; sequence++) {
      const size = sequence < 40 ? 1 : [37, 113, 503, 1021][sequence % 4];
      const part = raw.subarray(offset, offset + size);
      await stream.send(frame(part, { codec: "opus", sample_rate_hz: 48000, channels, sequence }));
      offset += part.length;
      if (offset < raw.length / 2 && stream.state().playedSamples > 0) partialPlayback = true;
    }
    assert(partialPlayback, `${name}: must play before the recording is complete`);
    assert(stream.state().playedSamples === 48000, `${name}: trimming/duration ${stream.state().playedSamples}, expected 48000`);
    const audio = observed.slice(begin);
    assert(audio.length > 10 && audio.some(info => [...info.buffer.getChannelData(0)].some(value => Math.abs(value) > .01)), `${name}: decoded non-silent audio`);
    assert(audio.every((info, index) => !index || info.time >= audio[index - 1].time + audio[index - 1].buffer.duration - .00001), `${name}: non-overlapping clock`);
    fidelity[name] = compareReference(name, audio, channels);
    decodedResults[name] = stream.state().playedSamples;
    // Each new recording gets a fresh decoder but follows already scheduled sound.
    await stream.send(frame(raw, { codec: "opus", sample_rate_hz: 48000, channels, stream_id: "audio-2" }));
    assert(stream.state().playedSamples === 96000, `${name}: second stream decoder reuse`);
    compareReference(name, observed.slice(begin + audio.length), channels);
    stream.stop();
    assert(observed.slice(begin).every(info => (info.stopped || info.ended) && info.disconnected),
      `${name}: stop cancels pending sources and every finished source is disconnected`);
  }

  // FB3: the actual browser MediaRecorder container, generated from an oscillator, not a microphone.
  const captured = await open();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  oscillator.connect(destination);
  const recorder = new MediaRecorder(destination.stream, { mimeType: "audio/webm;codecs=opus" });
  let captures = Promise.resolve();
  let captureSequence = 0;
  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    captures = captures.then(async () => captured.send(frame(new Uint8Array(await event.data.arrayBuffer()),
      { codec: "opus", sample_rate_hz: 48000, channels: 2, sequence: captureSequence++ })));
  };
  oscillator.start(); recorder.start(50);
  await delay(450);
  assert(captured.state().playedSamples > 0, "native MediaRecorder is decoded before stop");
  await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
  oscillator.stop(); oscillator.disconnect();
  destination.stream.getTracks().forEach(track => track.stop());
  await captures;
  assert(captured.state().playedSamples > 12000 && captureSequence > 2, "native WebM live clusters work");
  captured.stop();

  // FB3/FB4: awaited bounded queue, cancellation during a full queue, malformed audio errors.
  const bounded = await open({ max_buffer_sec: 1, latency_ms: 20 });
  await bounded.send(frame(new Uint8Array(36000))); // .75 seconds
  const blocked = bounded.send(frame(new Uint8Array(120000), { sequence: 1 }));
  await delay(40);
  assert(bounded.state().highWaterSeconds <= 1.0001, "scheduled queue is bounded");
  bounded.abort.abort(); await blocked;
  assert(!bounded.state().active && bounded.closes === 1, "cancel pending queue");
  for (const invalid of [frame(new Uint8Array(10), { codec: "aac" }),
    frame(new Uint8Array(10), { codec: "opus", sample_rate_hz: 48000 }),
    frame(new Uint8Array(524289)), frame(new Uint8Array(1), { channels: 3 })]) {
    const stream = await open();
    await rejects(() => stream.send(invalid), /format|header|oversized|profile/i);
    assert(stream.state().error && stream.closes === 1 && !stream.state().active, "error must close only failed reader");
  }
  const gap = await open();
  await gap.send(frame(new Uint8Array(10)));
  await rejects(() => gap.send(frame(new Uint8Array(10), { sequence: 2 })), /Missing audio frame/);
  const unavailable = await open();
  const savedDecoder = window.AudioDecoder;
  window.AudioDecoder = undefined;
  await rejects(() => unavailable.send(frame(Uint8Array.from(atob(fixtures.ogg_1), char => char.charCodeAt(0)), { codec: "opus", sample_rate_hz: 48000 })), /WebCodecs/);
  window.AudioDecoder = savedDecoder;

  // FB3/FB4: one bounded packet awaits output, not flush; Stop/errors release it immediately.
  class DeferredDecoder {
    static last;
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = "unconfigured"; DeferredDecoder.last = this; }
    configure() { this.state = "configured"; }
    decode(chunk) { this.chunk = chunk; }
    flush() { throw new Error("Do not flush between Opus packets."); }
    close() { this.state = "closed"; }
  }
  const opusFrame = () => frame(Uint8Array.from(atob(fixtures.ogg_1), char => char.charCodeAt(0)),
    { codec: "opus", sample_rate_hz: 48000 });
  window.AudioDecoder = DeferredDecoder;
  try {
    const pending = await open();
    const cancelledDecode = pending.send(opusFrame());
    await delay(0);
    const previous = DeferredDecoder.last;
    assert(previous.chunk && pending.state().playedSamples === 0, "Await PCM before accepting the packet");
    let partialClosed = false;
    const partial = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: 480,
      numberOfChannels: 1, timestamp: previous.chunk.timestamp, data: new Float32Array(480) });
    const closePartial = partial.close.bind(partial);
    partial.close = () => { partialClosed = true; closePartial(); };
    previous.callbacks.output(partial);
    await delay(0);
    assert(pending.state().playedSamples === 0, "A partial decode must not ACK or play a truncated packet");
    const beforeAbort = performance.now();
    pending.abort.abort();
    await cancelledDecode;
    assert(performance.now() - beforeAbort < 500 && partialClosed && previous.state === "closed",
      "Stop must release a pending decode and partial AudioData without waiting for the timeout");
    let lateClosed = false;
    previous.callbacks.output({ close() { lateClosed = true; } });
    assert(lateClosed && !pending.state().active, "Late PCM after Stop must be closed, never scheduled");

    const resetting = await open();
    const discarded = resetting.send(opusFrame());
    await delay(0);
    const staleDecoder = DeferredDecoder.last;
    assert(staleDecoder.chunk, "The stale decoder must have pending asynchronous work");
    resetting.reset();
    await discarded;
    assert(staleDecoder.state === "closed" && resetting.state().active && resetting.closes === 0,
      "reset must invalidate decoder work without closing the reader");
    let staleClosed = false;
    staleDecoder.callbacks.output({ close() { staleClosed = true; } });
    assert(staleClosed, "late decoded audio after reset must be closed, never scheduled");
    resetting.stop();

    const failed = await open();
    const decodeError = rejects(() => failed.send(opusFrame()), /Opus decoding interrupted/);
    await delay(0);
    DeferredDecoder.last.callbacks.error(new Error("test decoder failure"));
    await decodeError;
    assert(failed.state().error && failed.closes === 1, "Decoder errors must reject and close the input reader");

    const oversized = await open();
    const invalidOutput = rejects(() => oversized.send(opusFrame()), /Incompatible decoded PCM/);
    await delay(0);
    let invalidClosed = false;
    DeferredDecoder.last.callbacks.output({ sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 961,
      timestamp: 0, close() { invalidClosed = true; } });
    await invalidOutput;
    assert(invalidClosed && oversized.state().error, "Unexpected output size must fail without leaking AudioData");

    const timeout = await open();
    await rejects(() => timeout.send(opusFrame()), /stopped responding/);
    assert(timeout.state().error && timeout.closes === 1 && DeferredDecoder.last.state === "closed",
      "A missing decoder callback must time out and release the input reader");
  } finally { window.AudioDecoder = savedDecoder; }

  // FB5: real DOM editing, local controls and cleanup without a second runtime subscription.
  const live = await open();
  const root = document.querySelector("#surface");
  root.innerHTML = modal;
  const actions = [];
  let readOnly = false;
  const cleanup = modalSurface.mount(root, {
    runtimeAudioStreams: live.api.runtimeAudioStreams, isReadOnly: () => readOnly,
    async applyAction(action, values) { actions.push({ action, values }); return {}; },
  });
  const button = root.querySelector("[data-player-apply]");
  const volume = root.querySelector('[data-player-setting="volume"]');
  const change = input => input.dispatchEvent(new Event("input", { bubbles: true }));
  assert(button.disabled, "clean form must not apply");
  volume.value = "42"; change(volume);
  assert(!button.disabled, "dirty form must enable apply");
  root.querySelector('[data-player-setting="muted"]').checked = true;
  button.click(); await delay(0);
  assert(actions[0].action === "save_properties" && actions[0].values.config.volume === "42"
    && actions[0].values.config.muted === true && button.disabled, "one atomic typed save");
  volume.value = "101"; change(volume); button.click(); await delay(0);
  assert(actions.length === 1, "invalid form must not save");
  volume.value = "30"; readOnly = true; change(volume);
  assert(button.disabled, "read-only settings disabled");
  const local = root.querySelector("[data-player-volume]");
  local.value = "15"; change(local);
  root.querySelector("[data-player-mute]").click();
  assert(live.state().volume === 15 && live.state().muted && actions.length === 1, "live controls never persist");
  cleanup(); root.innerHTML = "";
  assert(live.state().active && !live.closes, "modal close must not stop player");
  live.stop();
  assert(context.state === "running", "block never closes shared AudioContext");
  context.createBufferSource = sourceFactory;
  await context.close(); // Only the test owns and closes this page context.
  return { passed: true, decodedResults, fidelity };
}
