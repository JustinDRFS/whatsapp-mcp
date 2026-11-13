// Ce que le service retient de WhatsApp, indépendamment de Baileys.
// Toutes les dates sont des secondes Unix (UTC) ; l'affichage en heure de Paris se fait plus tard.

export type MessageType =
  | 'text'
  | 'voice' // vocal enregistré dans WhatsApp (ptt)
  | 'audio' // fichier audio envoyé
  | 'image'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'other';

export interface StoredMessage {
  id: string;
  chatJid: string;
  /** Auteur : 'me' si c'est Justin, sinon le JID de l'expéditeur (numéro ou LID). */
  senderJid: string;
  /** Autre identifiant de l'expéditeur fourni par WhatsApp (le numéro si senderJid est un LID, ou l'inverse). */
  senderAltJid?: string;
  fromMe: boolean;
  timestamp: number;
  type: MessageType;
  /** Texte, légende d'un média, ou description courte (nom de fichier, lieu…). */
  body: string;
  /** Nom de profil choisi par l'expéditeur. */
  pushName?: string;
  /** Durée d'un vocal ou d'un audio, en secondes. */
  durationSec?: number;
  /** Message brut, gardé pour retélécharger un média à la demande (on ne stocke jamais le média). */
  raw: unknown;
}

export interface MessageEdit {
  chatJid: string;
  targetId: string;
  /** Auteur de la modification, à comparer avec l'auteur du message visé. */
  authorJid: string;
  newBody: string;
  editedAt: number;
}

export interface MessageRevoke {
  chatJid: string;
  targetId: string;
  authorJid: string;
  revokedAt: number;
}

export type NormalizedEvent =
  | { kind: 'message'; message: StoredMessage }
  | { kind: 'edit'; edit: MessageEdit }
  | { kind: 'revoke'; revoke: MessageRevoke };

export interface LidMapping {
  lid: string;
  pn: string;
}

export interface ContactInfo {
  jid: string;
  lid?: string;
  pn?: string;
  /** Nom dans le carnet d'adresses de Justin. */
  savedName?: string;
  /** Nom de profil choisi par la personne. */
  pushName?: string;
}

export interface ChatInfo {
  jid: string;
  name?: string;
  lid?: string;
  pn?: string;
}

/** Là où l'ingestion dépose ce qu'elle lit (implémenté par la base, pièce 2). */
export interface IngestSink {
  saveMessages(messages: StoredMessage[]): void;
  applyEdit(edit: MessageEdit): void;
  applyRevoke(revoke: MessageRevoke): void;
  saveLidMappings(mappings: LidMapping[]): void;
  saveContacts(contacts: ContactInfo[]): void;
  saveChats(chats: ChatInfo[]): void;
}
