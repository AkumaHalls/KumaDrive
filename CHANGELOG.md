# Changelog

Todas as mudanças relevantes deste projeto são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

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
