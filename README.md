# Audio Play Stream

<!-- block-metadata:start -->
[![Block version: unversioned](https://img.shields.io/badge/block-unversioned-lightgrey)](model.json)
[![BloxSmith compatibility: 1.0.9](https://img.shields.io/badge/BloxSmith-1.0.9-brightgreen)](compatibility.json)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Verified BloxSmith versions: **1.0.9** (bundled-block tests; see [test evidence](compatibility.json)).
<!-- block-metadata:end -->


Play graph audio in the browser displaying the blueprint. This block owns decoding, playback scheduling, volume and muting. The framework only supplies its generic audio bridge and the page's shared audio context.

## Connections and usage

- One **audio input**, `audio_in`, using `audio_stream`, with one incoming connection.
- One **optional data input**, `command_in`, accepting JSON over a separate connection.
- No outputs. Listening does not require a `start` or `stop` message.
- Connect `Microphone Stream.audio_out → Audio Play Stream.audio_in`, or use the Opus/Ogg output of OpenAI TTS Stream.
- Do **not** connect TTS `command_out` to the player: its start/stop messages target STT or Save Audio. The player consumes arriving pages and drains its playback queue naturally.
- Start **Run**, then enable sound when the browser requests it, **before** starting the source.
- Incoming audio is decoded and played progressively. When frames stop arriving, the player remains subscribed.
- Stopping the source lets already scheduled audio finish. Global **Stop**, Pause, Reset or leaving the blueprint immediately stops local playback and releases resources.

The visual order of `audio_in` (ID 1) and `command_in` (ID 2) is unrestricted. The block resolves ports by ID and does not reorder the graph. Missing, duplicate or incompatible ports are rejected; names, transports, multiplicities and optionality are checked.

Use headphones to avoid feedback between a microphone and speakers on the same computer. The card, properties modal and inspector control the same player; closing them does not stop audio. Playback also works without an open modal and inside a closed composite. Each browser has an independent subscription and local settings; browsers are not synchronized, and late subscribers receive no audio history.

## Interruption commands: accepted, but browser interruption is unavailable

`command_in` accepts only `{"action":"interrupt"}`, with a maximum payload of 4 KiB. It rejects start/stop commands, extra fields and invalid JSON. A command can arrive without audio or another ready input. Only the current event or a freshly updated value is processed; consumed or cached commands are not replayed.

**The command does not yet stop sound or clear the queue.** The framework has no public bridge from worker commands to the browser runtime. The block reports this limitation in its properties and inspector, without polling or embedding hidden commands in audio.

In Active Runtime the result is `skipped`, with `audio_play_stream.command.applied: false` and `reason: "browser_command_bridge_unavailable"`. Commands do not change gain or playback. Local mute and global Stop retain their existing behavior.

Existing audio-only nodes still execute and are not migrated automatically. Recreate the node and reconnect it to obtain `command_in`; doing so does not remove the browser-bridge limitation.

## Formats and limits

- **`pcm_s16le`**: signed, interleaved, little-endian 16-bit PCM; mono/stereo; 8–192 kHz. Every frame must correctly identify its sample rate and channels. Incomplete samples split across frames are buffered.
- **`opus`**: **WebM or Ogg**, one mono/stereo track, Opus mapping 0. A new `stream_id` must start with its headers. WebSocket boundaries may split pages, blocks or packets. Incremental demuxing feeds Opus packets to WebCodecs and applies supported pre-skip, gain and final padding.
- Decoder state is retained for the entire `stream_id`. The player waits for each packet's PCM output **without calling `flush()` between packets**. Repeated flushes reset Chromium's decoder and distorted speech even when Save Audio produced a valid recording. Playback does not wait for the end of a sentence or stream.
- Opus requires browser `AudioDecoder` support, checked when a stream starts. PCM does not require WebCodecs. **AAC/MP4 and raw, uncontained Opus are rejected.** A WebM/Ogg microphone is compatible; an AAC-only browser capture is not.
- Streams must be sequential, not interleaved. A new `stream_id` creates a decoder without cancelling previously scheduled samples. Missing sequence numbers or a changed profile stop this player with an explicit diagnostic.
- No seeking, video synchronization, replay, multitrack mixing or loss recovery. Packets play in arrival order; container timestamp gaps are not reproduced. Negative WebM padding is unsupported.
- Limits: 512 KiB per frame, 1 MiB container buffer, 64 KiB per Opus packet, eight temporary decoder outputs and 1,024 scheduled small buffers. `max_buffer_sec` bounds queued playback time. Consumption waits for space before ACK; prolonged saturation or a stalled decoder closes only this player, not the Run or other subscribers.
- Only one Opus packet is decoded at a time. Outputs must match expected channels, sample rate, timestamps and sample count. Failure to produce complete output within 2.5 seconds reports an error and closes the subscription. Stop or decoder failure immediately cancels that wait and releases partial or late outputs.
- Without an end event on the audio input, a truncated final sample/header can only be diagnosed when `stream_id` changes. Stop releases the fragment without inventing audio.

## Properties

The shared format with Microphone Stream, OpenAI TTS Stream, Save Audio and Realtime STT is **Opus in WebM or Ogg**. PCM remains available for other sources.

The modal uses the application's opaque panel, accessible header and Apply button, internal scrolling, collapsible advanced settings and integrated diagnostics that expand on error. Current browser playback is separate from next-Run configuration. Volume is shown as a percentage; unavailable controls explain why no player is active. Desktop, small-screen and keyboard interactions are tested in the real application shell.

Apply saves these settings for the **next Run**:

| Setting | Default | Range | Effect |
| --- | --- | --- | --- |
| Initial volume | 80% | 0–100% | Initial gain for each browser player |
| Start muted | No | Yes/No | Consume the stream without audible output |
| Playback margin | 100 ms | 20–1,000 ms | Scheduling headroom against jitter |
| Maximum audio queue | 5 s | 1–10 s | Bound on scheduled browser audio |

Local volume and mute/unmute act immediately in that browser without saving configuration or affecting other users. Muting does not build a backlog to replay later. Playback errors are local; a server status of “ready” means subscription is possible, not that a physical speaker produced sound.

## Runtime and architecture

- **Active Runtime (`zeromq_active`)**: the generic host starts `audio_play_streamBrowserRuntime` on Run with the wired audio input and cancellation signal. The worker remains available. Data messages activate it separately through `on_each_event`, without waiting for audio.
- **One Shot Simulation (`centralized`)**: `skipped`, with no playback, subscription, fake output or browser side effect. A valid command is checked but reports `applied: false`, `reason: "simulation"`. The mini-graph remains runnable.
- No API key, temporary file, disk access, server-side playback, CDN or added dependency.
- `block.py` uses only the public `bloxsmith_app.block_api`.
- `assets/js/opus_demux.js` implements incremental Ogg/WebM parsing.
- `assets/js/browser_runtime.js` owns PCM/WebCodecs, gain, scheduling and cleanup.
- `assets/js/common.js` and the three surface scripts share local controls only. The block never closes the framework's shared `AudioContext`.

## Verification

The block-owned suite is `tests/F5.47_audio_play_stream_block.py`. From the private integration workspace, run:

```sh
python3 -B tests/run_tests.py audio_play_stream
```

Captures are written to ignored results with no hard-coded personal path. FB1–FB6 cover contracts, validation, discovery/assets, Microphone → Audio Play mini-graphs in both modes, real audio transport, browser decoding of FFmpeg-generated PCM/Ogg/WebM, independent volume/mute, properties, limits, errors and cancellation.

A browser MediaRecorder oscillator test covers Run → WebSocket ingress → audio link → WebSocket egress → playback → Stop without opening a modal. Inputs are synthetic: no microphone permission, API key or OpenAI request. Tests inspect scheduled audio buffers, not physical speakers or the user's acoustic environment.

Sample-by-sample comparisons against **libopus through FFmpeg** cover mono/stereo Ogg/WebM and locally synthesized speech using FFmpeg's `flite` filter. Signal-to-error ratio must exceed 60 dB, with gain within 0.1% of the reference, including after a new `stream_id`. This catches the repeated-flush regression that duration or silence checks would miss. Partial decoding, late/invalid outputs, native decoder errors and timeout cancellation are also covered.

The TTS suite `F5.49_opus_interoperability.py` additionally decodes actual TTS output pages through runtime egress, checking exact duration after pre-skip and final trimming in mono/stereo; only the OpenAI API is simulated.

A real Text → Python JSON → Audio Play mini-graph checks commands in both modes without audio or external APIs: fresh/cached/invalid commands, legacy nodes and the unapplied-interruption diagnostic. Reordered inputs, duplicate IDs and altered contracts are tested while preserving legacy audio-only nodes and user-selected visual order.

## Compatibility policy

[compatibility.json](compatibility.json) records HackInvent's verified BloxSmith versions and test evidence. Only the versions listed above have been verified, using the block-owned suites in a **bundled-block test installation**. This is not a certification of managed-package installation, every browser/OS, or live provider availability. Other framework versions are unverified, not necessarily incompatible.

The block-version badge follows `model.json`, not a published Git tag. `unversioned` means that no block release version is declared; no number is inferred from the framework version. The framework still uses `model.json` for its runtime/install contract; the tester-owned JSON does not replace it. Official integration tests run in the private `bloxmith-blocs` workspace. Test helpers and the proprietary framework are not bundled in this public block repository.
