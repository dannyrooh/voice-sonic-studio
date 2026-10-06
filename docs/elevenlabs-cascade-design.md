# Arquitetura Transcribe + Bedrock + ElevenLabs

Terceira arquitetura da comparação do `goal.md`. Reaproveita a cascata do Polly (`docs/polly-cascade-design.md`): Transcribe Streaming, fim de turno no servidor, Bedrock ConverseStream, interrupção, histórico e métricas continuam iguais. Muda só o sintetizador de voz.

```
microfone 16 kHz ──► Transcribe (pt-BR) ──► fim de turno ──► Bedrock ConverseStream
                                                                   │ frases
                                                                   ▼
                     ElevenLabs WebSocket stream-input (Flash v2.5, pcm_16000) ──► navegador
```

## O que se sabe sobre a conta free (fontes públicas, não verificado na conta)

| Item | Informação |
|---|---|
| Créditos | 10.000 por mês. Flash v2.5 custa 0,5 crédito por caractere: cerca de 20 mil caracteres, ~20 minutos de fala. |
| API | Incluída no plano free. Até 2 requisições simultâneas; uma conversa usa uma. |
| Formato de saída | `pcm_16000` aparece como liberado para planos baixos; `pcm_44100` exige Pro. **Confirmar com o probe.** |
| Uso | Sem uso comercial no free (exige atribuição). Para POC interna com dados fictícios, ok. |
| Vozes | Só as da biblioteca (sem clonagem). O ID da voz é opaco: precisa ser consultado na conta. |

## API usada

- `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=…&output_format=pcm_16000&language_code=pt&inactivity_timeout=60`, cabeçalho `xi-api-key`.
- Primeira mensagem `{"text": " "}`; cada frase `{"text": "<frase> ", "flush": true}`; fim `{"text": ""}`.
- Respostas `{"audio": "<base64>"}` e, no fim, `{"isFinal": true}`. Erros chegam como mensagem com `error`/`message` ou como fechamento com código diferente de 1000.
- Lista de vozes: `GET https://api.elevenlabs.io/v2/voices?page_size=100` com `xi-api-key`.
- O pacote `ws` já é dependência do projeto; não entra SDK novo.

## Decisões

1. **Mesmo pipeline em cascata.** Novo valor `pipeline: 'elevenlabs'`. `CascadeSession` escolhe a voz pela arquitetura (`cascade.elevenVoiceId` ou `cascade.pollyVoiceId`); o servidor troca só o adaptador `speak`.
2. **Chave só no servidor.** `ELEVENLABS_API_KEY` e `ELEVENLABS_MODEL_ID` vêm do `.env`. O navegador recebe apenas se a chave está configurada. A chave nunca entra no JSON nem nas respostas HTTP.
3. **Modelo** `eleven_flash_v2_5` no `.env.example` (menor latência e metade do custo). Nenhum modelo escolhido em código.
4. **Voz por configuração** em `cascade.elevenVoiceId`, com padrão em `ELEVENLABS_VOICE_ID`. A tela tem "Consultar vozes do ElevenLabs", que lista as vozes da conta pelo servidor.
5. **Idioma** enviado em `language_code` (pt-BR→`pt`, en-US→`en`, es, fr, de, it, hi).
6. **Frase a frase com `flush`**, como no Polly. A conexão abre no início do turno, em paralelo com o Bedrock.
7. **Custo** aparece na cabine como "caracteres de voz" (cada caractere do Flash consome 0,5 crédito).
8. **JSON antigo** continua válido: sem `elevenVoiceId`, o valor vem do padrão.

## Riscos

- `pcm_16000` pode não estar liberado no free: o probe acusa antes de qualquer conversa; alternativa seria `mp3` com decodificação no navegador (fora deste plano).
- Créditos acabam rápido com respostas longas; o prompt já pede frases curtas.
- O texto das respostas sai da AWS para o ElevenLabs.
- Latência real só com a chave: o probe mede o primeiro áudio.

## Fora do escopo

Benchmark com WAVs, gravação de áudio, avaliação MOS e relatório comparativo.
