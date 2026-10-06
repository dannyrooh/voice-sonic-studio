import { createApplication } from './app.js';
import { getAwsSettings } from './aws-settings.js';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
const awsSettings = getAwsSettings();
const { server, wss } = createApplication({ awsSettings });
server.listen(port, '127.0.0.1', () => console.log(`Sonic Studio: http://localhost:${port}\nPerfil AWS: ${awsSettings.awsProfile} · Região: ${awsSettings.region} (.env)`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Porta ${port} ocupada. Defina outra PORT no .env.` : error.message); process.exitCode = 1; });
function shutdown() {
  for (const ws of wss.clients) ws.close(1001, 'Servidor encerrando');
  server.close();
  setTimeout(() => { for (const ws of wss.clients) ws.terminate(); server.closeAllConnections(); }, 1500).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
