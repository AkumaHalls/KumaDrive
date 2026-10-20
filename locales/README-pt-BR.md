<div align="center">

<img src="../src-tauri/icons/icon.png" alt="KumaDrive logo" width="100" height="100" />

# KumaDrive

**Armazenamento em nuvem pessoal e ilimitado, alimentado pelo seu próprio canal privado do Telegram.**  
Zero custos com servidores. Zero assinaturas. Criptografia MTProto direta para o Telegram.

[**English**](../README.md) • [**Português (Brasil)**](README-pt-BR.md) • [**Español**](README-es.md) • [**简体中文**](README-zh-CN.md) • [**Русский**](README-ru.md) • [**日本語**](README-ja.md) • [**Deutsch**](README-de.md)

[![Total de Downloads](https://img.shields.io/github/downloads/AkumaHalls/KumaDrive/total?style=flat-square&logo=github&logoColor=white)](https://github.com/AkumaHalls/KumaDrive/releases/)
[![Última Versão](https://img.shields.io/badge/versão-v0.2.5-2082f7.svg?style=flat-square)](https://github.com/AkumaHalls/KumaDrive/releases/latest/download/)
[![Demonstração no YouTube](https://img.shields.io/badge/YouTube-Vídeo%20Demo-red.svg?style=flat-square&logo=youtube&logoColor=white)](https://youtu.be/4AiMn7HSlFg)
[![Licença: GPL v3](https://img.shields.io/badge/licen%C3%A7a-GPLv3-gray.svg?style=flat-square)](../LICENSE)
[![Estrelas no GitHub](https://img.shields.io/github/stars/AkumaHalls/KumaDrive?style=flat-square&logo=github)](https://github.com/AkumaHalls/KumaDrive/stargazers)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131.svg?style=flat-square&logo=tauri&logoColor=black)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg?style=flat-square&logo=react&logoColor=black)](https://react.dev/)

[**Site Oficial**](https://github.com/AkumaHalls/KumaDrive) • [**Downloads**](#-downloads) • [**Vídeo Demonstrativo**](#-vídeo-demonstrativo) • [**Reportar um Erro**](https://github.com/AkumaHalls/KumaDrive/issues/new) • [**Sugerir Funcionalidade**](https://github.com/AkumaHalls/KumaDrive/issues/new)

</div>

---

## 🎬 Vídeo Demonstrativo

<div align="center">

<a href="https://youtu.be/4AiMn7HSlFg" target="_blank">
  <img src="https://img.youtube.com/vi/4AiMn7HSlFg/maxresdefault.jpg" alt="Vídeo Demonstrativo do KumaDrive" width="800" style="max-width: 100%; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);" />
</a>

<br/>

**[▶️ Assistir no YouTube: "I Turned Telegram Into Unlimited Cloud Storage"](https://youtu.be/4AiMn7HSlFg)**  
*Vídeo completo demonstrando streaming direto de arquivos via MTProto, leitor de PDF multipáginas, visualizador de CSV, editor de código CodeMirror 6 e backups automáticos de diretórios.*

</div>

---

## 💡 Por que o KumaDrive?

O Telegram oferece armazenamento praticamente ilimitado em canais privados, mas não possui hierarquia de pastas, catálogo virtual ou fluxo de trabalho no desktop no estilo Google Drive. O **KumaDrive** resolve isso:

- **Zero Servidores Intermediários**: Todas as operações de arquivos e conexões MTProto acontecem diretamente da sua máquina local para os data centers do Telegram.
- **Drive Virtual**: Pastas aninhadas, pesquisa instantânea, favoritos, arquivo e lixeira são indexados em um catálogo fixado dentro do seu canal privado.
- **Cofre Criptografado por Hardware**: Suas credenciais e chaves de sessão ficam protegidas no Tauri Stronghold usando chaves derivadas com Argon2id.
- **Múltiplas Contas**: Alterne entre vários números de telefone com isolamento completo de sessão e cofre local.

---

## 📥 Downloads

Versão mais recente: **v0.2.5** · Instaladores nativos pré-compilados para os principais sistemas operacionais:

| Sistema Operacional | Formato do Pacote | Download Direto | Tamanho |
|:---|:---|:---|---:|
| **Windows** | Instalador Setup (`.exe`) | [**KumaDrive-setup.exe**](https://github.com/AkumaHalls/KumaDrive/releases) | 5.5 MB |
| **Windows** | Pacote MSI (`.msi`) | [**KumaDrive.msi**](https://github.com/AkumaHalls/KumaDrive/releases) | 7.2 MB |
| **macOS** | Imagem de Disco Universal (`.dmg`) | [**KumaDrive.dmg**](https://github.com/AkumaHalls/KumaDrive/releases) | 15.8 MB |
| **Linux** | Universal AppImage (`.AppImage`) | [**KumaDrive.AppImage**](https://github.com/AkumaHalls/KumaDrive/releases) | 86.1 MB |
| **Linux** | Debian / Ubuntu (`.deb`) | [**KumaDrive.deb**](https://github.com/AkumaHalls/KumaDrive/releases) | 8.4 MB |
| **Linux** | Fedora / RHEL (`.rpm`) | [**KumaDrive.rpm**](https://github.com/AkumaHalls/KumaDrive/releases) | 8.0 MB |

> 🌐 O catálogo completo de pacotes, links espelho e checksums estão disponíveis no [**GitHub**](https://github.com/AkumaHalls/KumaDrive/releases/) ou em [**github.com/AkumaHalls/KumaDrive**](https://github.com/AkumaHalls/KumaDrive).

---

## ✨ Recursos

- **Nuvem Ilimitada**: Utiliza seu canal privado do Telegram como camada de armazenamento com 0 taxas recorrentes.
- **Multiplataforma Nativo**: Aplicativo ultra-leve para macOS, Windows e Linux construído em Tauri v2 e Rust.
- **Streaming Direto MTProto**: O motor GramJS transmite partes de 512 KB diretamente com até 4 threads simultâneas de upload.
- **Privacidade em Primeiro Lugar**: Sem rastreamento, telemetria oculta ou servidores intermediários. Seus arquivos ficam exclusivamente entre você e o Telegram.
- **Organização e Busca Instantânea**: Navegação por breadcrumbs, filtros por tipo de arquivo, visualização em grade ou lista e atalhos de teclado.

---

## ⚙️ Como Funciona

```
┌─────────────────────────────────────────────────────────────────┐
│                       Frontend em React 19                      │
│   ┌─────────────────────┐             ┌─────────────────────┐   │
│   │    Estado Zustand   │             │   Motor GramJS      │   │
│   └──────────┬──────────┘             └──────────┬──────────┘   │
└──────────────┼───────────────────────────────────┼──────────────┘
               │                                   │
           Tauri IPC                           MTProto Direto
         (Chamadas Bridge)                    (SSL/TLS Seguro)
               │                                   │
┌──────────────▼──────────┐              ┌─────────▼──────────────┐
│     Núcleo Rust Tauri   │              │ API da Nuvem Telegram  │
│  ┌───────────────────┐  │              │    (Canal Privado)     │
│  │  Cofre Stronghold │  │              └────────────────────────┘
│  └───────────────────┘  │
└─────────────────────────┘
```

1. **Conexão Direta**: Autentica diretamente com os servidores MTProto do Telegram pela porta TLS 443.
2. **Upload em Partes**: Divide arquivos grandes em fragmentos de 512 KB transmitidos concorrentemente.
3. **Catálogo de Pastas Fixado**: Mantém um índice de descritores JSON criptografado fixado no seu canal privado para sincronização entre dispositivos.

---

## 🚀 Como Começar

### 1. Obter Credenciais da API do Telegram

1. Acesse [my.telegram.org](https://my.telegram.org) com seu número de telefone.
2. Abra **API development tools** e crie um aplicativo (ex: `KumaDrive`).
3. Copie o seu `api_id` e `api_hash` e insira-os ao iniciar o KumaDrive pela primeira vez.

### 2. Executar a partir do Código-Fonte

**Pré-requisitos:**
- [Rust & Cargo](https://rustup.rs/) (1.78+)
- [Node.js](https://nodejs.org/) (20.19+ ou 22.12+)

```bash
# Clonar o repositório
git clone https://github.com/AkumaHalls/KumaDrive.git
cd KumaDrive

# Instalar dependências
npm install

# Iniciar o aplicativo desktop em modo de desenvolvimento
npm run tauri dev
```

### 3. Compilar os Binários de Produção

```bash
npm run tauri build
```
Os instaladores nativos compilados (`.dmg`, `.exe` / `.msi`, `.deb` / `.AppImage`) serão gerados em `src-tauri/target/release/bundle/`.

---

## ⌨️ Atalhos de Teclado

| Atalho | Ação |
|:---|:---|
| `/` ou `⌘ F` | Focar na barra de pesquisa |
| `⌘ A` | Selecionar todos os itens da pasta |
| `⌘ D` | Baixar itens selecionados |
| `F2` | Renomear item selecionado |
| `Backspace` / `Del` | Mover item selecionado para a Lixeira |
| `Esc` | Limpar seleção / desfocar pesquisa |
| `?` | Abrir lista de atalhos de teclado |

---

## 🤝 Como Contribuir

Contribuições, sugestões e correções são muito bem-vindas!

1. Faça um Fork do repositório e crie uma branch: `git checkout -b feat/minha-feature`
2. Execute os linters: `npm run lint` e `cargo fmt`
3. Faça o commit com mensagens semânticas (ex: `feat(ui): ...`)
4. Abra um Pull Request

---

## 📜 Licença

O KumaDrive é um software de código aberto licenciado sob a [GNU GPL-3.0 License](../LICENSE).

*Aviso Legal: O KumaDrive é um projeto independente de código aberto e não é afiliado, patrocinado ou endossado pela Telegram FZ-LLC. O armazenamento de grandes volumes de arquivos está sujeito aos Termos de Serviço e às políticas de uso justo da API do Telegram.*

---

<div align="center">

Criado com ❤️ por **[AkumaHalls](https://github.com/AkumaHalls)**

Se você gostou do KumaDrive, deixe uma estrela ⭐ no [GitHub](https://github.com/AkumaHalls/KumaDrive)!

</div>
