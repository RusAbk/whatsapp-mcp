let selectedJid = null;
let chats = [];

const el = {
  status: document.querySelector('#status'),
  account: document.querySelector('#account'),
  qrPanel: document.querySelector('#qrPanel'),
  qr: document.querySelector('#qr'),
  refresh: document.querySelector('#refresh'),
  refreshNames: document.querySelector('#refreshNames'),
  logout: document.querySelector('#logout'),
  search: document.querySelector('#search'),
  chats: document.querySelector('#chats'),
  chatName: document.querySelector('#chatName'),
  chatJid: document.querySelector('#chatJid'),
  messages: document.querySelector('#messages'),
  composer: document.querySelector('#composer'),
  messageInput: document.querySelector('#messageInput')
};

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function renderStatus(status) {
  el.status.textContent = status.status;
  el.account.textContent = status.me?.name || status.me?.id || status.lastError || 'Not connected';
  el.qrPanel.classList.toggle('hidden', !status.qrDataUrl);
  if (status.qrDataUrl) el.qr.src = status.qrDataUrl;
}

function renderChats() {
  el.chats.innerHTML = '';
  for (const chat of chats) {
    const button = document.createElement('button');
    button.className = `chat-item${chat.jid === selectedJid ? ' active' : ''}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector('strong').textContent = chat.displayName || chat.name || chat.jid;
    button.querySelector('span').textContent = chat.lastMessage || chat.jid;
    button.title = `${chat.displayName || chat.name || chat.jid}\n${chat.jid}`;
    button.addEventListener('click', () => selectChat(chat));
    el.chats.append(button);
  }
}

function mediaDetails(media) {
  if (!media) return '';
  const parts = [
    media.emoji,
    media.stickerPackName,
    media.fileName,
    media.mimetype,
    media.seconds ? `${media.seconds}s` : '',
    media.width && media.height ? `${media.width}x${media.height}` : ''
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderMessages(messages) {
  el.messages.innerHTML = '';
  for (const message of messages) {
    const item = document.createElement('div');
    item.className = `message${message.fromMe ? ' mine' : ''}${message.media ? ' media' : ''}`;

    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = message.displayText || message.text || message.preview || `[${message.type}]`;
    item.append(body);

    if (message.media) {
      const media = document.createElement('div');
      media.className = 'message-media';
      media.textContent = mediaDetails(message.media) || message.media.mediaType || message.type;
      item.append(media);
    }

    const meta = document.createElement('small');
    meta.textContent = `${message.senderName || (message.fromMe ? 'me' : message.pushName || message.participant || 'contact')} · ${message.id || ''}`;
    item.append(meta);
    el.messages.append(item);
  }
  el.messages.scrollTop = el.messages.scrollHeight;
}

async function loadStatus() {
  renderStatus(await api('/api/status'));
}

async function loadChats() {
  const q = encodeURIComponent(el.search.value.trim());
  chats = await api(`/api/chats?q=${q}&limit=100`);
  renderChats();
}

async function selectChat(chat) {
  selectedJid = chat.jid;
  el.chatName.textContent = chat.displayName || chat.name || chat.jid;
  el.chatJid.textContent = chat.jid;
  renderChats();
  renderMessages(await api(`/api/chats/${encodeURIComponent(chat.jid)}/messages?limit=120`));
}

el.search.addEventListener('input', () => loadChats().catch(alert));
el.refresh.addEventListener('click', () => api('/api/connect', { method: 'POST' }).then(loadStatus).catch(alert));
el.refreshNames.addEventListener('click', () => api('/api/chats/refresh-groups', { method: 'POST', body: { limit: 120 } }).then(loadChats).catch(alert));
el.logout.addEventListener('click', () => api('/api/logout', { method: 'POST' }).then(loadStatus).catch(alert));
el.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = el.messageInput.value.trim();
  if (!selectedJid || !text) return;
  await api('/api/send', { method: 'POST', body: { jid: selectedJid, text } });
  el.messageInput.value = '';
  const chat = chats.find((item) => item.jid === selectedJid);
  if (chat) await selectChat(chat);
});

async function tick() {
  await Promise.all([loadStatus(), loadChats()]);
  if (selectedJid) {
    const chat = chats.find((item) => item.jid === selectedJid);
    if (chat) await selectChat(chat);
  }
}

tick().catch(alert);
setInterval(() => tick().catch(() => {}), 5000);
