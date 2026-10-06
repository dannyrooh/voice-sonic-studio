import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { fromIni } from '@aws-sdk/credential-providers';
import { ConfigStore } from './store.js';
import { defaults, validateConfig, ValidationError, VOICES, POLLY_VOICES } from './config.js';
import { SonicSession } from './sonic.js';
import { getAwsSettings } from './aws-settings.js';

function localRequest(req) {
  const host = req.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  return true;
}
export async function listModels(connection) {
  const client = new BedrockClient({ region: connection.region, credentials: fromIni({ profile: connection.awsProfile }), maxAttempts: 1 });
  try {
    const result = await client.send(new ListFoundationModelsCommand({}), { abortSignal: AbortSignal.timeout(15000) });
    return (result.modelSummaries || []).filter(m => /sonic/i.test(m.modelId)).map(m => ({ id: m.modelId, name: m.modelName }));
  } finally { client.destroy(); }
}
export function createApplication({ dataDir = fileURLToPath(new URL('../data/configs/', import.meta.url)), awsSettings = getAwsSettings(), sessionFactory = (c, send, aws) => new SonicSession(c, send, aws), modelsProvider = listModels } = {}) {
  const app = express(); const store = new ConfigStore(dataDir);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!localRequest(req)) return res.status(403).json({ error: 'Acesso permitido somente pela aplicação local.' });
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.get('/api/bootstrap', (req, res) => res.json({ defaults: defaults(), voices: VOICES, pollyVoices: POLLY_VOICES, aws: awsSettings }));
  app.get('/api/configs', async (req, res) => res.json(await store.list()));
  app.get('/api/configs/:id', async (req, res) => res.json(await store.get(req.params.id)));
  app.post('/api/configs', async (req, res) => res.status(201).json(await store.save(req.body)));
  app.put('/api/configs/:id', async (req, res) => res.json(await store.save(req.body, req.params.id)));
  app.post('/api/validate', (req, res) => res.json(validateConfig(req.body)));
  app.post('/api/models', async (req, res) => {
    validateConfig(req.body);
    try { res.json({ models: await modelsProvider(awsSettings) }); }
    catch (error) { res.status(502).json({ error: `Não foi possível consultar o Bedrock com o perfil ${awsSettings.awsProfile}: ${error.message}` }); }
  });
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof ValidationError || error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : error.code === 'ENOENT' ? 404 : 500;
    const message = status === 400 ? (error.type === 'entity.parse.failed' ? 'JSON inválido.' : error.message)
      : status === 413 ? 'Arquivo muito grande. Imagens devem ter até 5 MB.' : status === 404 ? 'Configuração não encontrada.' : 'Não foi possível ler ou salvar as configurações.';
    if (status === 500) console.error('Falha de armazenamento:', error.message);
    res.status(status).json({ error: message });
  });
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!localRequest(req) || req.url !== '/ws' || !req.headers.origin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    let session = null; let stopping = false;
    const send = message => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Reprodução de áudio muito lenta'); return; }
      ws.send(JSON.stringify(message));
    };
    const fail = error => { send({ type: 'error', message: error.message }); session?.abort(); ws.close(1011, 'Sessão encerrada'); };
    const timeout = setTimeout(() => { send({ type: 'ended', message: 'Limite de 8 minutos atingido. Inicie outra conversa.' }); session?.stop(); ws.close(); }, 8 * 60 * 1000); timeout.unref();
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) { if (!session || stopping) return; session.audio(Buffer.from(data)); return; }
        if (data.length > 8 * 1024 * 1024) throw new ValidationError('Configuração muito grande.');
        const message = JSON.parse(data.toString());
        if (message.type === 'start') {
          if (session) throw new ValidationError('Uma sessão já está em andamento.');
          const config = validateConfig(message.config, { requireModel: true });
          // A imagem pertence apenas à interface e nunca é enviada ao Bedrock.
          config.character.avatar = null;
          session = sessionFactory(config, send, awsSettings);
          Promise.resolve(session.start()).then(() => {
            session?.abort(); if (ws.readyState === WebSocket.OPEN) { send({ type: 'ended' }); ws.close(); }
          }).catch(error => { if (!stopping && ws.readyState === WebSocket.OPEN) fail(error); });
        } else if (message.type === 'stop') { stopping = true; session?.stop(); }
        else throw new ValidationError('Mensagem de sessão inválida.');
      } catch (error) { fail(error instanceof SyntaxError ? new ValidationError('Mensagem JSON inválida.') : error); }
    });
    ws.on('close', () => { clearTimeout(timeout); session?.abort(); });
    ws.on('error', () => session?.abort());
  });
  return { app, server, wss };
}
