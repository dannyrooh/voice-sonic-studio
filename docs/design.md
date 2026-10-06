# Sonic Studio

Aplicação local para configurar personagens e conversar com Amazon Nova Sonic.
O mockup apresentado é a referência visual; a solicitação de criar o código autoriza sua implementação.

## Escopo
- Servidor Node.js, interface web em português, acesso apenas em loopback.
- Imagem PNG/JPEG/WebP de até 5 MB embutida no JSON; nunca enviada ao modelo.
- Salvar, carregar, atualizar, importar e exportar configurações em JSON no disco.
- Perfil AWS e região no .env da raiz, sem credenciais no navegador ou JSON; valores antigos no JSON são ignorados.
- ModelId, voiceId, idioma, prompt, turn detection e parâmetros de inferência editáveis na tela.
- Microfone PCM mono 16 kHz via AudioWorklet; reprodução PCM 24 kHz; transcrição e interrupções.
- Erros visíveis, encerramento libera microfone, stream e cliente AWS.

Não inclui deploy, autenticação remota, outros provedores ou animação facial.
ModelId deve ser explicitamente escolhido. O modelo documentado Nova 2 é oferecido como opção identificada; Nova 2.5 exige identificador confirmado pelo usuário/conta.

## Aceitação
Persistência sobrevive reinício; JSON preserva imagem e parâmetros; dados inválidos não são gravados; nomes não definem caminhos; gravações são atômicas.
Sessão usa a configuração atual, transmite áudio, reproduz resposta e exibe transcrição. Sem perfil válido a interface de configurações continua disponível.

## Validação
Testes Node para armazenamento real, validação, protocolo Sonic e HTTP/WebSocket com transporte AWS substituído somente na fronteira externa. Verificação de interface em navegador se disponível. Conversa AWS depende de perfil, permissões e modelo disponível.
