# WhatsApp MCP

Node.js MCP server with a Baileys WhatsApp connection and a local web UI for QR login.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3030`, scan the QR code with WhatsApp, then connect your MCP client either through:

- stdio: `node /absolute/path/to/src/index.js`
- streamable HTTP: `http://localhost:3030/mcp`

Set `MCP_STDIO=false` when you only want the web UI and HTTP MCP endpoint.

## Data

Local WhatsApp auth and cached chat data are stored in `data/`. Do not commit that folder.

## MCP Tools

- `whatsapp_status`
- `whatsapp_list_chats`
- `whatsapp_read_messages`
- `whatsapp_search_contacts`
- `whatsapp_check_phones`
- `whatsapp_send_text`
- `whatsapp_send_media`
- `whatsapp_mark_read`
- `whatsapp_react_message`
- `whatsapp_edit_message`
- `whatsapp_delete_message`
- `whatsapp_profile_picture`
- `whatsapp_list_groups`
- `whatsapp_refresh_group_names`
- `whatsapp_group_metadata`
- `whatsapp_create_group`
- `whatsapp_update_group_participants`
- `whatsapp_set_presence`
- `whatsapp_logout`

Baileys uses an unofficial WhatsApp Web protocol. Use a dedicated account and respect WhatsApp limits and terms.
