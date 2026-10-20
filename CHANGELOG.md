# Changelog

Todas as mudanças relevantes deste projeto são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.2.6] — 2026-10-20

### Corrigido
- **src/lib/telegram/rateLimit.ts** — o app esperava apenas 30 s quando o Telegram pedia esperas muito maiores (chegou a exigir 884 s em campo). Retentar antes do prazo exigido não "tenta de novo": ele renova e AGRAVA o bloqueio. Por isso o backup falhava com o que a tela mostrava como "falha de conexão" — era o próprio app estourando a cota de mensagens. Agora existem dois limites: 30 s para caminhos interativos (upload de arquivo, download) e até 15 min para o índice, que precisa esperar de verdade para convergir.
- **src/lib/storage/indexQueue.ts** — o índice de arquivos era reenviado inteiro (18 mensagens) repetidamente enquanto o Telegram estava bloqueando, escalando o bloqueio de 125 s até 884 s e travando o backup seguinte. Agora, quando o Telegram pede uma espera, o índice espera o prazo real, não gasta o orçamento de retentativas comuns nessa espera, e um envio novo durante a espera não antecipa a gravação. O orçamento total de espera é de 45 min numa janela de 10 min; passado isso, o app desiste com erro claro em vez de esperar indefinidamente.
- **src/components/update/UpdateScreen.tsx** e **.github/workflows/release.yml** — a tela de atualização mostrava "Novidades desta versão" vazio ou com o texto genérico de instalação, porque a release no GitHub nunca recebia o changelog real. Agora o workflow publica a seção da versão do `CHANGELOG.md` como texto da release, e a tela mostra esse conteúdo — ou, quando não houver, um link direto para o changelog em vez de um bloco em branco.

## [0.2.5] — 2026-10-20

### Alterado
- **src/lib/backup/runner.ts** — o backup de uma pasta agora envia vários arquivos ao mesmo tempo (até 3 em paralelo) em vez de um por vez. O envio era o gargalo: cada arquivo esperava o anterior terminar. A gravação do manifesto e a mesclagem do índice continuam em ordem, através de uma fila de commits — o paralelismo é só de rede e leitura de disco.
- **src/lib/backup/runner.ts** — a pausa entre lotes de arquivos deixou de ser fixa (2 s a cada 3 arquivos) e passou a ser adaptativa: 250 ms no caminho normal, subindo para 2 s apenas quando um lote de fato precisou esperar por limite de taxa do Telegram. Num backup de 300 arquivos isso remove cerca de 200 s de espera ociosa.
- **src/lib/backup/runner.ts** — o backup passou a mostrar o arquivo em envio no overlay de progresso (antes o rótulo ficava sempre genérico).
- **src/lib/telegram/uploader.ts** — o tamanho do bloco enviado subiu de 512 KB para 1 MB (recomendado pelo Telegram). Um arquivo de 1 GB passa de ~2048 para ~1024 blocos, com metade das leituras de disco e das idas e voltas de rede.

### Corrigido
- **src-tauri/src/lib.rs** — a leitura de blocos do upload reabria e reposicionava o arquivo a cada bloco. Agora o arquivo fica em cache (com limite de 16 arquivos e expiração de 30 s) e só o bloco é lido, cortando as chamadas de sistema por bloco.
- **src-tauri/src/lib.rs** — a leitura de um bloco podia devolver menos bytes que o esperado num ponto no meio do arquivo (arquivos em rede), enviando dados faltando ao Telegram. Agora a leitura repete até completar o bloco ou chegar de fato ao fim do arquivo.
- **src/lib/backup/runner.ts** — quando a sessão do Telegram expira no meio do backup, a contagem de arquivos não enviados deixou de somar arquivos que outros envios paralelos já tinham concluído.

## [0.2.4] — 2026-10-19

### Adicionado
- **src/components/update/UpdateNotice.tsx** — aviso flutuante de nova versão exibido no topo assim que o app abre. Antes a única forma de saber era um diálogo que só aparecia quando a checagem do boot terminava; agora o aviso existe em qualquer tela (login, drive, configurações) e traz o par de versões (instalada → disponível) com atalho para a tela de atualização.
- **src/components/update/UpdateScreen.tsx** — tela de atualização em tela cheia (substitui o antigo `UpdateDialog`), com o par de versões, as novidades da versão e a barra de progresso do download. Usa os primitivos do Radix, que já cuidam de foco, `aria-modal`, bloqueio de scroll e `Esc`; o foco inicial vai para "Atualizar agora".

### Alterado
- **src/stores/updateStore.ts** — novo estado do aviso (`noticeDismissed`, `openScreen`, `closeScreen`) e a opção `openOnFound` em `checkForUpdates`. No boot a checagem é silenciosa e NÃO abre a tela cheia (o aviso do topo é quem chama atenção); pelo botão em Configurações → Sobre ela abre a tela direto.
- **src/App.tsx** — a checagem de versão nova passou a rodar em paralelo com a restauração da sessão, em vez de esperar o splash sumir. Assim o aviso já costuma estar pronto quando o app termina de abrir.
- **src/components/settings/AboutSection.tsx** — "Verificar atualizações" reaproveita a tela já detectada em vez de reconsultar a rede.

### Corrigido
- **src/index.css** — o ícone de confirmação dos toasts ficava colado no texto. O sonner reserva um slot de 16×16 com `gap: 6px` para o ícone, mas o ícone do KumaDrive é um círculo de 32×32: ele transbordava o slot e encostava na mensagem. O slot agora acompanha o tamanho real e o espaçamento subiu para 12px.

## [0.2.3] — 2026-10-19

### Corrigido
- **src/lib/backup/walker.ts** — o backup de uma pasta que continha qualquer arquivo de 0 byte parava no primeiro deles com `400 FILE_PARTS_INVALID (caused by messages.SendMedia)`. Arquivos vazios agora são ignorados (com aviso) em vez de interromper o envio.
- **src/lib/telegram/rateLimit.ts** — erros de dados por arquivo (`FILE_PARTS_INVALID`, `FILE_ID_INVALID`, `MSG_ID_INVALID`) deixaram de ser tratados como falha fatal da sessão. Antes, um único arquivo ruim abortava o backup inteiro e a interface dizia "Sessão do Telegram expirada. Reconecte sua conta" mesmo com a sessão válida.
- **src/lib/backup/runner.ts** — o backup só é abortado por erros realmente fatais de sessão/canal (autenticação, `CHANNEL_PRIVATE`, etc.), não por erro de um arquivo específico.
- **src/lib/telegram/uploader.ts** — o envio de um arquivo vazio pela interface agora mostra uma mensagem clara em vez do erro genérico 400.

### Adicionado
- **src/hooks/useBackupRunner.ts**, **src/lib/backup/scheduler.ts** — aviso informando quantos arquivos de 0 byte foram ignorados no backup (manual e agendado).
- **CHANGELOG.md** — este arquivo.

### Alterado
- **src-tauri** — auditoria ECC round 5: gravação atômica de arquivos, remoção de execução via shell e correção de erros silenciosos.
- **empacotamento** — artefatos de release renomeados do upstream para KumaDrive/AkumaHalls.
- **.github/workflows/release.yml** — a release passa a ser publicada automaticamente ao enviar a tag (antes era criada como rascunho).
