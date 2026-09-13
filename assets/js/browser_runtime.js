/** Browser-owned decoding, bounded playback scheduling and run-scoped resource cleanup. */
(function () {
  "use strict";
  const ui = window.CWAudioPlayStream;
  const registry = (window.CWBlockUiBlocks = window.CWBlockUiBlocks || {});
  const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

  /** Play one sequential audio input using the page-shared AudioContext.
   * @param {object} api - Browser runtime facade with node, audioContext and abort signal.
   * @returns {object} An awaited frame consumer, local controls and an idempotent disposer.
   */
  ui.createPlayer = function createPlayer(api) {
    const context = api.audioContext;
    const raw = api.node.config || {};
    const config = { volume: Number(raw.volume ?? 80), muted: raw.muted ?? false,
      latency: Number(raw.latency_ms ?? 100) / 1000, maxBuffer: Number(raw.max_buffer_sec ?? 5) };
    requireValue(Number.isFinite(config.volume) && config.volume >= 0 && config.volume <= 100
      && typeof config.muted === "boolean" && config.latency >= 0.02 && config.latency <= 1
      && config.maxBuffer >= 1 && config.maxBuffer <= 10, "Réglages de lecture invalides.");
    const gain = context.createGain();
    gain.gain.value = config.muted ? 0 : config.volume / 100;
    gain.connect(context.destination);
    const sources = new Set();
    let stream = null;
    const retired = new Set();
    let decoder = null;
    let decoded = [];
    let decoderError = null;
    let pendingDecode = null;
    let demux = null;
    let pcmTail = new Uint8Array();
    let nextTime = 0;
    let disposed = false;
    let receivedFrames = 0;
    let playedSamples = 0;
    let highWaterSeconds = 0;
    let message = "À l’écoute de audio_in.";
    let error = false;
    let frameDeadline = 0;

    /** Enforce run cancellation, browser suspension and the transport ACK deadline. */
    function alive() {
      requireValue(!disposed && !api.signal.aborted, "Lecture arrêtée.");
      requireValue(context.state === "running", "Son suspendu dans le navigateur. Réactivez le son.");
      requireValue(!frameDeadline || Date.now() < frameDeadline, "Lecteur saturé : impossible de suivre le flux audio.");
      if (decoderError) throw decoderError;
    }
    const notify = () => ui.notify();
    /** Schedule short PCM buffers; await capacity before ACK instead of growing an unbounded queue. */
    async function schedule(buffer) {
      alive();
      while (Math.max(0, nextTime - context.currentTime) + buffer.duration > config.maxBuffer) {
        await new Promise(resolve => setTimeout(resolve, 15));
        alive();
      }
      requireValue(sources.size < 1024, "Trop de fragments audio en attente.");
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      sources.add(source);
      source.onended = () => {
        source.disconnect(); sources.delete(source);
        if (!disposed && !sources.size) { message = "À l’écoute de audio_in."; notify(); }
      };
      const start = Math.max(nextTime, context.currentTime + Math.min(config.latency, config.maxBuffer - buffer.duration));
      nextTime = start + buffer.duration;
      source.start(start);
      playedSamples += buffer.length;
      highWaterSeconds = Math.max(highWaterSeconds, nextTime - context.currentTime);
      message = config.muted ? "Flux reçu · silence local." : "Lecture en cours.";
    }

    /** Decode interleaved signed little-endian PCM, carrying incomplete samples across frames. */
    async function pcm(bytes, profile) {
      const data = new Uint8Array(pcmTail.length + bytes.length);
      data.set(pcmTail); data.set(bytes, pcmTail.length);
      const stride = profile.channels * 2;
      const count = Math.floor(data.length / stride);
      const view = new DataView(data.buffer);
      pcmTail = data.slice(count * stride);
      for (let offset = 0; offset < count; offset += 4096) {
        alive();
        const length = Math.min(4096, count - offset);
        const buffer = context.createBuffer(profile.channels, length, profile.sample_rate_hz);
        for (let channel = 0; channel < profile.channels; channel++) {
          const target = buffer.getChannelData(channel);
          for (let sample = 0; sample < length; sample++) {
            target[sample] = view.getInt16((offset + sample) * stride + channel * 2, true) / 32768;
          }
        }
        await schedule(buffer);
      }
    }

    /** Reject an outstanding packet and close native frames without flushing/reinitializing Opus. */
    function closeDecoder() {
      const previous = decoder;
      decoder = null;
      pendingDecode?.reject(new Error("Lecture arrêtée."));
      pendingDecode = null;
      if (previous && previous.state !== "closed") previous.close();
      for (const frame of decoded) frame.close();
      decoded = [];
    }

    /** Fail an in-flight decode immediately, retaining the cause for the next lifecycle check. */
    function failDecode(failure) {
      decoderError = failure;
      pendingDecode?.reject(failure);
    }

    /** Decode one Opus packet continuously, then trim and schedule all its samples.
     * @param {object} packet - Demuxed bytes, timestamp, sample count and container trimming/gain.
     * Only one packet is outstanding. Its output callback, not flush(), signals completion:
     * flushing between packets reinitializes Chromium's decoder and corrupts predictive audio.
     */
    async function opus(packet) {
      alive();
      requireValue(!pendingDecode && decoded.length === 0, "Décodage audio concurrent non pris en charge.");
      let pending;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          pending = { resolve, reject, expected: packet.samples, received: 0, timestamp: packet.timestamp };
          pendingDecode = pending;
          timer = setTimeout(() => reject(new Error("Le décodeur Opus ne répond plus.")), 2500);
          decoder.decode(new window.EncodedAudioChunk({ type: "key", timestamp: packet.timestamp,
            duration: packet.samples * 1000000 / 48000, data: packet.data }));
        });
      } finally {
        clearTimeout(timer);
        if (pendingDecode === pending) pendingDecode = null;
      }
      alive();
      const frames = decoded;
      decoded = [];
      let offset = 0;
      try {
        for (const frame of frames) {
          requireValue(frame.sampleRate === 48000 && frame.numberOfChannels === stream.channels,
            "Profil PCM décodé incompatible.");
          const begin = Math.max(0, packet.trimStart - offset);
          const end = Math.min(frame.numberOfFrames, packet.samples - packet.trimEnd - offset);
          if (end > begin) {
            const buffer = context.createBuffer(frame.numberOfChannels, end - begin, 48000);
            for (let channel = 0; channel < frame.numberOfChannels; channel++) {
              const plane = buffer.getChannelData(channel);
              frame.copyTo(plane, { planeIndex: channel, format: "f32-planar", frameOffset: begin, frameCount: end - begin });
              if (packet.gain !== 1) for (let i = 0; i < plane.length; i++) plane[i] = Math.max(-1, Math.min(1, plane[i] * packet.gain));
            }
            await schedule(buffer);
          }
          offset += frame.numberOfFrames;
        }
        requireValue(offset === packet.samples, "Le décodeur Opus a renvoyé une durée inattendue.");
      } finally { for (const frame of frames) frame.close(); }
    }

    /** Start a fresh decoder on each stream_id; late or interleaved recordings are rejected. */
    async function begin(frame) {
      if (stream) {
        requireValue(!retired.has(frame.stream_id), "Flux audio entrelacés non pris en charge.");
        requireValue(pcmTail.length === 0, "Dernier échantillon PCM tronqué.");
        demux?.finish();
        retired.add(stream.stream_id);
        if (retired.size > 128) retired.delete(retired.values().next().value);
      }
      closeDecoder();
      stream = { stream_id: frame.stream_id, source_id: frame.source_id, codec: frame.codec,
        sample_rate_hz: frame.sample_rate_hz, channels: frame.channels, sequence: frame.sequence - 1 };
      demux = null; pcmTail = new Uint8Array(); decoderError = null;
      if (frame.codec === "opus") {
        requireValue(window.AudioDecoder && window.EncodedAudioChunk,
          "Ce navigateur ne propose pas le décodage Opus WebCodecs. Utilisez une source PCM ou un navigateur compatible.");
        const options = { codec: "opus", sampleRate: 48000, numberOfChannels: frame.channels };
        const support = await window.AudioDecoder.isConfigSupported(options);
        alive();
        requireValue(support.supported, "Décodage Opus non pris en charge dans ce navigateur.");
        const ownedDecoder = new window.AudioDecoder({
          /** Complete the current packet only after all its bounded PCM output has arrived. */
          output(data) {
            if (disposed || decoder !== ownedDecoder) { data.close(); return; }
            const pending = pendingDecode;
            if (!pending || decoded.length >= 8) {
              data.close(); failDecode(new Error("Sortie du décodeur inattendue ou file audio saturée.")); return;
            }
            const expectedTimestamp = pending.timestamp + Math.round(pending.received * 1000000 / 48000);
            if (data.sampleRate !== 48000 || data.numberOfChannels !== stream.channels
                || data.numberOfFrames <= 0 || pending.received + data.numberOfFrames > pending.expected
                || Math.abs(data.timestamp - expectedTimestamp) > 1) {
              data.close(); failDecode(new Error("Profil, durée ou horodatage PCM décodé incompatible.")); return;
            }
            decoded.push(data);
            pending.received += data.numberOfFrames;
            if (pending.received === pending.expected) pending.resolve();
          },
          error(failure) {
            if (!disposed && decoder === ownedDecoder) failDecode(new Error(`Décodage Opus interrompu : ${failure.message}`));
          },
        });
        decoder = ownedDecoder;
        // Raw packets: container pre-skip, gain and end trimming are applied by this block.
        decoder.configure(options);
        demux = new ui.OpusDemux(frame.channels, opus);
      }
    }

    /** Validate transport metadata and consume exactly one ordered frame before its ACK. */
    async function enqueue(frame) {
      frameDeadline = Date.now() + 12000;
      alive();
      requireValue(frame.payload instanceof ArrayBuffer && frame.payload.byteLength > 0
        && frame.payload.byteLength <= 524288, "Trame audio vide ou trop volumineuse.");
      requireValue(["pcm_s16le", "opus"].includes(frame.codec), "Format audio non pris en charge : PCM16 ou Opus WebM/Ogg attendu.");
      requireValue([1, 2].includes(frame.channels) && Number.isInteger(frame.sample_rate_hz)
        && frame.sample_rate_hz >= 8000 && frame.sample_rate_hz <= 192000
        && typeof frame.stream_id === "string" && frame.stream_id.length > 0
        && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0, "Profil de trame audio invalide.");
      if (!stream || stream.stream_id !== frame.stream_id) await begin(frame);
      requireValue(frame.sequence === stream.sequence + 1 && frame.source_id === stream.source_id
        && frame.codec === stream.codec && frame.channels === stream.channels && frame.sample_rate_hz === stream.sample_rate_hz,
      "Trame audio manquante ou profil modifié en cours de flux. Relancez la lecture.");
      stream.sequence = frame.sequence;
      if (frame.codec === "pcm_s16le") await pcm(new Uint8Array(frame.payload), stream);
      else await demux.push(new Uint8Array(frame.payload));
      receivedFrames++;
      frameDeadline = 0;
      notify();
    }

    /** Stop only this block's sources/decoder/gain; the page-shared AudioContext stays open. */
    function dispose(reason = "Lecture arrêtée.", failed = false) {
      if (disposed) return;
      disposed = true;
      message = reason; error = failed;
      api.signal.removeEventListener("abort", abort);
      for (const source of sources) {
        source.onended = null;
        try { source.stop(); } catch (_) { /* A source may already have ended. */ }
        source.disconnect();
      }
      sources.clear(); closeDecoder(); gain.disconnect();
      demux = null; pcmTail = new Uint8Array(); retired.clear();
      notify();
    }
    const abort = () => dispose();
    api.signal.addEventListener("abort", abort, { once: true });
    if (api.signal.aborted) dispose();
    const snapshot = () => ({ message, error, volume: config.volume, muted: config.muted,
      active: !disposed, receivedFrames, playedSamples, highWaterSeconds });
    return { enqueue, dispose, snapshot,
      /** Adjust only this browser's gain; mute continues draining the stream. */
      setVolume(value) {
        if (disposed || !Number.isFinite(value) || value < 0 || value > 100) return;
        config.volume = value;
        gain.gain.setTargetAtTime(config.muted ? 0 : value / 100, context.currentTime, 0.01);
        notify();
      },
      /** Toggle local silence without changing any graph or transport state. */
      setMuted(value) {
        if (disposed) return;
        config.muted = Boolean(value);
        gain.gain.setTargetAtTime(config.muted ? 0 : config.volume / 100, context.currentTime, 0.01);
        if (sources.size) message = config.muted ? "Flux reçu · silence local." : "Lecture en cours.";
        notify();
      },
    };
  };

  registry.audio_play_streamBrowserRuntime = {
    /** Attach once per Run/browser/node; all UI surfaces control this same receiver. */
    async start(api) {
      const key = ui.key(api.runtimeAudioStreams.getContext());
      const player = ui.createPlayer(api);
      let receiver = null;
      let stopped = false;
      /** Release only this subscription; retain a lightweight diagnostic for local surfaces. */
      const stop = (message = "Lecture arrêtée.", failed = false) => {
        if (stopped) return;
        stopped = true;
        api.signal.removeEventListener("abort", abort);
        player.dispose(message, failed);
        receiver?.close();
        ui.set(key, { snapshot: player.snapshot() });
      };
      const abort = () => stop();
      api.signal.addEventListener("abort", abort, { once: true });
      ui.set(key, { player });
      try {
        requireValue(!api.signal.aborted, "Lecture arrêtée.");
        receiver = await api.runtimeAudioStreams.openInput({ inputPort: "audio_in",
          async onFrame(frame) {
            try { await player.enqueue(frame); }
            catch (failure) { stop(failure.message || "Lecture interrompue.", !api.signal.aborted); throw failure; }
          },
          onState(event) { if (event.type === "runtime_audio_stream.closed") stop("Connexion audio fermée. Relancez Run pour réessayer."); },
          onError(failure) { stop(failure.message || "Connexion audio interrompue.", true); },
        });
        if (stopped || api.signal.aborted) { receiver.close(); stop(); }
        return () => stop();
      } catch (failure) {
        stop(failure.message || "Impossible d’ouvrir le lecteur.", !api.signal.aborted);
        throw failure;
      }
    },
  };
})();
