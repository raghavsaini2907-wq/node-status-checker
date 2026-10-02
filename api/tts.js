import {
  EdgeTTS,
  Constants
} from "@andresaya/edge-tts";

import {
  MPEGDecoder
} from "mpg123-decoder";


const DEFAULT_VOICE =
  "en-IN-NeerjaNeural";

const MAX_TEXT_LENGTH =
  4000;


/*
============================================================
 EVA EDGE TTS → MP3 → RAW PCM PROXY
============================================================

 INPUT:
   text

 EDGE TTS:
   24 kHz
   mono
   MP3

 DECODER:
   mpg123 WASM

 OUTPUT:
   RAW PCM
   24,000 Hz
   16-bit
   mono

 OUTPUT BYTE RATE:

   24000 samples
   × 2 bytes
   × 1 channel

   = 48000 bytes/sec

============================================================
*/


function sendError(
  res,
  status,
  message
) {

  if (!res.headersSent) {

    res.statusCode =
      status;

    res.setHeader(
      "Content-Type",
      "text/plain; charset=utf-8"
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );
  }

  res.end(message);
}


/*
============================================================
 FLOAT32 → SIGNED 16-BIT PCM
============================================================
*/

function float32ToPCM16(
  channelData
) {

  const sampleCount =
    channelData.length;


  const output =
    Buffer.allocUnsafe(
      sampleCount * 2
    );


  for (
    let i = 0;
    i < sampleCount;
    i++
  ) {

    let sample =
      channelData[i];


    /*
     * Clamp to valid
     * Float32 audio range.
     */

    if (sample > 1) {
      sample = 1;
    }

    if (sample < -1) {
      sample = -1;
    }


    /*
     * Convert:

       -1.0 → -32768
        0.0 → 0
       +1.0 → +32767
    */

    let value;


    if (
      sample < 0
    ) {

      value =
        Math.round(
          sample * 32768
        );

    } else {

      value =
        Math.round(
          sample * 32767
        );
    }


    output.writeInt16LE(
      value,
      i * 2
    );
  }


  return output;
}


/*
============================================================
 RESAMPLE MONO PCM
============================================================

 Edge TTS currently gives us 24 kHz.

 We still keep this function so the output is guaranteed
 to be exactly 24 kHz even if the upstream voice/output
 changes later.

============================================================
*/

function resampleMono(
  samples,
  inputRate,
  outputRate
) {

  if (
    inputRate ===
    outputRate
  ) {

    return samples;
  }


  const outputLength =
    Math.floor(
      samples.length *
      outputRate /
      inputRate
    );


  const output =
    new Float32Array(
      outputLength
    );


  const ratio =
    inputRate /
    outputRate;


  for (
    let i = 0;
    i < outputLength;
    i++
  ) {

    const sourcePosition =
      i * ratio;


    const index =
      Math.floor(
        sourcePosition
      );


    const fraction =
      sourcePosition -
      index;


    const sampleA =
      samples[
        Math.min(
          index,
          samples.length - 1
        )
      ];


    const sampleB =
      samples[
        Math.min(
          index + 1,
          samples.length - 1
        )
      ];


    output[i] =
      sampleA +
      (
        sampleB -
        sampleA
      ) *
      fraction;
  }


  return output;
}


/*
============================================================
 MAIN HANDLER
============================================================
*/

