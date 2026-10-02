import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const DEFAULT_VOICE = "en-IN-NeerjaNeural";
const MAX_TEXT_LENGTH = 4000;

// EVA needs:
// 24 kHz
// 16-bit
// Mono
// PCM
const AUDIO_FORMAT = OUTPUT_FORMAT.RIFF_24KHZ_16BIT_MONO_PCM;

function sendError(res, status, message) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
  }

  res.end(message);
}

function streamPCM(audioStream, res) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let headerBuffer = Buffer.alloc(0);
    let headerRemoved = false;

    audioStream.on("data", (chunk) => {
      try {
        let data = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);

        /*
         * Edge TTS returns RIFF/WAV PCM.
         * EVA needs RAW PCM only.
         *
         * We therefore remove the WAV header before
         * sending anything to ESP32.
         */

        if (!headerRemoved) {
          headerBuffer = Buffer.concat([
            headerBuffer,
            data
          ]);

          if (headerBuffer.length < 44) {
            return;
          }

          // Standard RIFF/WAV header is normally 44 bytes.
          data = headerBuffer.subarray(44);

          headerBuffer = Buffer.alloc(0);
          headerRemoved = true;
        }

        if (data.length > 0) {
          totalBytes += data.length;
          res.write(data);
        }

      } catch (err) {
        reject(err);
      }
    });

    audioStream.on("end", () => {
      resolve(totalBytes);
    });

    audioStream.on("close", () => {
      if (totalBytes > 0) {
        resolve(totalBytes);
      }
    });

    audioStream.on("error", (err) => {
      reject(err);
    });
  });
}

export default async function handler(req, res) {

  // --------------------------------------------------
  // METHOD
  // --------------------------------------------------

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return sendError(
      res,
      405,
      "Method Not Allowed"
    );
  }

  try {

    // ------------------------------------------------
    // TEXT
    // ------------------------------------------------

    const text =
      typeof req.query?.text === "string"
        ? req.query.text.trim()
        : "";

    if (!text) {
      return sendError(
        res,
        400,
        "Missing text parameter"
      );
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return sendError(
        res,
        400,
        `Text is too long. Maximum is ${MAX_TEXT_LENGTH} characters.`
      );
    }

    // ------------------------------------------------
    // VOICE
    // ------------------------------------------------

    const voice =
      typeof req.query?.voice === "string" &&
      req.query.voice.trim().length > 0
        ? req.query.voice.trim()
        : DEFAULT_VOICE;

    console.log(
      `[EVA-TTS] START | voice=${voice} | chars=${text.length}`
    );

    // ------------------------------------------------
    // CREATE TTS
    // ------------------------------------------------

    const tts = new MsEdgeTTS();

    await tts.setMetadata(
      voice,
      AUDIO_FORMAT
    );

    console.log(
      "[EVA-TTS] METADATA READY"
    );

    // ------------------------------------------------
    // START STREAM
    // ------------------------------------------------

    const result = tts.toStream(
      text,
      {
        rate: 1,
        pitch: "0Hz",
        volume: 100
      }
    );

    const audioStream = result.audioStream;

    if (!audioStream) {
      throw new Error(
        "Edge TTS did not provide an audio stream"
      );
    }

    console.log(
      "[EVA-TTS] AUDIO STREAM CREATED"
    );

    // ------------------------------------------------
    // RESPONSE HEADERS
    // ------------------------------------------------

    res.statusCode = 200;

    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );

    res.setHeader(
      "X-EVA-Audio-Format",
      "raw-24khz-16bit-mono-pcm"
    );

    res.setHeader(
      "X-EVA-Sample-Rate",
      "24000"
    );

    res.setHeader(
      "X-EVA-Channels",
      "1"
    );

    res.setHeader(
      "X-EVA-Bits",
      "16"
    );

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    // Start HTTP response immediately.
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    // ------------------------------------------------
    // STREAM AUDIO
    // ------------------------------------------------

    const pcmBytes =
      await streamPCM(
        audioStream,
        res
      );

    console.log(
      `[EVA-TTS] COMPLETE | PCM bytes=${pcmBytes}`
    );

    // ------------------------------------------------
    // ZERO AUDIO CHECK
    // ------------------------------------------------

    if (pcmBytes === 0) {

      console.error(
        "[EVA-TTS] ERROR | ZERO PCM BYTES"
      );

      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    // ------------------------------------------------
    // END
    // ------------------------------------------------

    if (!res.writableEnded) {
      res.end();
    }

  } catch (error) {

    console.error(
      "[EVA-TTS] ERROR",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[EVA-TTS] ERROR MESSAGE | ${message}`
    );

    if (res.headersSent) {

      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    return sendError(
      res,
      502,
      `Edge TTS synthesis failed: ${message}`
    );
  }
}
