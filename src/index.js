import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, normalizeSendTextArgs } from './mcp.js';
import { WhatsAppService } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3030);
const whatsapp = new WhatsAppService({ dataDir: path.join(rootDir, 'data') });

await whatsapp.init();

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(rootDir, 'public')));

app.get('/api/status', (_req, res) => res.json(whatsapp.getStatus()));
app.post('/api/connect', async (_req, res, next) => {
  try {
    await whatsapp.connect();
    res.json(whatsapp.getStatus());
  } catch (error) {
    next(error);
  }
});
app.post('/api/logout', async (_req, res, next) => {
  try {
    res.json(await whatsapp.logout());
  } catch (error) {
    next(error);
  }
});
app.get('/api/chats', (req, res) => res.json(whatsapp.listChats({
  query: req.query.q || '',
  limit: Number(req.query.limit || 80),
  groupsOnly: req.query.groupsOnly === 'true'
})));
app.post('/api/chats/refresh-groups', async (req, res, next) => {
  try {
    res.json(await whatsapp.refreshKnownGroupMetadata({ limit: Number(req.body?.limit || 80) }));
  } catch (error) {
    next(error);
  }
});
app.get('/api/chats/:jid/messages', (req, res) => res.json(whatsapp.readMessages({
  jid: decodeURIComponent(req.params.jid),
  limit: Number(req.query.limit || 80)
})));
app.get('/api/contacts', (req, res) => res.json(whatsapp.searchContacts({
  query: req.query.q || '',
  limit: Number(req.query.limit || 100)
})));
app.post('/api/send', async (req, res, next) => {
  try {
    res.json(await whatsapp.sendText(req.body));
  } catch (error) {
    next(error);
  }
});

const directMcpSendMethods = new Set(['send', 'message', 'whatsapp_send_text']);

async function handleDirectMcpMethod(req, res) {
  const body = req.body;
  if (!body || !directMcpSendMethods.has(body.method)) return false;

  try {
    const params = body.params?.arguments || body.params || {};
    const result = await whatsapp.sendText(normalizeSendTextArgs(params));
    res.json({ jsonrpc: '2.0', result, id: body.id ?? null });
  } catch (error) {
    res.json({
      jsonrpc: '2.0',
      error: { code: -32602, message: error.message },
      id: body.id ?? null
    });
  }

  return true;
}

app.post('/mcp', async (req, res) => {
  if (await handleDirectMcpMethod(req, res)) return;

  const server = createMcpServer(whatsapp);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    }
  }
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST /mcp for streamable HTTP MCP.' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'DELETE is not supported in stateless mode.' }));

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message });
});

app.listen(port, () => {
  console.error(`WhatsApp UI: http://localhost:${port}`);
  console.error(`MCP HTTP: http://localhost:${port}/mcp`);
});

if (process.env.MCP_STDIO !== 'false') {
  const mcpServer = createMcpServer(whatsapp);
  await mcpServer.connect(new StdioServerTransport());
}
