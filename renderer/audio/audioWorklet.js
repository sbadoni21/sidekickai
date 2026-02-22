class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = sampleRate; // usually 48000
    this.targetSampleRate = 16000;
    this.ratio = this.inputSampleRate / this.targetSampleRate;
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];
    const outputLength = Math.floor(channel.length / this.ratio);
    const pcm16 = new Int16Array(outputLength);

    let outIndex = 0;
    for (let i = 0; i < channel.length; i += this.ratio) {
      const sample = channel[Math.floor(i)] || 0;
      const s = Math.max(-1, Math.min(1, sample));
      pcm16[outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    this.port.postMessage(pcm16.buffer);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
