// Transcripción de audios entrantes (notas de voz de WhatsApp) con Whisper de OpenAI.
// Solo se usa para dejar registrado en la ficha qué dijo el cliente - la respuesta que se
// manda de vuelta es siempre el mismo mensaje "en breve te vamos a contactar", no depende
// de entender el contenido, así que un error acá no debería frenar la respuesta automática.

async function transcribirAudio(buffer, mimeType = 'audio/ogg') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY en el .env.');

  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'oga';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `audio.${extension}`);
  form.append('model', 'whisper-1');
  form.append('language', 'es');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Error transcribiendo audio (Whisper): ${JSON.stringify(data)}`);
  return data.text;
}

module.exports = { transcribirAudio };
