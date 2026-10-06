# Sonic Studio

POC local de conversa com Amazon Nova Sonic no Bedrock. Interface em português baseada no mockup, com imagem do personagem, parâmetros de voz, biblioteca de configurações JSON e microfone em tempo real.

## Executar no Windows

Requer Node.js 22 ou mais recente e navegador moderno com AudioWorklet (Chrome/Edge recomendado).

```powershell
cd C:\workspace-dannytooh\nova-sonic
npm ci
# Apenas se o .env ainda não existir:
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm start
```

Abra **http://localhost:3000**. A aplicação escuta somente em `127.0.0.1`. Para mudar a porta, defina `PORT` no `.env`. Não precisa de build ou banco de dados.

## Configurar a AWS

Perfil e região são lidos exclusivamente do **`.env` na raiz**:

```dotenv
AWS_PROFILE=<seu_profile>
AWS_REGION=us-east-1
PORT=3000
SONIC_MODEL_ID=amazon.nova-2-5-sonic
```

Reinicie o servidor após alterar esse arquivo. Perfil e região aparecem na tela apenas para consulta e não fazem parte das configurações JSON. Valores desses campos em arquivos antigos são ignorados ao carregar/importar, e retirados ao salvar/exportar novamente.

Configure o perfil usando o método de autenticação da sua organização, por exemplo:

```powershell
aws configure sso --profile <seu_profile>
aws sso login --profile <seu_profile>
aws sts get-caller-identity --profile <seu_profile>
```

Se a conta usa credenciais em arquivo em vez de SSO, use `aws configure --profile <seu_profile>`.
O SDK usa o perfil nomeado através de `fromIni`, incluindo a cadeia de perfis suportada pelo SDK. As credenciais permanecem no servidor e não são exportadas no JSON.

Na tela, configure o **identificador do modelo**. O botão **Consultar modelos da conta** usa perfil e região do `.env` para listar modelos Sonic via Bedrock; a listagem não confirma acesso de invocação. Para iniciar a conversa, o perfil precisa das permissões de invocação e do acesso ao modelo na região.

Exemplo de política para o modelo documentado Nova 2 Sonic em `us-east-1` (ajuste o ARN para o modelo efetivamente escolhido):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-sonic-v1:0"
    },
    {
      "Effect": "Allow",
      "Action": "bedrock:ListFoundationModels",
      "Resource": "*"
    }
  ]
}
```

### Nova 2 versus Nova 2.5

O projeto implementa o protocolo bidirecional documentado para Nova 2 Sonic, com `modelId` editável. `amazon.nova-2-sonic-v1:0` aparece na tela como opção explicitamente identificada. Nenhum modelo é escolhido ou substituído automaticamente.

Para **Nova 2.5 Sonic**, a consulta real na conta confirmou `amazon.nova-2-5-sonic` em `us-east-1`. Ele foi definido em `SONIC_MODEL_ID` no `.env`, tornando-se o valor inicial das novas configurações. A compatibilidade do protocolo e das vozes com 2.5 precisa ser validada com uma conversa real.

## Usar

1. Escolha uma imagem PNG, JPG ou WebP de até 5 MB e dê nome ao personagem.
2. Configure voz, idioma, instruções, espera entre turnos e parâmetros de geração.
3. Informe o modelo compatível com a região do `.env`. `carolina`, `leo`, `tiffany` e `matthew` são sugestões documentadas para Nova 2; também é possível digitar outro `voiceId` suportado.
4. **Salvar configuração** cria um JSON ou atualiza a configuração carregada. **Salvar como nova** cria outra configuração.
5. Use a biblioteca para carregar configurações; **Exportar JSON** inclui a imagem. **Importar configuração JSON** abre uma configuração para edição e posterior salvamento.
6. Clique **Iniciar conversa**, permita o microfone e fale. Use fones. **Encerrar conversa** libera o microfone e os recursos da sessão.

A imagem é usada apenas na interface e fica embutida em base64 no JSON. Não é enviada ao Bedrock nem usada para clonagem de voz. O tom e a personalidade são orientados pelo prompt; não existem controles artificiais de pitch ou velocidade.

Alterações feitas durante uma conversa entram em vigor na próxima sessão. Desativar interrupções silencia o áudio enviado pelo microfone durante a reprodução da resposta; esse controle é implementado no cliente, não como parâmetro inventado da API.

### Latência

Durante a conversa, a tela mostra duas medidas por turno (última, p50, p95 e quantidade), zeradas a cada nova conversa:

- **Latência percebida**: medida no navegador, do último trecho de 32 ms com voz no microfone (RMS ≥ 0,02) até o início da reprodução da resposta. Inclui espera de fim de turno, rede, modelo e buffer de reprodução. A resolução é de ~32 ms. Ruído de fundo forte ou eco sem fones antecipam o "fim da fala" e reduzem o valor medido.
- **Latência do modelo**: medida no servidor, do fim do bloco de transcrição do usuário (turno detectado pelo Sonic) até o primeiro `audioOutput`. Exclui a espera de fim de turno e a rede até o navegador.

A diferença entre as duas indica quanto do tempo vem do endpointing (`Espera entre turnos`) e do transporte.

## Arquivos e dados

- `src/config.js`: defaults e validação do formato.
- `src/store.js`: persistência em `data/configs/<uuid>.json`, escrita temporária seguida de rename.
- `src/sonic.js`: protocolo, fila limitada, integração AWS e roteamento de áudio/transcrições.
- `src/app.js`: HTTP e WebSocket, validação de acesso local.
- `public/`: interface, AudioWorklet, reamostragem PCM, reprodução e métricas de latência (`metrics.js`).
- `output/sonic-studio.html`: mockup original, preservado.

`schemaVersion: 1` identifica o formato. Os grupos `character`, `connection` e `conversation` contêm a imagem/identidade, modelo e parâmetros de voz respectivamente. Um arquivo salvo recebe `id`, `createdAt` e `updatedAt`. Perfil e região pertencem apenas ao `.env`.

As configurações ficam no disco e sobrevivem ao reinício. Transcrições ficam apenas na memória da página (até 100 blocos); áudio não é gravado. Sessões têm limite de oito minutos e filas limitadas para não acumular áudio indefinidamente.

## Validar

```powershell
npm test
npm run check
```

Os testes exercitam armazenamento real em diretórios temporários, formato de imagens, entradas inválidas, HTTP, WebSocket, eventos Sonic, reamostragem PCM e fluxos da interface via DOM. Não invocam modelos pagos.

Autenticação do perfil `<seu_profile>` e listagem de modelos Bedrock foram validadas. O servidor precisa de acesso aos arquivos AWS locais do usuário; em um sandbox que bloqueie esse acesso, execute `npm start` em seu terminal local. Uma conversa completa na AWS ainda não foi validada. A conferência visual em navegador também não foi possível por não haver navegador conectado; o teste DOM não substitui a avaliação visual e o teste do microfone real.

## Referências

- [Protocolo de entrada Sonic 2](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-input-events.html)
- [Eventos de saída e transcrições](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-output-events.html)
- [API bidirecional com SDK JavaScript](https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html)
- [Controle de turnos](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-turn-taking.html)