export default async function handler(
  req,
  res
) {

  /*
   * --------------------------------------------------------
   * METHOD
   * --------------------------------------------------------
   */

  if (
    req.method !==
    "GET"
  ) {

    res.setHeader(
      "Allow",
      "GET"
    );

    return sendError(
      res,
      405,
      "Method Not Allowed"
    );
  }


  try {

    /*
     * ------------------------------------------------------
     * TEXT
     * ------------------------------------------------------
     */

    const text =
      typeof req.query?.text ===
      "string"

        ? req.query.text.trim()

        : "";


    if (!text) {

      return sendError(
        res,
        400,
        "Missing text parameter"
      );
    }


    if (
      text.length >
      MAX_TEXT_LENGTH
    ) {

      return sendError(
        res,
        400,
        `Text is too long. Maximum is ${MAX_TEXT_LENGTH} characters.`
      );
    }


    /*
     * ------------------------------------------------------
     * VOICE
     * ------------------------------------------------------
     */

    const voice =
      typeof req.query?.voice ===
        "string" &&
      req.query.voice.trim()
        .length > 0

        ? req.query.voice.trim()

        : DEFAULT_VOICE;


    console.log(
      "=================================================="
    );

    console.log(
      "[EVA-TTS] START"
    );

    console.log(
      `[EVA-TTS] VOICE=${voice}`
    );

    console.log(
      `[EVA-TTS] TEXT_LENGTH=${text.length}`
    );


    /*
     * ------------------------------------------------------
     * CREATE EDGE TTS
     * ------------------------------------------------------
     */

    const tts =
      new EdgeTTS();


    /*
     * We ask Edge TTS for
     * its working MP3 format.
     *
     * The previous test already proved that this
     * produces valid audio.
     */

    const mp3Format =
      Constants
        .OUTPUT_FORMAT
        .AUDIO_24KHZ_48KBITRATE_MONO_MP3;


    console.log(
      `[EVA-TTS] MP3 FORMAT=${mp3Format}`
    );


    /*
     * ------------------------------------------------------
     * SYNTHESIZE
     * ------------------------------------------------------
     */

    console.log(
      "[EVA-TTS] SYNTHESIZE START"
    );


    await tts.synthesize(
      text,
      voice,
      {
        rate: "0%",
        pitch: "0Hz",
        volume: "100%",
        outputFormat:
          mp3Format
      }
    );


    console.log(
      "[EVA-TTS] SYNTHESIZE COMPLETE"
    );


    /*
     * ------------------------------------------------------
     * GET MP3 BUFFER
     * ------------------------------------------------------
     */

    const mp3Buffer =
      tts.toBuffer();


    if (
      !mp3Buffer ||
      mp3Buffer.length === 0
    ) {

      throw new Error(
        "Edge TTS returned zero MP3 bytes"
      );
    }


    console.log(
      `[EVA-TTS] MP3 BYTES=${mp3Buffer.length}`
    );


    /*
     * ------------------------------------------------------
     * INITIALIZE MPEG DECODER
     * ------------------------------------------------------
     */

    console.log(
      "[EVA-TTS] INITIALIZING MPEG DECODER"
    );


    const decoder =
      new MPEGDecoder();


    await decoder.ready;


    console.log(
      "[EVA-TTS] MPEG DECODER READY"
    );


    /*
     * ------------------------------------------------------
     * DECODE MP3
     * ------------------------------------------------------
     */

    const decoded =
      decoder.decode(
        new Uint8Array(
          mp3Buffer
        )
      );


    if (!decoded) {

      decoder.free();

      throw new Error(
        "MP3 decoder returned no data"
      );
    }


    console.log(
      `[EVA-TTS] DECODED SAMPLE RATE=${decoded.sampleRate}`
    );


    console.log(
      `[EVA-TTS] DECODED SAMPLES=${decoded.samplesDecoded}`
    );


    /*
     * ------------------------------------------------------
     * DECODER ERRORS
     * ------------------------------------------------------
     */

    if (
      decoded.errors &&
      decoded.errors.length > 0
    ) {

      console.warn(
        `[EVA-TTS] DECODER WARNINGS=${decoded.errors.length}`
      );


      for (
        const error
        of decoded.errors
      ) {

        console.warn(
          "[EVA-TTS] DECODER WARNING",
          error
        );
      }
    }


    /*
     * ------------------------------------------------------
     * CHECK CHANNELS
     * ------------------------------------------------------
     */

    if (
      !decoded.channelData ||
      decoded.channelData.length === 0
    ) {

      decoder.free();

      throw new Error(
        "MP3 decoder returned zero channels"
      );
    }


    /*
     * Edge TTS should give
     * mono for our selected
     * voice/format.
     *
     * If multiple channels somehow arrive,
     * convert them to mono.
     */

    let monoSamples;


    if (
      decoded.channelData.length === 1
    ) {

      monoSamples =
        decoded.channelData[0];

    } else {

      const left =
        decoded.channelData[0];

      const right =
        decoded.channelData[1];


      const count =
        Math.min(
          left.length,
          right.length
        );


      monoSamples =
        new Float32Array(
          count
        );


      for (
        let i = 0;
        i < count;
        i++
      ) {

        monoSamples[i] =
          (
            left[i] +
            right[i]
          ) *
          0.5;
      }
    }


    /*
     * ------------------------------------------------------
     * FREE DECODER
     * ------------------------------------------------------
     */

    decoder.free();


    /*
     * ------------------------------------------------------
     * GUARANTEE 24 KHZ
     * ------------------------------------------------------
     */

    const pcmFloat =
      resampleMono(
        monoSamples,
        decoded.sampleRate,
        24000
      );


    console.log(
      `[EVA-TTS] OUTPUT SAMPLES=${pcmFloat.length}`
    );


    /*
     * ------------------------------------------------------
     * FLOAT → INT16
     * ------------------------------------------------------
     */

    const pcmBuffer =
      float32ToPCM16(
        pcmFloat
      );


    if (
      !pcmBuffer ||
      pcmBuffer.length === 0
    ) {

      throw new Error(
        "PCM conversion produced zero bytes"
      );
    }


    /*
     * ------------------------------------------------------
     * AUDIO INFORMATION
     * ------------------------------------------------------
     */

    const duration =
      pcmBuffer.length /
      48000;


    console.log(
      `[EVA-TTS] PCM BYTES=${pcmBuffer.length}`
    );


    console.log(
      `[EVA-TTS] PCM DURATION=${duration.toFixed(2)}s`
    );


    /*
     * ------------------------------------------------------
     * HTTP RESPONSE
     * ------------------------------------------------------
     */

    res.statusCode =
      200;


    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );


    res.setHeader(
      "Content-Length",
      String(
        pcmBuffer.length
      )
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


    /*
     * ------------------------------------------------------
     * SEND RAW PCM
     * ------------------------------------------------------
     */

    res.end(
      pcmBuffer
    );


    console.log(
      `[EVA-TTS] COMPLETE | SENT=${pcmBuffer.length} PCM BYTES`
    );


    console.log(
      "=================================================="
    );


  } catch (
    error
  ) {

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


    if (
      res.headersSent
    ) {

      if (
        !res.writableEnded
      ) {

        res.end();
      }

      return;
    }


    return sendError(
      res,
      502,
      `Edge TTS conversion failed: ${message}`
    );
  }
}
