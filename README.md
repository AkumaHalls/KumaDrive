<div align="center">

# 🐻 KumaDrive

**Armazenamento em nuvem ilimitado, privado e gratuito usando o Telegram**

Desktop multiplataforma · Windows · macOS · Linux

[![Licença](https://img.shields.io/badge/Licença-GPL--3.0-orange?style=flat-square)](LICENSE)
[![Versão](https://img.shields.io/badge/versão-0.2.8-orange?style=flat-square)](https://github.com/AkumaHalls/KumaDrive/releases)
[![Plataforma](https://img.shields.io/badge/plataforma-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](#download)
[![Atualizações](https://img.shields.io/badge/updates-automáticas-green?style=flat-square)](#atualizações-automáticas)

</div>

---

## O que é

O KumaDrive transforma um **canal privado do Telegram** na sua nuvem pessoal.
Os arquivos são enviados como documentos para esse canal e catalogados por um
índice local — o resultado é uma unidade de armazenamento virtual com todas as
coisas que você espera de um disco, sem servidor, sem assinatura e sem custo.

### Por que Telegram?

| | Serviço comercial | Telegram |
|---|---|---|
| Custo mensal | Assinatura | **Grátis** |
| Limite de tamanho | Variável | Até 2 GB por arquivo |
| Espaço total | Finito | Ilimitado¹ |
| Conta extra | Obrigatória | A que você já tem |
| Privacidade | Depende do fornecedor | Criptografia MTProto |

¹ Sujeito à política de uso justo da API do Telegram. Respeite os termos de serviço.

### Recursos

**Navegação**
- Meu Drive, Recentes, Favoritos, Lixeira, Arquivados
- Busca com filtros por tipo (documentos, imagens, vídeo, áudio)
- Visualização em grade ou lista, com ordenação configurável

**Arquivos**
- Arrastar e soltar para upload, com pastas inteiras
- Pré-visualização de PDF, CSV, imagens, código-fonte e Markdown
- Marcar como favorito, renomear, mover, duplicar, excluir
- Arrastar para mover entre pastas
- Atalhos de teclado (`F2` renomeia, `Delete` exclui, `Ctrl+A` seleciona)

**Telegram**
- Login por número de telefone com verificação em duas etapas
- Canal de armazenamento privado e dedicado por conta
- Sessão criptografada via plugin Stronghold

**Backup**
- Espelhamento automático de pastas do disco para o canal
- Agendamento por intervalo (15 min, 1 h, 6 h, diário…)
- Diff incremental: só reenvia o que mudou
- Padrões de exclusão (globs)
- Retomada automática em caso de falha

**Interface**
- Temas claro, escuro e automático (segue o sistema)
- Interface em **português do Brasil**
- Notificações com progresso de upload
- Painel de progresso de backup

---

## Download

👉 **[Baixe a última versão](https://github.com/AkumaHalls/KumaDrive/releases/latest)**

| Sistema | Arquivo | Observação |
|---|---|---|
| **Windows** | `KumaDrive_*_x64-setup.exe` | ✅ **Recomendado** — suporta atualização automática |
| Windows | `KumaDrive_*_x64_en-US.msi` | Para políticasas corporativas; sem auto-update |
| macOS | `.dmg` | |
| Linux | `.AppImage`, `.deb`, `.rpm` | |

> **Por que NSIS e não MSI?** O atualizador do Tauri no Windows só funciona com o
> instalador NSIS. Se você quer receber atualizações automáticas, use o `.exe`.

### Requisitos

- **Windows 10/11** (64 bits) com WebView2 — instalado automaticamente pelo setup
- **macOS 10.15+**
- **Linux** com `libwebkit2gtk-4.1` e `libayatana-appindicator3`

Primeiro uso: informe seu **api_id** e **api_hash** do Telegram
([obtenha aqui](https://my.telegram.org/apps)) e o número de telefone.

---

## Atualizações automáticas

O app verifica atualizações em **Configurações → Sobre → Verificar atualizações**
e também na inicialização quando há release nova.

O fluxo usa [Tauri Updater](https://tauri.app/plugin/updater/): cada instalador é
**assinado criptograficamente** e o app só instala se a assinatura for válida.
Sem isso, qualquer um poderia servir um executável falso no lugar do seu app.

Para publicar uma versão nova:

```bash
# 1. Atualize a versão em package.json e src-tauri/tauri.conf.json
npm version 0.2.1 --no-git-tag-version
# (edite também "version" em src-tauri/tauri.conf.json)

# 2. Commit e tag
git commit -am "chore: bump para 0.2.1"
git tag -a v0.2.1 -m "KumaDrive v0.2.1"
git push origin main && git push origin v0.2.1

# 3. O GitHub Actions compila, assina e cria a release (rascunho)
#    Revise e publique em: https://github.com/AkumaHalls/KumaDrive/releases
```

A chave privada de assinatura vive apenas como **secret do GitHub Actions**
(`TAURI_SIGNING_PRIVATE_KEY`) — nunca no seu computador, nunca no repositório.
Somente a chave pública fica no `tauri.conf.json`, que é pública por natureza.

---

## Desenvolvimento

### Pré-requisitos

- **Node.js 20+** e npm
- **Rust** estável ([rustup.rs](https://rustup.rs))
- Ferramentas de build do Tauri para o seu sistema
  ([tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/))

### Instalar e rodar

```bash
npm install
npm run tauri dev
```

### Compilar

```bash
npm run tauri build
```

Gera os artefatos em `src-tauri/target/release/bundle/`.

### Estrutura

```
src/
├─ components/
│  ├─ files/       Navegação e listagem de arquivos
│  ├─ layout/      Layout principal (sidebar, cabeçalho, busca)
│  ├─ preview/     Visualizadores (PDF, CSV, imagens, código)
│  ├─ settings/    Seções de Configurações
│  ├─ backup/      Overlay de progresso do backup
│  ├─ upload/      Painel de progresso de envio
│  └─ ui/          Componentes base
├─ lib/
│  ├─ telegram/    Cliente MTProto, canal e envio
│  ├─ backup/      Manifest, walker, agendador, diff
│  ├─ storage/     Índice local, fila, escrita segura
│  ├─ secure/      Stronghold, cofre, info do dispositivo
│  ├─ upload/      Gerenciador de uploads
│  └─ sync/        Sincronização remota
├─ pages/          Rotas (Drive, Settings, Auth…)
└─ stores/         Zustand (arquivos, auth, UI, progresso)

src-tauri/
├─ src/lib.rs      Comandos nativos (I/O, sessão, agendador)
├─ capabilities/   Permissões por janela
└─ tauri.conf.json Configuração e empacotamento
```

### Stack

- **Tauri 2** — shell nativo leve em Rust
- **React 19 + TypeScript** — interface
- **Tailwind CSS 4** — estilização com variante `dark` por seletor de classe
- **GramJS** — cliente MTProto do Telegram
- **Zustand** — estado
- **Stronghold** — cofre criptografado
- **Radix UI + Lucide** — componentes e ícones

---

## Segurança e privacidade

- **Criptografia MTProto** — todo trafego com o Telegram é criptografado pelo
  protocolo oficial, não por implementação própria
- **Sessão no Stronghold** — o arquivo de sessão fica num cofre criptografado
- **Chaveiro isolado por conta** — cada número de telefone tem seu próprio canal
  e índice; contas diferentes nunca se misturam
- **Atualizações assinadas** — o app rejeita qualquer artefato sem assinatura válida
- **Canal privado** — só você tem acesso; o app nunca envia dados a terceiros

### O que este app **não** faz

- Não modifica o cliente oficial do Telegram
- Não envia seus arquivos para servidores próprios — a única cópia é o seu canal
- Não tem telemetria nem analytics
- Não é afiliado, patrocinado ou endossado pelo Telegram FZ-LLC

---

## Contribuindo

Issues e PRs são bem-vindos.

1. Abra uma issue descrevendo o problema ou melhoria
2. Fork e crie um branch: `git checkout -b minha-melhoria`
3. Commite com mensagens claras em português
4. Abra o PR contra `main`

Ao contribuir você concorda com a [Licença GPL-3.0](LICENSE) — o mesmo termo do
projeto de origem.

---

## Licença

**GNU General Public License v3.0**

Este projeto é software livre. Baseado no
[Teledrive](https://github.com/senapati484/teledrive), sob a licença GPL-3.0.
Consulte o arquivo [LICENSE](LICENSE) para o texto completo.

```
Copyright (C) 2026 KumaDrive contributors
Copyright (C) 2024 Teledrive contributors (projeto original)

Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo
sob os termos da Licença Pública Geral GNU versão 3, conforme publicada
pela Free Software Foundation.

Este programa é distribuído na esperança de que seja útil, mas SEM
GARANTIA; semnenhuma garantia implícita de COMERCIALIZAÇÃO ou ADEQUAÇÃO
a um propósito específico. Consulte a Licença para mais detalhes.
```

---

<div align="center">

**KumaDrive** — feito com ☕ e 🐻 no Brasil

[Reportar problema](https://github.com/AkumaHalls/KumaDrive/issues) ·
[Código](https://github.com/AkumaHalls/KumaDrive)

</div>
