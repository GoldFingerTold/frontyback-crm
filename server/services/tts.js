// Genera la respuesta hablada (voz femenina) con ElevenLabs, para responder los audios de
// WhatsApp con un audio en vez de texto. Una sola cuenta de ElevenLabs compartida entre
// todos los clientes del CRM (el volumen por cliente es bajo, no hace falta una cuenta
// por cliente - ver server/services/whatsapp.js para el envío del audio ya generado).
//
// ElevenLabs devuelve mp3 (su formato más confiable), pero WhatsApp solo muestra un
// mensaje como "nota de voz" nativa si es ogg con códec opus - por eso se convierte acá
// mismo con ffmpeg antes de mandarlo.

const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
ffmpeg.setFfmpegPath(ffmpegPath);

async function generarAudioMp3(texto) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey) throw new Error('Falta ELEVENLABS_API_KEY en el .env.');
  if (!voiceId) throw new Error('Falta ELEVENLABS_VOICE_ID en el .env.');

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: texto,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 0.85 }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error generando audio (ElevenLabs): ${errText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function convertirAOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const entrada = new PassThrough();
    entrada.end(mp3Buffer);
    const chunks = [];

    ffmpeg(entrada)
      .audioCodec('libopus')
      .audioChannels(1)
      .format('ogg')
      .on('error', reject)
      .pipe()
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

async function generarAudio(texto) {
  const mp3 = await generarAudioMp3(texto);
  return convertirAOggOpus(mp3);
}

module.exports = { generarAudio };
