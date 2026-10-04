import { EdgeTTS, Constants } from "@andresaya/edge-tts";
import { MPEGDecoder } from "mpg123-decoder";

const DEFAULT_VOICE = "hi-IN-SwaraNeural";
const MAX_TEXT_LENGTH = 4000;

function sendError(res, status, message) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(message);
}

function float32ToPCM16(channelData) {
  const sampleCount = channelData.length;
  const output = Buffer.allocUnsafe(sampleCount * 2);

  for (let i = 0; i < sampleCount; i++) {
    let sample = channelData[i];
    if (sample > 1) sample = 1;
    if (sample < -1) sample = -1;

    const value = sample < 0 
      ? Math.round(sample * 32768) 
      : Math.round(sample * 32767);

    output.writeInt16LE(value, i * 2);
  }
  return output;
}

function resampleMono(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;

  const outputLength = Math.floor((samples.length * outputRate) / inputRate);
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;

  for (let i = 0; i < outputLength; i++) {
    const sourcePosition = i * ratio;
    const index = Math.floor(sourcePosition);
    const fraction = sourcePosition - index;
    const sampleA = samples[Math.min(index, samples.length - 1)];
    const sampleB = samples[Math.min(index + 1, samples.length - 1)];
    output[i] = sampleA + (sampleB - sampleA) * fraction;
  }
  return output;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendError(res, 405, "Method Not Allowed");
  }

  const startTime = Date.now();

  try {
    const text = typeof req.query?.text === "string" ? req.query.text.trim() : "";
    if (!text) {
      return sendError(res, 400, "Missing text parameter");
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return sendError(res, 400, `Text exceeds ${MAX_TEXT_LENGTH} limit.`);
    }

    const voice =
      typeof req.query?.voice === "string" && req.query.voice.trim().length > 0
        ? req.query.voice.trim()
        : DEFAULT_VOICE;

    console.log("==================================================");
    console.log("[EVA-TTS] TRUE STREAM START");
    console.log(`[EVA-TTS] VOICE=${voice} | TEXT_LEN=${text.length}`);

    // Set headers for chunked streaming to ESP32
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-EVA-Audio-Format", "raw-24khz-16bit-mono-pcm");
    res.setHeader("X-EVA-Sample-Rate", "24000");
    res.setHeader("X-EVA-Channels", "1");
    res.setHeader("X-EVA-Bits", "16");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");

    console.log("[EVA-TTS] HTTP HEADERS SENT");

    // Initialize persistent decoder for stream
    const decoder = new MPEGDecoder();
    await decoder.ready;
    console.log("[EVA-TTS] MPEG DECODER READY");

    const tts = new EdgeTTS();
    const mp3Format = Constants.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

    let edgeChunkCount = 0;
    let pcmChunkCount = 0;
    let totalPcmBytes = 0;
    let firstPcmLogged = false;

    // EdgeTTS stream generator
    const audioStream = tts.synthesizeStream(text, voice, {
      rate: "0%",
      pitch: "0Hz",
      volume: "100%",
      outputFormat: mp3Format,
    });

    for await (const chunk of audioStream) {
      edgeChunkCount++;
      if (edgeChunkCount === 1) {
        console.log(`[EVA-TTS] EDGE CHUNK #1 | bytes=${chunk.length}`);
      }

      // Feed MP3 chunk to persistent decoder
      const decoded = decoder.decode(chunk);
      if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
        continue;
      }

      // Convert channels to mono if needed
      let monoSamples;
      if (decoded.channelData.length === 1) {
        monoSamples = decoded.channelData[0];
      } else {
        const left = decoded.channelData[0];
        const right = decoded.channelData[1];
        const count = Math.min(left.length, right.length);
        monoSamples = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          monoSamples[i] = (left[i] + right[i]) * 0.5;
        }
      }

      if (monoSamples.length === 0) continue;

      // Resample to 24000 Hz if decoded sample rate differs
      const pcmFloat = resampleMono(monoSamples, decoded.sampleRate, 24000);
      const pcmBuffer = float32ToPCM16(pcmFloat);

      if (pcmBuffer.length > 0) {
        pcmChunkCount++;
        totalPcmBytes += pcmBuffer.length;

        if (!firstPcmLogged) {
          firstPcmLogged = true;
          console.log(`[EVA-TTS] FIRST PCM | latency=${Date.now() - startTime}ms | size=${pcmBuffer.length}`);
        }

        res.write(pcmBuffer);
      }
    }

    // Flush any leftover samples from decoder buffer
    try {
      decoder.free();
    } catch (_) {}

    res.end();

    const totalDuration = (totalPcmBytes / 48000).toFixed(2);
    console.log(`[EVA-TTS] STREAM COMPLETE | Total Edge Chunks: ${edgeChunkCount} | Total PCM Chunks: ${pcmChunkCount}`);
    console.log(`[EVA-TTS] STATS: ${totalPcmBytes} bytes (~${totalDuration}s audio) | total-ms=${Date.now() - startTime}`);
    console.log("==================================================");

  } catch (error) {
    console.error("[EVA-TTS] STREAM ERROR:", error);
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      return sendError(res, 502, `Edge TTS conversion failed: ${message}`);
    } else {
      if (!res.writableEnded) res.end();
    }
  }
}
