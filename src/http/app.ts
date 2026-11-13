// La porte d'entrée : /mcp pour Claude (jeton), /admin pour Justin (mot de passe, QR d'appairage).

import { createHash, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import QRCode from 'qrcode';
import { formatTs } from '../format.js';
import { buildServer, type ToolDeps } from '../mcp/tools.js';

/** Comparaison en temps constant : la durée ne révèle pas combien de caractères étaient justes. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface AppOptions {
  deps: ToolDeps;
  mcpToken: string;
  adminPassword: string;
  /** Nom public du serveur ; active la protection contre le DNS rebinding. */
  publicHost?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Aucune page ne doit être mise en cache ni affichée dans un cadre.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.all('/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, opts.mcpToken)) return c.text('Unauthorized', 401);

    // Mode sans session : un serveur neuf par requête, rien ne traîne en mémoire.
    const server = buildServer(opts.deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(opts.publicHost ? { enableDnsRebindingProtection: true, allowedHosts: [opts.publicHost] } : {}),
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  app.get('/admin', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const decoded = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (!decoded || !safeEqual(password, opts.adminPassword)) {
      c.header('WWW-Authenticate', 'Basic realm="whatsapp-mcp", charset="UTF-8"');
      return c.text('Unauthorized', 401);
    }
    const state = opts.deps.connection();
    const s = opts.deps.store.status();
    const qr = state.qr ? await QRCode.toString(state.qr, { type: 'svg', margin: 2, width: 320 }) : '';
    const body = qr
      ? `<p>Sur ton téléphone : WhatsApp &gt; Réglages &gt; Appareils connectés &gt; Connecter un appareil, puis scanne :</p>${qr}<p>La page se recharge toute seule.</p>`
      : `<p>Session : <b>${esc(state.status)}</b>${state.lastOpenAt ? `, connectée depuis le ${esc(formatTs(state.lastOpenAt))}` : ''}.</p>`;
    return c.html(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${state.status === 'open' ? '' : '<meta http-equiv="refresh" content="15">'}
<title>WhatsApp de Justin</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem;line-height:1.5}svg{width:100%;height:auto}</style>
</head><body><h1>WhatsApp, second brain</h1>${body}
<p>${s.messages} messages, ${s.chats} conversations, dernier le ${esc(formatTs(s.lastTs))}.<br>
Vocaux en attente : ${s.voicePending}, en échec : ${s.voiceFailed}.</p></body></html>`);
  });

  app.notFound((c) => c.text('Not found', 404));
  return app;
}
