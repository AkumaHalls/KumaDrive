# Changelog

Todas as mudanças relevantes deste projeto são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

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
