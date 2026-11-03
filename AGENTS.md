# Arquitetura atual — chatbot Ambulatório HU

O bot usa Node.js/CommonJS, Express, Evolution API 2.3.7 e PostgreSQL com Prisma 6.19. O banco de pacientes é separado do banco interno da Evolution. Consulte `README.md` para configuração e operação.

## Componentes

- `src/server.js`: health-check e `POST /webhook` autenticado por `x-webhook-secret`.
- `src/webhookHandler.js`: normalização de eventos, identificação de paciente/atendente, sessão e fluxo.
- `src/flow.js`: páginas e transições da conversa.
- `src/sessionManager.js`: dados provisórios em memória; não sobrevive a reinício.
- `src/evolutionApi.js` e `src/messenger.js`: envio de mensagens e registro da intenção de saída.
- `src/reminderWorker.js`: confirmação pendente e lembretes programados.
- `src/validation.js`: CPF, datas e fuso `America/Campo_Grande`.
- `prisma/schema.prisma` e `prisma/migrations/`: fonte do esquema persistente.

## Invariantes

- Sem aceite explícito e confirmação final, não se cria `Paciente`.
- Cadastro existente pelo telefone dispensa os termos.
- Um telefone corresponde a um paciente. CPF em outro telefone exige atendimento humano.
- `dia:DD/MM/AAAA` enviado manualmente pelo número conectado cria no máximo um lembrete por paciente/data; mensagens do paciente e do bot não criam lembretes.
- A intervenção manual pausa o bot por uma hora, renovada a cada mensagem manual. `menu`/`reiniciar` do paciente retoma imediatamente.
- Lembretes são enviados das 07:00 até antes de 07:05 no dia da data, no fuso de Dourados. Hoje, passado e datas inválidas não agendam.
- `ENVIADO` indica aceite da chamada de envio pela Evolution, não leitura no WhatsApp. Resultado incerto requer conferência, sem reenvio cego.

## Desenvolvimento

O fluxo do paciente depende de um único processo do bot por causa da sessão em memória. O worker é processo separado e reserva lembretes no PostgreSQL. Testes unitários rodam com `npm test`; o teste de integração só roda com `TEST_DATABASE_URL` apontando para o banco local permitido. Não rode testes de limpeza contra Supabase ou o banco da Evolution.
