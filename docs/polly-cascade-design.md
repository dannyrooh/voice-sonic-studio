# Arquitetura Transcribe + Bedrock + Polly

Segunda arquitetura da comparação descrita em `goal.md`. A conversa usa o mesmo personagem, as mesmas instruções e as mesmas métricas do Nova Sonic. Muda o caminho da voz: em vez de um modelo único que ouve e fala (Sonic), três serviços em cascata.

```
microfone 16 kHz ──► Transcribe Streaming (pt-BR) ──► detecção de fim de turno (servidor)
                                                              │
                         Bedrock ConverseStream (texto) ◄─────┘
                                    │ frases
                                    ▼
                Polly StartSpeechSynthesisStream (generativo, PCM 16 kHz) ──► navegador
```

## Fatos verificados na conta (perfil do `.env`, us-east-1, 2026-10-06)

| Item | Resultado |
|---|---|
| Vozes generativas pt-BR (`describe-voices`) | Só **Camila**. Nenhuma pt-PT. |
| `StartSpeechSynthesisStream` com Camila, PCM 16 kHz | Funciona. Primeiro áudio em **805 ms** (inclui conexão), 44 chunks, nenhum com tamanho ímpar. |
| Mesmo stream com `SampleRate: '24000'` | `ValidationException: Invalid SampleRate parameter`. PCM só aceita 8000 ou 16000. |
| Transcribe Streaming pt-BR, áudio do Polly em tempo real | Transcrição correta. Resultado **final** chega **1557 ms** após o fim da fala. |
| ConverseStream, tempo até o primeiro token | Nova Micro 745 ms; Nova 2 Lite 962 ms; Claude Haiku 4.5 1210 ms. |
| Claude Haiku 4.5 com `temperature` e `topP` juntos | `ValidationException`: o modelo aceita só um dos dois. |
| Inference profiles disponíveis | `us.amazon.nova-micro-v1:0`, `us.amazon.nova-lite-v1:0`, `us.amazon.nova-2-lite-v1:0`, `us.anthropic.claude-haiku-4-5-20251001-v1:0` e outros. |
| SDK JavaScript | `@aws-sdk/client-polly` e `@aws-sdk/client-transcribe-streaming` 3.1146.0, mesma versão do `client-bedrock-runtime` já instalado. |

## Decisões

1. **Fim de turno no servidor, não no Transcribe.** Esperar o resultado final custaria ~1,5 s por turno. O servidor mede o volume de cada chunk recebido (o mesmo `voiceLevel` do navegador) e encerra o turno quando há silêncio por um tempo derivado de "Espera entre turnos" (Rápida 400 ms, Equilibrada 700 ms, Paciente 1100 ms) **e** o texto parcial está estável há 250 ms. Valores iniciais, a calibrar com uso real.
2. **Resultados atrasados de uma fala já respondida são ignorados** pelo `ResultId` do Transcribe: resultados com o mesmo número de palavras ou menos não contam, e palavras extras no fim do mesmo `ResultId` viram continuação (fala nova). Sem isso, o final que chega 1,5 s depois interromperia a própria resposta.
3. **Polly aberto em paralelo com o LLM.** A conexão do Polly é aberta no início do turno, junto com a chamada ao Bedrock, para o handshake não somar à latência. O texto do LLM é agrupado em frases (pontuação + espaço, mínimo 12 caracteres) e cada frase vai ao Polly com `FlushStreamConfiguration.Force`.
4. **Áudio de saída em PCM 16 kHz.** O navegador já reproduz qualquer taxa (`play(audio, sampleRate)`); nada muda no cliente de áudio.
5. **Interrupção.** Com "Permitir interromper" ligado, uma fala nova (resultado do Transcribe com `ResultId` novo) durante a geração ou enquanto o áudio enviado ainda deve estar tocando cancela LLM e Polly e envia `interrupted`, o mesmo evento que o Sonic usa. Desligado, o navegador já envia silêncio durante a reprodução.
6. **Histórico.** Mensagens no formato do Converse, no máximo 20, sempre começando por `user`. Falas seguidas do mesmo papel são unidas para manter a alternância exigida pela API. Respostas interrompidas entram com o texto já gerado.
7. **Instruções.** Mesmo texto do Sonic (`Seu nome é…`, idioma, prompt), mais uma regra de saída falada: frases curtas, sem markdown, listas, emojis ou URLs.
8. **Parâmetros.** `temperature`, `topP` e `maxTokens` da tela. Para modelos Anthropic, `topP` é omitido.
9. **Configuração.** Novo campo `pipeline` (`sonic` ou `polly`) e grupo `cascade` com `llmModelId` e `pollyVoiceId` no mesmo `schemaVersion: 1`. Arquivos antigos sem esses campos continuam válidos e abrem como Sonic. O modelo de texto padrão vem de `CASCADE_LLM_MODEL_ID` no `.env`; nenhum modelo é escolhido em código.
10. **Métricas.** "Latência do modelo" = fim do turno decidido até o primeiro áudio do Polly, comparável à do Sonic (fim do turno detectado pelo Sonic até o primeiro áudio). Além dela, o servidor envia por turno o tempo até o primeiro token do LLM e o tempo entre a primeira frase e o primeiro áudio do Polly. "Latência percebida" continua medida no navegador.

## Estimativa de latência

Fim de turno 700 ms + primeiro token 750 a 960 ms + primeiro áudio do Polly (com conexão já aberta, abaixo dos 805 ms medidos) ≈ **2,0 a 2,5 s** de latência percebida na configuração Equilibrada. O Sonic ainda não tem medição real para comparar.

## Riscos

- **Eco sem fones.** A voz do Polly captada pelo microfone vira transcrição e interrompe a própria resposta. Mitigação: `echoCancellation` do navegador e fones, como no Sonic.
- **Ruído de fundo constante** acima do limite de volume impede o fim do turno por silêncio. Mitigação futura: limite adaptativo.
- **Stream do Polly ocioso.** O stream é aberto antes do primeiro texto. Com o LLM levando ~1 s, o probe com intervalo de 300 ms funcionou; um LLM lento pode esbarrar em timeout do Polly. O plano registra o erro como falha visível.
- **Resposta vazia do LLM** fecha o stream do Polly sem nenhum texto. Comportamento do serviço não verificado.
- **IAM mínimo.** O perfil atual tem acesso a tudo (validado pelos probes). A ação IAM exata do streaming do Polly não foi confirmada na documentação; a política mínima deve ser validada com um perfil restrito.

## Fora do escopo

ElevenLabs (próximo plano, reaproveitando a cascata com outro sintetizador), benchmark com WAVs, gravação de áudio, avaliação MOS e relatório comparativo.
