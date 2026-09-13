/** Bounded, incremental audio-only Ogg/WebM demuxing. No decoder or IO lives in the framework.
 * Container rules: RFC 7845 / RFC 3533 (Ogg), RFC 9559 (Matroska), RFC 6716 (Opus TOC).
 */
(function () {
  "use strict";
  const ui = window.CWAudioPlayStream;
  const LIMIT = 1024 * 1024;
  const text = bytes => new TextDecoder().decode(bytes);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  /** Copy only the unfinished bounded tail plus the next network chunk. */
  function join(left, right) {
    check(left.length + right.length <= LIMIT, "En-tête ou paquet audio trop volumineux (1 Mio maximum).");
    const data = new Uint8Array(left.length + right.length);
    data.set(left); data.set(right, left.length);
    return data;
  }
  /** Decode an EBML integer, distinguishing incomplete and unknown-sized values. */
  function vint(data, offset, id = false) {
    if (offset >= data.length) return null;
    const first = data[offset];
    let width = 1;
    while (width <= 8 && !(first & (128 >> (width - 1)))) width++;
    check(width <= (id ? 4 : 8), "Entier WebM invalide.");
    if (offset + width > data.length) return null;
    let value = id ? first : first & ((128 >> (width - 1)) - 1);
    let unknown = !id && value === ((128 >> (width - 1)) - 1);
    for (let i = 1; i < width; i++) {
      value = value * 256 + data[offset + i];
      unknown = unknown && data[offset + i] === 255;
    }
    check(unknown || Number.isSafeInteger(value), "Taille WebM hors limites.");
    return { width, value, unknown };
  }
  /** Read a bounded unsigned EBML payload without 32-bit truncation. */
  function uint(bytes) {
    check(bytes.length <= 8, "Entier WebM trop long.");
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    check(Number.isSafeInteger(value), "Entier WebM hors limites.");
    return value;
  }
  /** Return packet duration in samples at Opus's 48 kHz decode clock. */
  function samples(packet) {
    check(packet.length > 0 && packet.length <= 65536, "Paquet Opus vide ou trop volumineux.");
    const config = packet[0] >> 3;
    const ms = config < 12 ? [10, 20, 40, 60][config & 3]
      : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
    const code = packet[0] & 3;
    const count = code === 0 ? 1 : code === 3 ? (packet[1] || 0) & 63 : 2;
    check(count > 0 && ms * count <= 120, "Durée de paquet Opus invalide.");
    return Math.round(ms * count * 48);
  }

  /** Parse one logical, mono/stereo Opus stream, awaiting each bounded packet consumer.
   * @param {number} channels - Channels declared by the graph audio frame.
   * @param {Function} onPacket - Awaited callback receiving a raw Opus packet and trim counts.
   */
  class OpusDemux {
    constructor(channels, onPacket) {
      this.channels = channels; this.onPacket = onPacket;
      this.buffer = new Uint8Array(); this.format = null;
      this.header = null; this.preSkip = 0; this.gain = 1; this.totalSamples = 0;
      this.oggSerial = null; this.oggSequence = null; this.oggPartial = new Uint8Array();
      this.oggHeaders = 0; this.ended = false;
      this.position = 0; this.stack = []; this.trackCount = 0;
      this.trackNumber = null; this.trackType = null; this.codecId = null;
      this.trackComplete = false; this.group = null;
    }

    /** Validate OpusHead once; apply pre-skip/gain in the block, decode raw Opus in WebCodecs. */
    readHeader(bytes) {
      check(!this.header && bytes.length === 19 && text(bytes.subarray(0, 8)) === "OpusHead"
        && bytes[8] < 16 && bytes[9] === this.channels && bytes[18] === 0,
      "En-tête Opus mono/stéréo manquant ou incompatible ; relancez la source après activation du son.");
      this.header = bytes.slice();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.preSkip = view.getUint16(10, true);
      this.gain = 10 ** (view.getInt16(16, true) / (20 * 256));
    }

    /** Produce ordered raw packets with sample-accurate start/end trimming metadata. */
    async emit(data, finalSample = null, discard = 0) {
      check(this.header, "Début du flux Opus manquant ; relancez la source après activation du son.");
      const count = samples(data);
      const start = this.totalSamples;
      this.totalSamples += count;
      const trimStart = Math.min(count, Math.max(0, this.preSkip - start));
      const trimEnd = Math.min(count - trimStart, Math.max(discard,
        finalSample === null ? 0 : this.totalSamples - finalSample, 0));
      await this.onPacket({ data, samples: count, timestamp: Math.round(start * 1000000 / 48000),
        trimStart, trimEnd, gain: this.gain });
    }

    /** Accept arbitrary network boundaries, retaining only incomplete container bytes. */
    async push(bytes) {
      check(!this.ended || bytes.length === 0, "Données reçues après la fin du flux Ogg.");
      this.buffer = join(this.buffer, bytes);
      if (!this.format && this.buffer.length >= 4) {
        if (text(this.buffer.subarray(0, 4)) === "OggS") this.format = "ogg";
        else if (this.buffer[0] === 0x1a && this.buffer[1] === 0x45 && this.buffer[2] === 0xdf && this.buffer[3] === 0xa3) this.format = "webm";
        else throw new Error("En-tête Opus WebM/Ogg manquant. Activez le son avant de démarrer la source.");
      }
      if (this.format === "ogg") await this.ogg();
      if (this.format === "webm") await this.webm();
    }

    /** Reassemble Ogg lacing across pages and enforce one contiguous logical stream. */
    async ogg() {
      while (this.buffer.length >= 27) {
        const data = this.buffer;
        check(!this.ended && text(data.subarray(0, 4)) === "OggS" && data[4] === 0, "Page Ogg invalide.");
        const count = data[26];
        if (data.length < 27 + count) return;
        const sizes = data.subarray(27, 27 + count);
        const size = 27 + count + sizes.reduce((sum, value) => sum + value, 0);
        if (data.length < size) return;
        const view = new DataView(data.buffer, data.byteOffset, size);
        const serial = view.getUint32(14, true); const sequence = view.getUint32(18, true);
        const first = this.oggSerial === null;
        check(first ? Boolean(data[5] & 2) && sequence === 0
          : serial === this.oggSerial && sequence === ((this.oggSequence + 1) >>> 0) && !(data[5] & 2),
        "Début du flux Ogg manquant, page perdue ou flux entrelacés.");
        check(Boolean(data[5] & 1) === Boolean(this.oggPartial.length), "Continuation Ogg incohérente.");
        this.oggSerial = serial; this.oggSequence = sequence;
        const end = Boolean(data[5] & 4);
        const granule = view.getBigUint64(6, true);
        check(!end || granule <= BigInt(Number.MAX_SAFE_INTEGER), "Position finale Ogg invalide.");
        let offset = 27 + count;
        for (const length of sizes) {
          this.oggPartial = join(this.oggPartial, data.subarray(offset, offset + length));
          offset += length;
          if (length === 255) continue;
          const packet = this.oggPartial;
          this.oggPartial = new Uint8Array();
          if (this.oggHeaders === 0) { this.readHeader(packet); this.oggHeaders++; }
          else if (this.oggHeaders === 1) {
            check(packet.length >= 16 && text(packet.subarray(0, 8)) === "OpusTags", "En-tête OpusTags invalide.");
            this.oggHeaders++;
          } else await this.emit(packet, end ? Number(granule) : null);
        }
        check(!end || !this.oggPartial.length, "Dernier paquet Ogg tronqué.");
        this.ended = end;
        this.buffer = data.slice(size);
      }
    }

    /** Separate all standard Matroska lacing modes, without buffering whole recordings. */
    async block(bytes, discard = 0) {
      const track = vint(bytes, 0);
      check(this.trackComplete && track && !track.unknown && track.value === this.trackNumber
        && bytes.length >= track.width + 3, "Piste ou bloc WebM audio invalide.");
      let offset = track.width + 3;
      const lace = (bytes[track.width + 2] & 6) >> 1;
      const sizes = [];
      if (!lace) sizes.push(bytes.length - offset);
      else {
        check(offset < bytes.length, "Lacing WebM tronqué.");
        const count = bytes[offset++] + 1;
        check(count >= 2, "Lacing WebM invalide.");
        if (lace === 2) {
          const length = (bytes.length - offset) / count;
          check(Number.isInteger(length), "Lacing WebM fixe invalide.");
          sizes.push(...Array(count).fill(length));
        } else {
          for (let index = 0; index < count - 1; index++) {
            let length = 0;
            if (lace === 1) {
              let next;
              do { check(offset < bytes.length, "Lacing Xiph tronqué."); next = bytes[offset++]; length += next; } while (next === 255);
            } else {
              const value = vint(bytes, offset);
              check(value && !value.unknown, "Lacing EBML tronqué.");
              offset += value.width;
              length = value.value + (index ? sizes[index - 1] - (2 ** (7 * value.width - 1) - 1) : 0);
            }
            check(length > 0 && length <= 65536, "Taille Opus WebM invalide.");
            sizes.push(length);
          }
          sizes.push(bytes.length - offset - sizes.reduce((sum, value) => sum + value, 0));
        }
      }
      for (let index = 0; index < sizes.length; index++) {
        const length = sizes[index];
        check(length > 0 && offset + length <= bytes.length, "Paquet WebM tronqué.");
        await this.emit(bytes.subarray(offset, offset + length), null, index === sizes.length - 1 ? discard : 0);
        offset += length;
      }
    }

    /** Close bounded master elements and account for trailing Matroska discard padding. */
    async closeMasters() {
      while (this.stack.length && this.position >= this.stack.at(-1).end) {
        const entry = this.stack.pop();
        check(this.position === entry.end, "Élément WebM hors de son conteneur.");
        if (entry.id === 0xae) {
          check(this.header && this.trackType === 2 && this.codecId === "A_OPUS" && this.trackNumber > 0,
            "Seule une piste audio WebM Opus est prise en charge.");
          this.trackComplete = true;
        }
        if (entry.id === 0xa0) {
          check(this.group?.data, "Bloc WebM vide.");
          await this.block(this.group.data, this.group.discard);
          this.group = null;
        }
      }
    }

    /** Traverse finite/streaming EBML masters; skip bounded metadata and emit audio blocks. */
    async webm() {
      const masters = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);
      const levelOne = new Set([0x1f43b675, 0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x1254c367]);
      while (this.buffer.length) {
        await this.closeMasters();
        const id = vint(this.buffer, 0, true);
        if (!id) return;
        const size = vint(this.buffer, id.width);
        if (!size) return;
        // An unknown-length live Cluster ends at the next Segment child, not at EOF.
        if (levelOne.has(id.value) && this.stack.at(-1)?.id === 0x1f43b675 && this.stack.at(-1).end === Infinity) this.stack.pop();
        const headerSize = id.width + size.width;
        const end = size.unknown ? Infinity : this.position + headerSize + size.value;
        check(size.unknown || end <= (this.stack.at(-1)?.end ?? Infinity), "Taille d'élément WebM incohérente.");
        if (masters.has(id.value)) {
          check(!size.unknown || [0x18538067, 0x1f43b675].includes(id.value), "Conteneur WebM sans taille non pris en charge.");
          check(this.stack.length < 12, "Imbrication WebM excessive.");
          if (id.value === 0xae) { this.trackCount++; check(this.trackCount === 1, "WebM multipiste non pris en charge."); }
          if (id.value === 0xa0) { check(!this.group, "BlockGroup imbriqué."); this.group = { data: null, discard: 0 }; }
          this.stack.push({ id: id.value, end });
          this.position += headerSize; this.buffer = this.buffer.slice(headerSize);
          continue;
        }
        check(!size.unknown && size.value <= LIMIT - 12, "Métadonnées WebM trop volumineuses.");
        if (this.buffer.length < headerSize + size.value) return;
        const bytes = this.buffer.subarray(headerSize, headerSize + size.value);
        if (id.value === 0xd7) this.trackNumber = uint(bytes);
        else if (id.value === 0x83) this.trackType = uint(bytes);
        else if (id.value === 0x86) this.codecId = text(bytes);
        else if (id.value === 0x63a2) this.readHeader(bytes);
        else if (id.value === 0x9f) check(uint(bytes) === this.channels, "Canaux WebM incompatibles.");
        else if (id.value === 0xa3) await this.block(bytes);
        else if (id.value === 0xa1) { check(this.group && !this.group.data, "Block WebM hors groupe."); this.group.data = bytes.slice(); }
        else if (id.value === 0x75a2) {
          check(this.group && bytes.length && !(bytes[0] & 128), "DiscardPadding WebM négatif non pris en charge.");
          this.group.discard = Math.round(uint(bytes) * 48000 / 1000000000);
        }
        const consumed = headerSize + size.value;
        this.position += consumed; this.buffer = this.buffer.slice(consumed);
      }
      await this.closeMasters();
    }

    /** Refuse a truncated stream when a new stream_id supplies the next recording. */
    finish() {
      check(this.header && !this.buffer.length && !this.oggPartial.length && !this.group,
        "Flux Opus précédent incomplet ; relancez la lecture.");
    }
  }
  ui.OpusDemux = OpusDemux;
})();
