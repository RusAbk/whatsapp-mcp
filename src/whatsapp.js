import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

function isPhoneJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

function betterDisplayName(current, next, jid) {
  const values = [current, next].filter(Boolean);
  return values.find((value) => value !== jid && !isLidJid(value)) || values[0] || jid;
}

function jidFromInput(value) {
  if (!value) throw new Error('jid or phone is required');
  const raw = String(value).trim();
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) throw new Error('phone must contain digits');
  return `${digits}@s.whatsapp.net`;
}

function messageText(message) {
  const msg = message?.message;
  if (!msg) return '';
  const content = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg;
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.pollCreationMessage?.name ||
    ''
  );
}

function messageContent(message) {
  const msg = message?.message;
  return msg?.ephemeralMessage?.message || msg?.viewOnceMessage?.message || msg || {};
}

function messageType(message) {
  return Object.keys(messageContent(message))[0] || 'unknown';
}

function messageMedia(message) {
  const content = messageContent(message);
  const type = messageType(message);
  const media = content[type];
  if (!media || typeof media !== 'object') return null;

  const mediaType = type.replace(/Message$/, '');
  return {
    mediaType,
    mimetype: media.mimetype,
    fileName: media.fileName,
    fileLength: media.fileLength ? String(media.fileLength) : undefined,
    height: media.height,
    width: media.width,
    seconds: media.seconds,
    isAnimated: Boolean(media.isAnimated),
    isAvatar: Boolean(media.isAvatar),
    stickerPackName: media.stickerPackName,
    stickerPackPublisher: media.stickerPackPublisher,
    emoji: media.emoji,
    url: media.url
  };
}

function messagePreview(message) {
  const text = messageText(message);
  if (text) return text;

  const type = messageType(message);
  const media = messageMedia(message);
  const labels = {
    stickerMessage: media?.emoji ? `Sticker ${media.emoji}` : 'Sticker',
    imageMessage: 'Image',
    videoMessage: 'Video',
    audioMessage: media?.seconds ? `Audio (${media.seconds}s)` : 'Audio',
    documentMessage: media?.fileName ? `Document: ${media.fileName}` : 'Document',
    contactMessage: 'Contact card',
    contactsArrayMessage: 'Contact cards',
    locationMessage: 'Location',
    liveLocationMessage: 'Live location',
    pollCreationMessage: 'Poll',
    reactionMessage: 'Reaction',
    protocolMessage: 'System message'
  };
  return labels[type] || type.replace(/Message$/, '') || 'Message';
}

function previewFromType(type) {
  const labels = {
    stickerMessage: 'Sticker',
    imageMessage: 'Image',
    videoMessage: 'Video',
    audioMessage: 'Audio',
    documentMessage: 'Document',
    contactMessage: 'Contact card',
    contactsArrayMessage: 'Contact cards',
    locationMessage: 'Location',
    liveLocationMessage: 'Live location',
    pollCreationMessage: 'Poll',
    reactionMessage: 'Reaction',
    protocolMessage: 'System message'
  };
  return labels[type] || type?.replace(/Message$/, '') || 'Message';
}

function toPlainMessage(message) {
  const type = messageType(message);
  const media = messageMedia(message);
  return {
    id: message?.key?.id,
    jid: message?.key?.remoteJid,
    fromMe: Boolean(message?.key?.fromMe),
    participant: message?.key?.participant,
    senderPn: message?.key?.senderPn,
    participantPn: message?.key?.participantPn,
    pushName: message?.pushName,
    timestamp: Number(message?.messageTimestamp || 0),
    type,
    text: messageText(message),
    preview: messagePreview(message),
    media,
    key: message?.key
  };
}

function normalizeChat(chat) {
  const jid = chat?.id || chat?.jid;
  const isGroup = jid?.endsWith('@g.us') || false;
  return {
    jid,
    name: chat?.name || chat?.notify || chat?.subject || chat?.verifiedName || chat?.pushName || jid,
    unreadCount: chat?.unreadCount || 0,
    archived: Boolean(chat?.archived),
    pinned: Boolean(chat?.pinned),
    timestamp: Number(chat?.conversationTimestamp || chat?.t || 0),
    isGroup
  };
}

