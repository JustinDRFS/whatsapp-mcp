// Connexion à WhatsApp comme appareil lié, en lecture seule.
//
// RÈGLE NON NÉGOCIABLE : ce fichier n'appelle aucune fonction d'envoi de Baileys
// (sendMessage, sendPresenceUpdate, readMessages, chatModify…). Un test vérifie
// qu'aucun fichier du dossier src n'en contient.

import { rm } from 'node:fs/promises';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { attachIngest, type Log } from './ingest.js';
import type { IngestSink } from './types.js';

export type ConnectionStatus = 'starting' | 'waiting_qr' | 'open' | 'reconnecting' | 'logged_out';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Dernier QR à scanner (texte brut), tant que l'appairage n'est pas fait. */
  qr?: string;
  /** Dernière connexion réussie (secondes Unix). */
  lastOpenAt?: number;
  /** Code de la dernière déconnexion. */
  lastCloseCode?: number;
  reconnectAttempts: number;
}

/** Attente avant la n-ième tentative : 2 s, 4 s, 8 s… plafonnée à 5 min. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt), 300_000);
}

export interface ConnectionOptions {
  /** Dossier des identifiants Baileys, sur le volume persistant. */
  authDir: string;
  sink: IngestSink;
  log?: Log;
}

export class WhatsAppConnection {
  readonly state: ConnectionState = { status: 'starting', reconnectAttempts: 0 };
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private end?: () => void;

  constructor(private readonly opts: ConnectionOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.end?.();
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  private async connect(): Promise<void> {
    const { state: auth, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const sock = makeWASocket({
      auth,
      // WhatsApp refuse « Desktop » aux clients non officiels (erreur 428).
      browser: Browsers.macOS('Safari'),
      // Ne jamais apparaître « en ligne » : on ne fait que lire.
      markOnlineOnConnect: false,
      syncFullHistory: true,
    });
    this.end = () => sock.end(undefined);

    sock.ev.on('creds.update', saveCreds);
    attachIngest(sock.ev, this.opts.sink, this.opts.log);

    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        this.state.status = 'waiting_qr';
        this.state.qr = u.qr;
        this.log('connexion : QR disponible sur /admin');
      }
      if (u.connection === 'open') {
        this.state.status = 'open';
        this.state.qr = undefined;
        this.state.lastOpenAt = Math.floor(Date.now() / 1000);
        this.state.reconnectAttempts = 0;
        this.log('connexion : ouverte');
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        this.state.lastCloseCode = code;
        void this.onClose(code);
      }
    });
  }

  private async onClose(code: number | undefined): Promise<void> {
    if (this.stopped) return;
    if (code === DisconnectReason.loggedOut) {
      // Session révoquée depuis le téléphone (ou règle des 14 jours) : on repart à l'appairage.
      this.state.status = 'logged_out';
      this.log('connexion : déconnecté par WhatsApp, identifiants effacés, nouvel appairage');
      await rm(this.opts.authDir, { recursive: true, force: true });
      this.state.reconnectAttempts = 0;
      await this.connect();
      return;
    }
    this.state.status = 'reconnecting';
    const delay = backoffDelayMs(this.state.reconnectAttempts++);
    this.log(`connexion : coupée (code ${code ?? '?'}), nouvel essai dans ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => void this.connect(), delay);
  }
}
