# whatsapp-mcp

Serveur MCP **en lecture seule** qui recopie le WhatsApp de Justin pour son second brain (`/flux`, `/historique`). Construit d'après le kit `WHATSAPP-MCP.md` de Bateson (Freddy Mallet).

Le service se connecte comme un appareil lié (comme WhatsApp Web), recopie les conversations dans une base SQLite, transcrit les vocaux et expose des outils de lecture à Claude.

## Règles non négociables

- **Lecture seule** : aucune fonction d'envoi de Baileys (un test le vérifie), jamais « en ligne ».
- **Journaux sans contenu de message**, secrets jamais en argument d'une commande.
- **Une seule instance** : deux instances se volent la session WhatsApp.
- La base contient les messages des proches et collègues de Justin : elle ne quitte pas son compte.

## Avancement

| Pièce | État |
|---|---|
| 1. Connexion et lecture des événements | faite |
| 2. Base SQLite et recherche | faite |
| 3. Transcription des vocaux | faite (à brancher sur une vraie clé OpenAI au déploiement) |
| 4. Outils MCP et serveur HTTP | faite |

## Outils MCP (lecture seule)

`status`, `list_active_chats`, `search_chats`, `export_chat`, `search_messages`, `transcribe_voice_notes`, `get_attachment`. Sorties en lignes ou tableaux à tabulations, dates en heure de Paris.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `MCP_TOKEN` | Jeton de Claude, 64 caractères hexadécimaux (`openssl rand -hex 32`) |
| `ADMIN_PASSWORD` | Mot de passe de la page `/admin` (QR d'appairage), 16 caractères au moins |
| `OPENAI_API_KEY` | Clé OpenAI pour les vocaux (facultative : sans elle, pas de transcription) |
| `DATA_DIR` | Dossier de la base et des identifiants WhatsApp (`/data` par défaut) |
| `PUBLIC_HOST` | Nom public du serveur, active la protection DNS rebinding |

## Commandes

```bash
npm install
npm test        # tests, sans connexion à WhatsApp
npm run build
```

## Déploiement (VPS)

```bash
git clone git@github.com:JustinDRFS/whatsapp-mcp.git && cd whatsapp-mcp
cp deploy/env.example .env && chmod 600 .env   # puis remplir .env
mkdir -p data && sudo chown 1000:1000 data     # l'utilisateur « node » du conteneur
docker compose up -d --build
docker compose logs -f app                     # journal, sans contenu de message
```

Puis ouvrir `https://<PUBLIC_HOST>/admin` et scanner le QR depuis WhatsApp > Réglages > Appareils connectés.
Connecteur claude.ai : URL `https://<PUBLIC_HOST>/mcp`, sans connexion, en-tête `Authorization: Bearer <MCP_TOKEN>`.
