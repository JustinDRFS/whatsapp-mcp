// File de transcription : un vocal à la fois (piège n° 8), en fond pour les 30 derniers jours,
// à la demande au-delà. Statuts : pending, done, failed, missing.

import type { WAMessage } from '@whiskeysockets/baileys';
import type { Store } from '../store/store.js';
import type { MediaFetcher } from '../whatsapp/media.js';
import { OutOfCreditError, type Transcriber } from './transcriber.js';

export const CREDIT_ALERT = 'alert_openai_credit';
const THIRTY_DAYS = 30 * 86_400;

export interface RunOptions {
  since?: number;
  chatJid?: string;
  limit?: number;
  retryFailed?: boolean;
}

export interface RunResult {
  done: number;
  failed: number;
  missing: number;
  /** Arrêt parce que le crédit OpenAI est épuisé : les vocaux restent en attente, rien n'est perdu. */
  outOfCredit: boolean;
}

export class VoiceQueue {
  private lock: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly fetcher: MediaFetcher,
    private readonly transcriber: Transcriber,
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Transcrit une série de vocaux, un par un. Deux appels simultanés passent l'un après l'autre. */
  run(opts: RunOptions = {}): Promise<RunResult> {
    const next = this.lock.then(() => this.runUnlocked(opts));
    this.lock = next.catch(() => {});
    return next;
  }

  private async runUnlocked(opts: RunOptions): Promise<RunResult> {
    const result: RunResult = { done: 0, failed: 0, missing: 0, outOfCredit: false };
    for (const row of this.store.voicesToTranscribe(opts)) {
      const raw = this.store.getRaw(row.chat_jid, row.id) as WAMessage | undefined;
      const media = raw ? await this.fetcher.fetch(raw) : null;
      if (!media) {
        this.store.setTranscript(row.chat_jid, row.id, 'missing');
        result.missing++;
        continue;
      }
      try {
        const text = await this.transcriber.transcribe(media.data, media.mimetype);
        this.store.setTranscript(row.chat_jid, row.id, 'done', text);
        this.store.setMeta(CREDIT_ALERT, null);
        result.done++;
      } catch (err) {
        if (err instanceof OutOfCreditError) {
          // On ne marque pas « failed » : le vocal reste en attente et repartira quand le crédit reviendra.
          this.store.setMeta(CREDIT_ALERT, String(this.now()));
          this.log('vocaux : crédit OpenAI épuisé, transcriptions en pause');
          result.outOfCredit = true;
          break;
        }
        this.store.setTranscript(row.chat_jid, row.id, 'failed', undefined, (err as Error).message.slice(0, 200));
        result.failed++;
      }
    }
    if (result.done + result.failed + result.missing > 0) {
      this.log(`vocaux : ${result.done} transcrits, ${result.failed} en échec, ${result.missing} introuvables`);
    }
    return result;
  }

  /** En fond : les vocaux des 30 derniers jours, par petits paquets. */
  startBackground(everyMs = 5 * 60_000, batch = 20): void {
    const tick = () => void this.run({ since: this.now() - THIRTY_DAYS, limit: batch }).catch(() => {});
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