function normalizeContact(contact, jid) {
  const id = contact?.id || jid;
  return {
    jid: id,
    name: contact?.name || contact?.notify || contact?.verifiedName || contact?.pushName || contact?.subject || id,
    shortName: contact?.shortName,
    isBusiness: Boolean(contact?.verifiedName || contact?.bizName)
  };
}

export class WhatsAppService {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.authDir = path.join(dataDir, 'auth');
    this.storePath = path.join(dataDir, 'store.json');
    this.sock = null;
    this.status = 'idle';
    this.lastError = null;
    this.qr = null;
    this.qrDataUrl = null;
    this.me = null;
    this.chats = new Map();
    this.contacts = new Map();
    this.messages = new Map();
    this.jidAliases = new Map();
    this.maxMessagesPerChat = Number(process.env.MAX_MESSAGES_PER_CHAT || 500);
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadStore();
    await this.connect();
  }

  async loadStore() {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.chats = new Map(parsed.chats || []);
      this.contacts = new Map(parsed.contacts || []);
      this.messages = new Map(parsed.messages || []);
      this.jidAliases = new Map(parsed.jidAliases || []);
      const inferred = this.inferJidAliasesFromStore();
      const migrated = this.migrateStoreJids();
      if (inferred || migrated) await this.saveStore();
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = error.message;
    }
  }

  async saveStore() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const payload = {
      chats: [...this.chats.entries()],
      contacts: [...this.contacts.entries()],
      messages: [...this.messages.entries()],
      jidAliases: [...this.jidAliases.entries()]
    };
    await fs.writeFile(this.storePath, JSON.stringify(payload, null, 2));
  }

  canonicalJid(jid) {
    if (!jid) return jid;
    return this.jidAliases.get(jid) || jid;
  }

  canonicalInputJid(jid) {
    return this.canonicalJid(jidFromInput(jid));
  }

  rememberJidAlias(alias, canonical) {
    if (!isLidJid(alias) || !isPhoneJid(canonical) || alias === canonical) return false;
    if (this.jidAliases.get(alias) === canonical) return false;
    this.jidAliases.set(alias, canonical);
    return true;
  }

  rememberMessageAliases(message) {
    let changed = false;
    const key = message?.key || {};
    changed = this.rememberJidAlias(key.remoteJid, key.senderPn) || changed;
    changed = this.rememberJidAlias(key.participant, key.participantPn) || changed;
    return changed;
  }

  plainMessage(message) {
    const plain = toPlainMessage(message);
    return {
      ...plain,
      jid: this.canonicalJid(plain.jid),
      participant: this.canonicalJid(plain.participant)
    };
  }

  inferJidAliasesFromStore() {
    let changed = false;
    for (const list of this.messages.values()) {
      for (const message of list) changed = this.rememberMessageAliases(message) || changed;
    }
    return changed;
  }

  migrateStoreJids() {
    let changed = false;

    const chats = new Map();
    for (const [jid, chat] of this.chats.entries()) {
      const canonical = this.canonicalJid(jid);
      changed = changed || canonical !== jid;
      const current = chats.get(canonical) || {};
      const currentTimestamp = Number(current.timestamp || 0);
      const chatTimestamp = Number(chat.timestamp || 0);
      chats.set(canonical, {
        ...current,
        ...chat,
        jid: canonical,
        name: betterDisplayName(current.name, chat.name, canonical),
        lastMessage: chatTimestamp >= currentTimestamp ? (chat.lastMessage ?? current.lastMessage) : current.lastMessage,
        timestamp: Math.max(currentTimestamp, chatTimestamp),
        isGroup: Boolean(current.isGroup || chat.isGroup || canonical.endsWith('@g.us'))
      });
    }

    const contacts = new Map();
    for (const [jid, contact] of this.contacts.entries()) {
      const canonical = this.canonicalJid(jid);
      changed = changed || canonical !== jid;
      const current = contacts.get(canonical) || {};
      contacts.set(canonical, {
        ...current,
        ...contact,
        jid: canonical,
        name: betterDisplayName(current.name, contact.name, canonical)
      });
    }

    const messages = new Map();
    for (const [jid, list] of this.messages.entries()) {
      const canonical = this.canonicalJid(jid);
      changed = changed || canonical !== jid;
      const merged = messages.get(canonical) || [];
      for (const message of list) {
        const next = {
          ...message,
          jid: canonical,
          participant: this.canonicalJid(message.participant)
        };
        const index = merged.findIndex((item) => item.id === next.id);
        if (index >= 0) merged[index] = { ...merged[index], ...next };
        else merged.push(next);
      }
      merged.sort((a, b) => a.timestamp - b.timestamp);
      messages.set(canonical, merged.slice(-this.maxMessagesPerChat));
    }

    if (changed) {
      this.chats = chats;
      this.contacts = contacts;
      this.messages = messages;
    }

    return changed;
  }

  async connect() {
    if (this.sock) return this.sock;
    this.status = 'connecting';
    this.lastError = null;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS('WhatsApp MCP'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => this.findMessage(key.remoteJid, key.id)
    });

    this.bindEvents(saveCreds);
    return this.sock;
  }

  bindEvents(saveCreds) {
    const ev = this.sock.ev;
    ev.on('creds.update', saveCreds);

    ev.on('connection.update', async (update) => {
      if (update.qr) {
        this.qr = update.qr;
        this.qrDataUrl = await QRCode.toDataURL(update.qr);
        this.status = 'qr';
      }

      if (update.connection === 'open') {
        this.status = 'connected';
        this.qr = null;
        this.qrDataUrl = null;
        this.me = this.sock.user || null;
        this.refreshKnownGroupMetadata().catch((error) => { this.lastError = error.message; });
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        this.status = 'disconnected';
        this.lastError = update.lastDisconnect?.error?.message || null;
        this.sock = null;
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => this.connect().catch((error) => { this.lastError = error.message; }), 2000);
        }
      }
    });

    ev.on('chats.upsert', (chats) => this.upsertChats(chats));
    ev.on('chats.update', (chats) => this.upsertChats(chats));
    ev.on('contacts.upsert', (contacts) => this.upsertContacts(contacts));
    ev.on('contacts.update', (contacts) => this.upsertContacts(contacts));
    ev.on('messages.upsert', ({ messages }) => this.upsertMessages(messages));
    ev.on('messages.update', (updates) => this.mergeMessageUpdates(updates));
    ev.on('groups.update', (groups) => this.upsertChats(groups.map((group) => ({
      id: group.id,
      subject: group.subject,
      name: group.subject
    }))));
  }

  upsertChats(chats = []) {
    for (const chat of chats) {
      const normalized = normalizeChat(chat);
      if (!normalized.jid) continue;
      const rawJid = normalized.jid;
      normalized.jid = this.canonicalJid(rawJid);
      if (normalized.name === rawJid) normalized.name = normalized.jid;
      const current = this.chats.get(normalized.jid) || {};
      this.chats.set(normalized.jid, {
        ...current,
        ...normalized,
        name: betterDisplayName(current.name, normalized.name, normalized.jid)
      });
    }
    this.saveStore().catch(() => {});
  }

  upsertContacts(contacts = []) {
    for (const contact of contacts) {
      const normalized = normalizeContact(contact);
      if (!normalized.jid) continue;
      const rawJid = normalized.jid;
      normalized.jid = this.canonicalJid(rawJid);
      if (normalized.name === rawJid) normalized.name = normalized.jid;
      const current = this.contacts.get(normalized.jid) || {};
      this.contacts.set(normalized.jid, {
        ...current,
        ...normalized,
        name: betterDisplayName(current.name, normalized.name, normalized.jid)
      });
      const chat = this.chats.get(normalized.jid);
      if (chat && (!chat.name || chat.name === normalized.jid)) {
        this.chats.set(normalized.jid, { ...chat, name: normalized.name });
      }
    }
    this.saveStore().catch(() => {});
  }

  upsertMessages(messages = []) {
    for (const message of messages) {
      const aliasChanged = this.rememberMessageAliases(message);
      if (aliasChanged) this.migrateStoreJids();
      const plain = this.plainMessage(message);
      if (!plain.jid || !plain.id) continue;
      const fallbackName = this.resolveChatName(plain.jid, message?.pushName);
      const chat = this.chats.get(plain.jid) || { jid: plain.jid, name: fallbackName, isGroup: plain.jid.endsWith('@g.us') };
      const author = this.resolveParticipantName(plain.participant || plain.jid, plain.pushName);
      const lastMessage = chat.isGroup && !plain.fromMe ? `${author}: ${plain.preview}` : plain.preview;
      this.chats.set(plain.jid, {
        ...chat,
        name: this.resolveChatName(plain.jid, chat.name || fallbackName),
        timestamp: plain.timestamp,
        lastMessage
      });
      const list = this.messages.get(plain.jid) || [];
      const index = list.findIndex((item) => item.id === plain.id);
      if (index >= 0) list[index] = { ...list[index], ...plain };
      else list.push(plain);
      list.sort((a, b) => a.timestamp - b.timestamp);
      this.messages.set(plain.jid, list.slice(-this.maxMessagesPerChat));
    }
    this.saveStore().catch(() => {});
  }

  mergeMessageUpdates(updates = []) {
    for (const update of updates) {
      const jid = this.canonicalJid(update.key?.remoteJid);
      const id = update.key?.id;
      const list = this.messages.get(jid) || [];
      const index = list.findIndex((item) => item.id === id);
      if (index >= 0) list[index] = { ...list[index], update };
    }
    this.saveStore().catch(() => {});
  }

  requireSocket() {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected. Open the UI and scan the QR code first.');
    }
    return this.sock;
  }

  findMessage(jid, id) {
    return (this.messages.get(this.canonicalJid(jid)) || []).find((message) => message.id === id);
  }

  resolveChatName(jid, fallback) {
    const chat = this.chats.get(jid);
    const contact = this.contacts.get(jid);
    const name = chat?.name || contact?.name || fallback;
    if (name && name !== jid) return name;
    if (jid?.endsWith('@s.whatsapp.net')) return `+${jid.split('@')[0]}`;
    if (jid?.endsWith('@lid')) return `WhatsApp user ${jid.split('@')[0].slice(-6)}`;
    return jid;
  }

  resolveParticipantName(jid, fallback) {
    if (!jid) return fallback || 'contact';
    const contact = this.contacts.get(jid);
    const name = contact?.name || fallback;
    if (name && name !== jid) return name;
    if (jid.endsWith('@s.whatsapp.net')) return `+${jid.split('@')[0]}`;
    if (jid.endsWith('@lid')) return `WhatsApp user ${jid.split('@')[0].slice(-6)}`;
    return jid;
  }

  enrichChat(chat) {
    const latest = (this.messages.get(chat.jid) || []).at(-1);
    const latestPreview = latest ? this.enrichMessage(latest).displayText : undefined;
    const lastMessage = latestPreview || previewFromType(chat.lastMessage) || chat.lastMessage;
    return {
      ...chat,
      lastMessage,
      name: this.resolveChatName(chat.jid, chat.name),
      displayName: this.resolveChatName(chat.jid, chat.name)
    };
  }

  enrichMessage(message) {
    const preview = message.preview || (message.text ? message.text : previewFromType(message.type));
    return {
      ...message,
      preview,
      displayText: message.text || preview,
      senderName: message.fromMe ? 'me' : this.resolveParticipantName(message.participant || message.jid, message.pushName)
    };
  }

  async refreshKnownGroupMetadata({ limit = 80 } = {}) {
    const sock = this.requireSocket();
    const groupJids = [...this.chats.keys()].filter((jid) => jid.endsWith('@g.us')).slice(0, limit);
    const refreshed = [];
    for (const jid of groupJids) {
      try {
        const metadata = await sock.groupMetadata(jid);
        const chat = this.chats.get(jid) || { jid, isGroup: true };
        this.chats.set(jid, {
          ...chat,
          name: metadata.subject || chat.name || jid,
          subject: metadata.subject,
          owner: metadata.owner,
          participantsCount: metadata.participants?.length || 0,
          isGroup: true
        });
        refreshed.push({ jid, name: metadata.subject, participantsCount: metadata.participants?.length || 0 });
      } catch (error) {
        refreshed.push({ jid, error: error.message });
      }
    }
    await this.saveStore();
    return refreshed;
  }

  getStatus() {
    return {
      status: this.status,
      me: this.me,
      qrDataUrl: this.qrDataUrl,
      lastError: this.lastError,
      chats: this.chats.size,
      contacts: this.contacts.size
    };
  }

  listChats({ query = '', limit = 50, groupsOnly = false } = {}) {
    const q = query.toLowerCase();
    return [...this.chats.values()]
      .map((chat) => this.enrichChat(chat))
      .filter((chat) => !groupsOnly || chat.isGroup)
      .filter((chat) => !q || `${chat.name} ${chat.displayName} ${chat.jid} ${chat.lastMessage || ''}`.toLowerCase().includes(q))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);
  }

  readMessages({ jid, limit = 50 }) {
    const target = this.canonicalInputJid(jid);
    return (this.messages.get(target) || []).slice(-limit).map((message) => this.enrichMessage(message));
  }

  searchContacts({ query = '', limit = 50 } = {}) {
    const q = query.toLowerCase();
    return [...this.contacts.entries()]
      .map(([jid, contact]) => normalizeContact(contact, jid))
      .filter((contact) => !q || `${contact.name} ${contact.jid}`.toLowerCase().includes(q))
      .slice(0, limit);
  }

  async sendText({ jid, text, quotedMessageId }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    const quoted = quotedMessageId ? this.findMessage(target, quotedMessageId) : undefined;
    const result = await sock.sendMessage(target, { text }, quoted ? { quoted } : undefined);
    this.upsertMessages(result ? [result] : []);
    return this.enrichMessage(this.plainMessage(result));
  }

  async sendMedia({ jid, type, url, caption = '', fileName, mimetype }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    const media = { url };
    const contentByType = {
      image: { image: media, caption },
      video: { video: media, caption },
      audio: { audio: media, mimetype: mimetype || 'audio/mp4' },
      document: { document: media, caption, fileName, mimetype: mimetype || 'application/octet-stream' },
      sticker: { sticker: media }
    };
    if (!contentByType[type]) throw new Error(`Unsupported media type: ${type}`);
    const result = await sock.sendMessage(target, contentByType[type]);
    this.upsertMessages(result ? [result] : []);
    return this.enrichMessage(this.plainMessage(result));
  }

  async markRead({ jid, messageId, participant }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    await sock.readMessages([{ remoteJid: target, id: messageId, participant: this.canonicalJid(participant) }]);
    return { ok: true };
  }

  async react({ jid, messageId, emoji, participant }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    return sock.sendMessage(target, { react: { text: emoji, key: { remoteJid: target, id: messageId, participant: this.canonicalJid(participant) } } });
  }

  async editMessage({ jid, messageId, text }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    return sock.sendMessage(target, { text, edit: { remoteJid: target, id: messageId, fromMe: true } });
  }

  async deleteMessage({ jid, messageId, fromMe = true, participant }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    return sock.sendMessage(target, { delete: { remoteJid: target, id: messageId, fromMe, participant: this.canonicalJid(participant) } });
  }

  async checkPhones({ phones }) {
    const sock = this.requireSocket();
    const jids = phones.map((phone) => this.canonicalInputJid(phone));
    return sock.onWhatsApp(...jids);
  }

  async profilePicture({ jid }) {
    const sock = this.requireSocket();
    const target = this.canonicalInputJid(jid);
    return { jid: target, url: await sock.profilePictureUrl(target, 'image') };
  }

  async groupMetadata({ jid }) {
    const sock = this.requireSocket();
    return sock.groupMetadata(this.canonicalInputJid(jid));
  }

  async createGroup({ subject, participants }) {
    const sock = this.requireSocket();
    return sock.groupCreate(subject, participants.map((participant) => this.canonicalInputJid(participant)));
  }

  async updateGroupParticipants({ jid, participants, action }) {
    const sock = this.requireSocket();
    return sock.groupParticipantsUpdate(this.canonicalInputJid(jid), participants.map((participant) => this.canonicalInputJid(participant)), action);
  }

  async setPresence({ jid, presence }) {
    const sock = this.requireSocket();
    await sock.sendPresenceUpdate(presence, jid ? this.canonicalInputJid(jid) : undefined);
    return { ok: true };
  }

  async logout() {
    if (this.sock) await this.sock.logout();
    await fs.rm(this.authDir, { recursive: true, force: true });
    this.sock = null;
    this.status = 'idle';
    this.me = null;
    this.qr = null;
    this.qrDataUrl = null;
    await this.connect();
    return this.getStatus();
  }
}

export { jidFromInput };
