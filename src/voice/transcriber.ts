// Transcription des vocaux, derrière une interface interchangeable :
// on peut passer d'OpenAI à un autre service sans toucher au reste.

export interface Transcriber {
  transcribe(audio: Buffer, mimetype: string): Promise<string>;
}

/** Le compte n'a plus de crédit : on arrête tout et on prévient (leçon du 06/11 chez Freddy). */
export class OutOfCreditError extends Error {
  constructor() {
    super('crédit OpenAI épuisé');
    this.name = 'OutOfCreditError';
  }
}

export interface OpenAIOptions {
  apiKey: string;
  /** whisper-1 par défaut (fiable en français, choix de Freddy). */
  model?: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAITranscriber implements Transcriber {
  constructor(private readonly opts: OpenAIOptions) {}

  async transcribe(audio: Buffer, mimetype: string): Promise<string> {
    const form = new FormData();
    const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'm4a' : mimetype.includes('mpeg') ? 'mp3' : 'ogg';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype.split(';')[0] }), `vocal.${ext}`);
    form.append('model', this.opts.model ?? 'whisper-1');
    form.append('language', this.opts.language ?? 'fr');
    form.append('response_format', 'text');

    const res = await (this.opts.fetchImpl ?? fetch)('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });
    if (res.ok) return (await res.text()).trim();

    const text = await res.text();
    if (res.status === 429 && text.includes('insufficient_quota')) throw new OutOfCreditError();
    if (res.status === 401) throw new Error('clé OpenAI refusée');
    throw new Error(`OpenAI ${res.status}`);
  }
}
