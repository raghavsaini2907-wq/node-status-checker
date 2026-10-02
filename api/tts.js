import {
  EdgeTTS,
  Constants
} from "@andresaya/edge-tts";


const DEFAULT_VOICE =
  "en-IN-NeerjaNeural";


const MAX_TEXT_LENGTH =
  4000;


const PCM_FORMAT =
  Constants.OUTPUT_FORMAT.RIFF_24KHZ_16BIT_MONO_PCM;


/*
============================================================
 EVA EDGE TTS PROXY
 ============================================================

 FLOW:

 HTTP request
      ↓
 EdgeTTS.synthesize()
      ↓
 complete WAV/PCM buffer
      ↓
 remove RIFF/WAV container
      ↓
 raw 24 kHz / 16-bit / mono PCM
      ↓
 HTTP response

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
 REMOVE RIFF/WAV CONTAINER
============================================================
*/

function extractPCM(
  buffer
) {

  if (
    !Buffer.isBuffer(buffer)
  ) {

    buffer =
      Buffer.from(buffer);
  }


  /*
   * Check RIFF/WAVE
   */

  if (
    buffer.length >= 12 &&
    buffer.toString(
      "ascii",
      0,
      4
    ) === "RIFF" &&
    buffer.toString(
      "ascii",
      8,
      12
    ) === "WAVE"
  ) {

    let offset = 12;


    while (
      offset + 8 <=
      buffer.length
    ) {

      const chunkId =
        buffer.toString(
          "ascii",
          offset,
          offset + 4
        );


      const chunkSize =
        buffer.readUInt32LE(
          offset + 4
        );


      if (
        chunkId ===
        "data"
      ) {

        const dataStart =
          offset + 8;


        const dataEnd =
          Math.min(
            dataStart +
              chunkSize,
            buffer.length
          );


        return buffer.subarray(
          dataStart,
          dataEnd
        );
      }


      /*
       * RIFF chunks are
       * word aligned.
       */

      offset +=
        8 +
        chunkSize +
        (chunkSize % 2);
    }


    throw new Error(
      "RIFF/WAVE received but PCM data chunk was not found"
    );
  }


  /*
   * Already raw PCM.
   */

  return buffer;
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
     * ------------------------------------------------------
     * SYNTHESIZE
     * ------------------------------------------------------
     *
     * IMPORTANT:
     *
     * We are NOT using msedge-tts.
     *
     * We let @andresaya/edge-tts handle the
     * WebSocket turn lifecycle internally.
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
          PCM_FORMAT
      }
    );


    console.log(
      "[EVA-TTS] SYNTHESIZE COMPLETE"
    );


    /*
     * ------------------------------------------------------
     * GET BUFFER
     * ------------------------------------------------------
     */

    const wavBuffer =
      tts.toBuffer();


    if (
      !wavBuffer ||
      wavBuffer.length === 0
    ) {

      throw new Error(
        "Edge TTS returned zero audio bytes"
      );
    }


    console.log(
      `[EVA-TTS] GENERATED BYTES=${wavBuffer.length}`
    );


    /*
     * ------------------------------------------------------
     * EXTRACT RAW PCM
     * ------------------------------------------------------
     */

    const pcmBuffer =
      extractPCM(
        wavBuffer
      );


    if (
      !pcmBuffer ||
      pcmBuffer.length === 0
    ) {

      throw new Error(
        "PCM extraction produced zero bytes"
      );
    }


    console.log(
      `[EVA-TTS] PCM BYTES=${pcmBuffer.length}`
    );


    /*
     * ------------------------------------------------------
     * AUDIO INFO
     * ------------------------------------------------------
     *
     * 24,000 Hz
     * 16-bit
     * mono
     *
     * bytes/sec:
     *
     * 24000 × 2 × 1
     * = 48000
     */

    const duration =
      pcmBuffer.length /
      48000;


    console.log(
      `[EVA-TTS] DURATION=${duration.toFixed(2)}s`
    );


    /*
     * ------------------------------------------------------
     * HTTP HEADERS
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
     * SEND PCM
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
      `Edge TTS synthesis failed: ${message}`
    );
  }
}
