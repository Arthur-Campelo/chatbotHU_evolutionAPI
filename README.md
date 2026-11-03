# Chatbot do Ambulatório HU

Bot de WhatsApp em Node.js/Express integrado à Evolution API 2.3.7. O PostgreSQL do Supabase guarda pacientes, pausas de atendimento e lembretes. O PostgreSQL da Evolution é separado.

## Preparação

Requisitos: Node.js 22/24, PostgreSQL e uma instância Evolution API conectada por QR Code/Baileys. Para envio das mensagens às 07:00, bot, worker, Evolution e banco precisam permanecer disponíveis.

1. Crie um projeto Supabase. No painel **Connect**, copie a conexão direta (se houver IPv6) ou **Session pooler**, porta `5432`. Para o backend persistente, use a mesma modalidade em `DATABASE_URL` e `DIRECT_URL`. Não use o pooler de transações para migrations.
2. Copie `.env.example` para `.env` e preencha as variáveis. `WEBHOOK_SECRET` deve ser uma chave aleatória forte. `ALLOWED_NUMBER` limita os testes a um telefone; vazio permite qualquer conversa individual válida.
3. Rode `npm ci`, `npm run db:generate` e `npm run db:migrate:deploy` dentro de `ambulatorio-hu-bot/`.
4. Inicie `npm start` e, em outro processo, `npm run worker`. Em desenvolvimento, `npm run dev` substitui `npm start`.
5. Configure o webhook da instância Evolution com cabeçalho `x-webhook-secret` igual a `WEBHOOK_SECRET`, `webhook_by_events=false` e eventos `MESSAGES_UPSERT` e `SEND_MESSAGE`. Neste computador, a URL é `http://host.docker.internal:3000/webhook`; use `https://SEU_HOST/webhook` somente se a Evolution estiver em outra máquina ou se optar por um túnel público. A rota `GET http://localhost:3000/` verifica o bot.

Não registre o segredo no repositório. A URL de um túnel temporário, como Ngrok, deve ser atualizada na Evolution ao mudar.

## Iniciar tudo no mesmo computador (Windows + Docker Desktop)

Este checkout contém `../evolution-api-server/docker-compose.yml`: ele inicia a Evolution API 2.3.7, seu PostgreSQL próprio e Redis. O Supabase usado pelo bot é **outro** banco; não altere a conexão interna da Evolution para apontá-la ao Supabase.

1. Abra o Docker Desktop e espere o mecanismo Docker iniciar. No PowerShell, rode:

   ```powershell
   cd D:\Downloads\ambulatorio-hu-bot\evolution-api-server
   docker compose up -d
   docker compose ps
   ```

   A Evolution deve ficar acessível em `http://localhost:8080`; abra `http://localhost:8080/manager` para administrar a instância. Se `docker compose` disser que não consegue acessar `dockerDesktopLinuxEngine`, o Docker Desktop ainda não iniciou.

2. No `.env` do bot, `EVOLUTION_API_URL` deve ser `http://localhost:8080`. `EVOLUTION_API_KEY` deve ser igual a `AUTHENTICATION_API_KEY` de `../evolution-api-server/.env`, e `INSTANCE_NAME` deve ser o nome exato da instância que você criará no Manager. Defina um valor aleatório real em `WEBHOOK_SECRET`. Não publique os arquivos `.env`.
3. No PowerShell, execute as migrations e inicie o bot:

   ```powershell
   cd D:\Downloads\ambulatorio-hu-bot\ambulatorio-hu-bot
   npm run db:generate
   npm run db:migrate:deploy
   npm start
   ```

   Confira `http://localhost:3000/`; em um segundo terminal na mesma pasta, rode `npm run worker`.
4. No Manager da Evolution, crie ou abra a instância `ambulatorio-hu`, conecte o WhatsApp por QR Code e configure o webhook da instância. Como a Evolution está em um contêiner Docker e o bot roda no Windows, use `http://host.docker.internal:3000/webhook`, com `webhook_by_events=false`, eventos `MESSAGES_UPSERT` e `SEND_MESSAGE` e cabeçalho `x-webhook-secret` igual ao `WEBHOOK_SECRET` do bot. `localhost:3000` dentro do contêiner não aponta para o Windows.

