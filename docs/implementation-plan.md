# Sonic Studio Implementation Plan

**Goal:** Implementar a interface aprovada, persistência JSON e conversa Sonic local.
**Architecture:** HTTP Express para configurações e arquivos estáticos; WebSocket para áudio; SDK AWS apenas no servidor.
**Tech Stack:** Node.js 24, Express, ws, AWS SDK v3, HTML/CSS/JS, node:test.
**Spec:** docs/design.md

## Global Constraints
Loopback; perfil AWS do .env; imagens até 5 MB; nenhum segredo no JSON; seleção explícita de modelo.

## Review Focus
JSON malformado; imagem falsa; identificadores com path traversal; desconexão durante stream; microfone negado.

### 1. Configurações
- [x] Testar round trip no disco, IDs inválidos, imagem/limites, preservação e atualização.
- [x] Executar testes e confirmar ausência da implementação.
- [x] Implementar src/config.js e src/store.js com validação e gravação atômica.
- [x] Executar testes.

### 2. Protocolo e servidor
- [x] Testar eventos de sessão, áudio/encerramento e roteamento de respostas/interrupção.
- [x] Implementar src/sonic.js, src/app.js e src/server.js.
- [x] Exercitar API real com diretório temporário e conexão WebSocket sem chamada AWS.

### 3. Interface
- [x] Implementar public/index.html, styles.css, app.js, audio.js e capture-worklet.js.
- [x] Exercitar salvar/carregar/exportar via DOM e validação de importação no servidor; conferir sintaxe JS.
- [x] Documentar execução, AWS/IAM, formato JSON e limites de validação.

## Ledger
Execução local, sem Git (diretório não é repositório). Implementação local e revisão final por agente, conforme requesting-code-review.
14 testes passaram; npm run check passou. Sem navegador conectado para validação visual e sem perfil AWS disponível para conversa real.
O teste DOM detectou incompatibilidade entre min/step do campo Top P e o valor inicial; corrigido e retestado.
Revisão detectou que uma resposta atrasada de salvamento poderia sobrescrever novas edições. Teste reproduziu a perda; controle de revisões preserva as edições e a configuração selecionada.

## Ajuste: AWS no .env
Perfil e região agora são lidos exclusivamente do .env na raiz por src/aws-settings.js. Tela mostra esses valores apenas para consulta; JSON mantém somente modelId em connection. JSONs legados são normalizados ao carregar/importar/salvar. Consulta de modelos e sessões usam os valores do servidor, com testes de tentativas de sobrescrita pelo cliente.
17 testes e verificação de sintaxe passaram. Servidor reiniciado com leitura do perfil local permitida.
