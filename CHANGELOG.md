# Changelog

Todas as mudanças relevantes deste projeto são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.2.8] — 2026-10-20

### Corrigido
- **src/lib/storage/indexQueue.ts** — o KumaDrive tinha perdido o caminho de *edição* do índice herdado do Teledrive original: salvar, renomear, mover ou favoritar um arquivo reenviava o índice inteiro (dezenas de mensagens novas + fixações + exclusões), quando deveria apenas **editar as mensagens existentes no lugar** — que é exatamente o comportamento do Teledrive original e a razão de ele ser mais fluido no uso diário. A edição está de volta: ações que não mudam a estrutura do índice agora custam apenas N edições leves, sem mensagens novas, sem fixações e sem exclusões. Quando a estrutura muda (arquivo adicionado ou removido) ou uma mensagem acabou de ser enviada (o Telegram proíbe editar mensagem nova por ~1 minuto), o commit cai no caminho antigo de reenvio seguro — enviar tudo primeiro, apagar depois — que já provou não perder dados. A limpeza de mensagens órfãs também passou a rodar nos dois caminhos, então o canal não acumula lixo de índice.
- **src/components/settings/BackupSection.tsx** e **AppearanceSection.tsx** — o símbolo de lâmpada das explicações "Como funciona o backup" e "Sincronização do tema" aparecia como caracteres corrompidos ("ðŸ'¡") por um erro de dupla codificação; agora exibe 💡 corretamente. Um caso igual num comentário interno do FileBrowser também foi corrigido.
- **locales/README-*.md** — os seis READMEs traduzidos ainda apontavam a versão v0.2.6 (o bump da v0.2.7 passou batido neles); agora apontam v0.2.8.

### Observação sobre o comportamento do backup
Durante o backup de pastas o índice continua **suspenso** e é gravado uma única vez ao final — por isso você não vê mensagens sendo enviadas e fixadas no canal durante o backup (diferente do Teledrive original). Isso é intencional: é justamente o que corta a maior fonte de bloqueio do Telegram e mantém o backup rápido. As mensagens continuam subindo normalmente, arquivo por arquivo.

## [0.2.7] — 2026-10-20

### Corrigido
- **src/lib/telegram/uploader.ts** — o envio de cada bloco de arquivo usava o mesmo limite curto de espera (30 s) que o índice, então quando o Telegram pedia "espere 200 s" o app esperava 30 s e reenviava o bloco — o que renova e AGRAVA o bloqueio. Era exatamente o sintoma relatado: o backup demorava ~2 min, subia 2 arquivos e voltava a falhar com "falha na conexão". Agora o upload respeita o prazo real pedido pelo Telegram (até 15 min) e usa menos tentativas por bloco, porque uma espera longa já resolve o que antes exigia 5 tentativas curtas que só pioravam a situação.
- **src/lib/backup/runner.ts** — o backup reescrevia o índice inteiro (dezenas de mensagens e fixações) a cada arquivo enviado, e a fixação de cada bloco do índice é justamente a chamada que o Telegram bloqueia com mais força. Num backup de centenas de arquivos isso somava milhares de mensagens e era a principal causa do bloqueio. Agora o índice é suspenso durante todo o backup e gravado uma única vez ao final, e cada gravação fixa apenas as pontas do índice em vez de todos os blocos. O manifesto continua sendo gravado por arquivo, então nada se perde se o app fechar no meio.
- **src/lib/backup/runner.ts** — quando um envio batia no limite de taxa do Telegram, os workers paralelos seguiam pegando arquivos novos e enviando, somando pressão durante o bloqueio (parte do "sobe 2 e falha"). Agora, ao primeiro bloqueio, os workers param de captar novos arquivos até o prazo passar; o paralelismo também caiu de 3 para 2.
- **src/lib/backup/runner.ts** — o resultado do backup podia reportar sucesso mesmo quando o índice na nuvem não era atualizado, e um erro de espera num bloco podia travar a fila de gravação do índice para sempre. Agora o commit consolidado do índice é aguardado e sua falha degrada o resultado para "parcial" com aviso visível, e a suspensão do índice é sempre liberada (inclusive em cancelamento e no logout).

### Adicionado
- **src/lib/backup/runner.ts** — o envio de arquivos do backup agora registra no log de diagnóstico o sucesso, a falha e cada espera por limite de taxa (com o tempo pedido pelo Telegram). Antes uma falha de backup não deixava rastro nenhum, e diagnosticar "subiu 2 e falhou" era adivinhação. O caminho dos arquivos no log é reduzido a nome + hash para não expor a estrutura de pastas do usuário.

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