**Ngrok é opcional neste cenário local.** Supabase guarda dados; Evolution liga o bot ao WhatsApp; Ngrok apenas fornece uma URL HTTPS pública para o webhook quando a Evolution está fora do seu computador ou não consegue alcançar o bot diretamente. Se optar por ele, rode `ngrok http 3000` e configure na Evolution `https://URL-DO-NGROK/webhook`; atualize a URL sempre que o túnel mudar.

## Diagnóstico de mensagens sem resposta

O ponto de entrada é `POST /webhook` em `src/server.js`; o filtro de instância, telefone e número autorizado fica em `src/webhookHandler.js`. Para ver por que a próxima mensagem foi aceita ou ignorada, interrompa apenas o processo do bot (`Ctrl+C`) e reinicie no PowerShell:

```powershell
$env:DEBUG_WEBHOOK='1'
npm start
```

Envie uma nova mensagem do número definido em `ALLOWED_NUMBER`. O diagnóstico imprime somente tipo de evento, direção e motivo de descarte, sem texto nem telefone. Se não surgir nenhuma linha `[webhook-debug]`, a Evolution não chamou o bot; confira o webhook da instância e `docker compose logs -f evolution-api` na pasta `../evolution-api-server`. Se surgir `HTTP 401`, confira o cabeçalho `x-webhook-secret`; se surgir `número fora de ALLOWED_NUMBER`, corrija o número de teste. Após o diagnóstico, interrompa o bot e reinicie com `DEBUG_WEBHOOK=0`.

## Fluxo

O paciente escolhe idioma e setor. Para telefone novo, o bot envia `assets/termos-demonstrativos.pdf`, pede aceite e coleta CPF, nome e nascimento. Só cria o paciente após o aceite e a confirmação dos dados. Um telefone já cadastrado confirma os dados e segue ao menu sem receber os termos novamente. O arquivo PDF é **apenas demonstrativo** e deve ser substituído antes do uso institucional; `TERMS_PDF_PATH` aponta para o arquivo definitivo.

As opções Português, Guarani, Ambulatório e Outros Setores aparecem no menu; as mensagens continuam em português. Remarcação, cancelamento e consulta de consultas são pedidos enviados à equipe, sem atualização da agenda hospitalar.

Ao encaminhar o pedido, o bot avisa que ficará pausado. O paciente pode enviar `menu` ou `reiniciar` para retomá-lo. Após uma hora sem nova mensagem da atendente, qualquer mensagem reinicia o fluxo. Cada mensagem manual da atendente renova essa hora; respostas automáticas não renovam. Dados de um cadastro ainda incompleto ficam somente na memória e se perdem ao reiniciar o bot.

## Lembrete manual

A atendente envia pelo aplicativo do WhatsApp conectado à Evolution, na conversa de um paciente cadastrado:

```text
dia:25/11/2026
```

Datas diferentes criam lembretes independentes. Repetir a mesma data não cria outro. Data de hoje, passada ou inexistente é dispensada. A data de preferência que o paciente informa ao pedir remarcação não agenda lembrete.

O worker envia uma mensagem genérica entre **07:00 e antes de 07:05**, no fuso `America/Campo_Grande`. Após esse período, o lembrete expira. Um timeout de envio pode deixar o resultado como **incerto** para conferência manual; o sistema não reenvia automaticamente uma mensagem cujo resultado é desconhecido. Pedidos de cancelamento e remarcação não cancelam lembretes já criados.

## Testes

`npm test` executa os testes locais. Para integração real com PostgreSQL, use um banco de teste **separado** em `127.0.0.1:55432/ambulatorio_test`, defina `TEST_DATABASE_URL`, aplique `npm run db:migrate:deploy` com as URLs apontando para esse banco e rode `npm test`. O teste de integração apaga somente os dados desse banco local; ele se recusa a executar com outra URL.

Depois de configurar o WhatsApp de teste, confira manualmente: recebimento do PDF, aceite/cadastro, retorno por telefone, mensagem `dia:...` enviada pela atendente, confirmação, pausa/retomada e envio do lembrete. Testes simulados não comprovam o comportamento da conexão real da Evolution.
