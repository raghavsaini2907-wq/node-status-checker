import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const DEFAULT_VOICE = "en-IN-NeerjaNeural";
const MAX_TEXT_LENGTH = 4000;

// WAV / RIFF PCM.
// We will remove the WAV container header and return pure PCM.
const OUTPUT_AUDIO_FORMAT =
  OUTPUT_FORMAT.RIFF_24KHZ_16BIT_MONO_PCM;


function sendError(res, status, message) {
  if (!res.headersSent) {
    res.statusCode = status;

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
 EVA — COLLECT EDGE TTS AUDIO
============================================================

We intentionally collect the complete stream first.

Reason:
The previous implementation was directly piping the
MsEdgeTTS stream into the Vercel response.

Your Vercel logs showed:

"Stream closed before the synthesis completed
(no turn.end received)"

So the HTTP response could finish with ZERO bytes.

This version waits for the audio stream to finish,
then sends one verified PCM response.
*/


function collectAudio(audioStream) {
  return new Promise((resolve, reject) => {

    const chunks = [];

    let totalBytes = 0;
    let settled = false;

    function finishOk() {
      if (settled) {
        return;
      }

      settled = true;

      resolve(
        Buffer.concat(chunks, totalBytes)
      );
    }


    function finishError(error) {
      if (settled) {
        return;
      }

      settled = true;

      reject(error);
    }


    audioStream.on(
      "data",
      (chunk) => {

        try {

          const buffer =
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);

          if (buffer.length === 0) {
            return;
          }

          chunks.push(buffer);

          totalBytes += buffer.length;

        } catch (error) {

          finishError(error);

        }
      }
    );


    audioStream.on(
      "end",
      () => {

        console.log(
          `[EVA-TTS] AUDIO END | bytes=${totalBytes}`
        );

        finishOk();

      }
    );


    audioStream.on(
      "error",
      (error) => {

        console.error(
          "[EVA-TTS] AUDIO STREAM ERROR",
          error
        );

        finishError(error);

      }
    );


    audioStream.on(
      "close",
      () => {

        console.log(
          `[EVA-TTS] AUDIO CLOSE | bytes=${totalBytes}`
        );

        /*
         * Some Node readable streams emit close after end.
         *
         * If audio data was already received, allow the
         * collected data to be returned instead of treating
         * close as an immediate zero-byte failure.
         */

        if (totalBytes > 0) {
          finishOk();
        }

      }
    );

  });
}


/*
============================================================
 EVA — REMOVE RIFF/WAV HEADER
============================================================
*/

function extractPCM(buffer) {

  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }


  /*
   * Standard RIFF/WAVE begins with:
   *
   * 52 49 46 46 = RIFF
   * ....
   * 57 41 56 45 = WAVE
   *
   * Do not blindly assume 44 bytes.
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
      offset + 8 <= buffer.length
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


      if (chunkId === "data") {

        const dataStart =
          offset + 8;

        const dataEnd =
          Math.min(
            dataStart + chunkSize,
            buffer.length
          );

        return buffer.subarray(
          dataStart,
          dataEnd
        );
      }


      /*
       * RIFF chunks are word aligned.
       */

      offset +=
        8 +
        chunkSize +
        (chunkSize % 2);
    }


    throw new Error(
      "RIFF/WAVE header found but PCM data chunk was not found"
    );
  }


  /*
   * If the package already returned raw PCM,
   * accept it directly.
   */

  return buffer;
}


/*
============================================================
 EVA — MAIN VERCEL HANDLER
============================================================
*/

export default async function handler(
  req,
  res
) {

  if (req.method !== "GET") {

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
      typeof req.query?.voice === "string" &&
      req.query.voice.trim().length > 0
        ? req.query.voice.trim()
        : DEFAULT_VOICE;


    console.log(
      "=================================================="
    );

    console.log(
      `[EVA-TTS] START`
    );

    console.log(
      `[EVA-TTS] VOICE=${voice}`
    );

    console.log(
      `[EVA-TTS] TEXT_LENGTH=${text.length}`
    );


    /*
     * ------------------------------------------------------
     * CREATE TTS
     * ------------------------------------------------------
     */

    const tts =
      new MsEdgeTTS();


    await tts.setMetadata(
      voice,
      OUTPUT_AUDIO_FORMAT
    );


    console.log(
      "[EVA-TTS] METADATA READY"
    );


    /*
     * ------------------------------------------------------
     * START SYNTHESIS
     * ------------------------------------------------------
     */

    const result =
      tts.toStream(
        text,
        {
          rate: 1,
          pitch: "0Hz"
        }
      );


    if (
      !result ||
      !result.audioStream
    ) {

      throw new Error(
        "Edge TTS did not return an audio stream"
      );
    }


    console.log(
      "[EVA-TTS] SYNTHESIS STREAM CREATED"
    );


    /*
     * ------------------------------------------------------
     * COLLECT COMPLETE AUDIO
     * ------------------------------------------------------
     */

    const wavBuffer =
      await collectAudio(
        result.audioStream
      );


    console.log(
      `[EVA-TTS] RAW STREAM BYTES=${wavBuffer.length}`
    );


    if (
      !wavBuffer ||
      wavBuffer.length === 0
    ) {

      throw new Error(
        "Edge TTS returned zero audio bytes"
      );
    }


    /*
     * ------------------------------------------------------
     * EXTRACT PURE PCM
     * ------------------------------------------------------
     */

    const pcmBuffer =
      extractPCM(
        wavBuffer
      );


    console.log(
      `[EVA-TTS] PCM BYTES=${pcmBuffer.length}`
    );


    if (
      !pcmBuffer ||
      pcmBuffer.length === 0
    ) {

      throw new Error(
        "PCM extraction produced zero bytes"
      );
    }


    /*
     * ------------------------------------------------------
     * PCM SANITY CHECK
     * ------------------------------------------------------
     *
     * 24 kHz
     * 16-bit
     * mono
     *
     * 48,000 bytes/sec
     */

    const durationSeconds =
      pcmBuffer.length / 48000;


    console.log(
      `[EVA-TTS] PCM DURATION=${durationSeconds.toFixed(2)}s`
    );


    /*
     * ------------------------------------------------------
     * SEND RESPONSE
     * ------------------------------------------------------
     */

    res.statusCode = 200;


    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );


    res.setHeader(
      "Content-Length",
      String(pcmBuffer.length)
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
     * WRITE COMPLETE PCM
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
