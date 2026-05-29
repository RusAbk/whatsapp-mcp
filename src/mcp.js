import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function text(data) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
  };
}

export function normalizeSendTextArgs(args = {}) {
  const jid = args.jid || args.to || args.phone || args.recipient;
  const textValue = args.text || args.message || args.content || args.body;
  if (!jid) throw new Error('jid, to, phone or recipient is required');
  if (!textValue) throw new Error('text, message, content or body is required');
  return {
    jid,
    text: textValue,
    quotedMessageId: args.quotedMessageId
  };
}

function tool(server, name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return text(await handler(args));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}

export function createMcpServer(whatsapp) {
  const server = new McpServer({ name: 'whatsapp-baileys-mcp', version: '0.1.0' });
  const sendTextInput = {
    jid: z.string(),
    text: z.string(),
    quotedMessageId: z.string().optional()
  };
  const sendTextAliasInput = {
    jid: z.string().optional(),
    to: z.string().optional(),
    phone: z.string().optional(),
    recipient: z.string().optional(),
    text: z.string().optional(),
    message: z.string().optional(),
    content: z.string().optional(),
    body: z.string().optional(),
    quotedMessageId: z.string().optional()
  };

  tool(server, 'whatsapp_status', 'Return WhatsApp connection, QR and cache status.', {}, () => whatsapp.getStatus());
  tool(server, 'whatsapp_list_chats', 'List cached WhatsApp chats.', {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    groupsOnly: z.boolean().optional()
  }, (args) => whatsapp.listChats(args));
  tool(server, 'whatsapp_read_messages', 'Read cached messages from a chat or group.', {
    jid: z.string(),
    limit: z.number().int().min(1).max(500).optional()
  }, (args) => whatsapp.readMessages(args));
  tool(server, 'whatsapp_search_contacts', 'Search cached contacts by name or jid.', {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional()
  }, (args) => whatsapp.searchContacts(args));
  tool(server, 'whatsapp_check_phones', 'Check which phone numbers are registered on WhatsApp.', {
    phones: z.array(z.string()).min(1).max(50)
  }, (args) => whatsapp.checkPhones(args));
  tool(server, 'whatsapp_send_text', 'Send a text message to a chat, phone number or group jid.', sendTextInput, (args) => whatsapp.sendText(args));
  tool(server, 'send', 'Alias for whatsapp_send_text. Accepts jid/to/phone/recipient and text/message/content/body.', sendTextAliasInput, (args) => whatsapp.sendText(normalizeSendTextArgs(args)));
  tool(server, 'message', 'Alias for whatsapp_send_text. Accepts jid/to/phone/recipient and text/message/content/body.', sendTextAliasInput, (args) => whatsapp.sendText(normalizeSendTextArgs(args)));
  tool(server, 'whatsapp_send_media', 'Send image, video, audio, document or sticker by local path/URL.', {
    jid: z.string(),
    type: z.enum(['image', 'video', 'audio', 'document', 'sticker']),
    url: z.string(),
    caption: z.string().optional(),
    fileName: z.string().optional(),
    mimetype: z.string().optional()
  }, (args) => whatsapp.sendMedia(args));
  tool(server, 'whatsapp_mark_read', 'Mark a message as read.', {
    jid: z.string(),
    messageId: z.string(),
    participant: z.string().optional()
  }, (args) => whatsapp.markRead(args));
  tool(server, 'whatsapp_react_message', 'React to a message with an emoji. Empty emoji removes reaction.', {
    jid: z.string(),
    messageId: z.string(),
    emoji: z.string(),
    participant: z.string().optional()
  }, (args) => whatsapp.react(args));
  tool(server, 'whatsapp_edit_message', 'Edit a sent text message.', {
    jid: z.string(),
    messageId: z.string(),
    text: z.string()
  }, (args) => whatsapp.editMessage(args));
  tool(server, 'whatsapp_delete_message', 'Delete a message by id.', {
    jid: z.string(),
    messageId: z.string(),
    fromMe: z.boolean().optional(),
    participant: z.string().optional()
  }, (args) => whatsapp.deleteMessage(args));
  tool(server, 'whatsapp_profile_picture', 'Get profile picture URL for a user or group.', {
    jid: z.string()
  }, (args) => whatsapp.profilePicture(args));
  tool(server, 'whatsapp_list_groups', 'List cached group chats.', {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional()
  }, (args) => whatsapp.listChats({ ...args, groupsOnly: true }));
  tool(server, 'whatsapp_refresh_group_names', 'Refresh cached group names and participant counts from WhatsApp.', {
    limit: z.number().int().min(1).max(200).optional()
  }, (args) => whatsapp.refreshKnownGroupMetadata(args));
  tool(server, 'whatsapp_group_metadata', 'Read group metadata and participants.', {
    jid: z.string()
  }, (args) => whatsapp.groupMetadata(args));
  tool(server, 'whatsapp_create_group', 'Create a WhatsApp group.', {
    subject: z.string(),
    participants: z.array(z.string()).min(1)
  }, (args) => whatsapp.createGroup(args));
  tool(server, 'whatsapp_update_group_participants', 'Add, remove, promote or demote group participants.', {
    jid: z.string(),
    participants: z.array(z.string()).min(1),
    action: z.enum(['add', 'remove', 'promote', 'demote'])
  }, (args) => whatsapp.updateGroupParticipants(args));
  tool(server, 'whatsapp_set_presence', 'Set typing/recording/available/unavailable presence.', {
    jid: z.string().optional(),
    presence: z.enum(['available', 'unavailable', 'composing', 'recording', 'paused'])
  }, (args) => whatsapp.setPresence(args));
  tool(server, 'whatsapp_logout', 'Logout and reset the local WhatsApp session.', {}, () => whatsapp.logout());

  return server;
}
