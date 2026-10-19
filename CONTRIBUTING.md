# Contribuindo com o KumaDrive

Antes de tudo, obrigado por reservar um tempo para contribuir! É gente como você que mantém o KumaDrive robusto, seguro e acessível para todos.

Ao contribuir com este projeto, você concorda em respeitar os termos da licença **GNU GPL-3.0**, sob a qual o KumaDrive é distribuído.

---

## Como posso contribuir?

### 1. Reportando bugs

- Procure primeiro no [rastreador de Issues](https://github.com/AkumaHalls/KumaDrive/issues) para garantir que o problema ainda não foi reportado.
- Se for um problema novo, abra um relatório de bug detalhando:
  - Passos claros para reproduzir o comportamento.
  - Resultado esperado versus resultado obtido.
  - Versão do seu sistema operacional (macOS, Windows, Linux).
  - Logs relevantes (por exemplo, o conteúdo de `app_data_dir/vault_state.log` ou erros do console do navegador).

### 2. Sugerindo melhorias

- Abra uma solicitação de recurso na página de Issues.
- Explique o caso de uso e por que o recurso beneficiaria a maioria dos usuários do KumaDrive.
- Mockups ou diagramas das mudanças de interface são muito bem-vindos!

### 3. Enviando Pull Requests (PRs)

- Faça um **fork** do repositório e crie sua branch a partir da `main`.
- Mantenha as mudanças focadas. Evite misturar modificações não relacionadas em um único pull request.
- Garanta que todas as verificações automatizadas (linters, compilação) passem localmente.

---

## Modelo de branches do Git

Siga as convenções de nomenclatura de branch:

- **Funcionalidades**: `feature/nome-da-feature` (ex.: `feature/temas-personalizados`)
- **Correções de bug**: `bugfix/descricao-do-issue` (ex.: `bugfix/autofocus-otp`)
- **Documentação**: `docs/descricao-da-mudanca` (ex.: `docs/esquema-da-api`)

---

## Padrões de código e qualidade

Para manter a base de código limpa e legível, exigimos:

### Frontend (React & TypeScript)

- **Formatação**: rode o Prettier antes de commitar.
- **TypeScript**: garanta tipagem estrita. Não use `any` a menos que seja absolutamente necessário (por exemplo, ao lidar com respostas cruas e dinâmicas da API do GramJS).
- **Estilo**: use classes utilitárias do Tailwind CSS. Evite estilos inline customizados. Respeite os modos **claro** e **escuro** ao editar componentes visuais.
- **Ícones**: use sempre ícones SVG do `lucide-react`. Nunca use emojis crus como ícones de interface.
- **Idioma**: todas as strings visíveis ao usuário devem estar em português do Brasil (pt-BR).

### Backend (núcleo em Rust)

- **Formatação**: rode `cargo fmt` para formatar arquivos Rust.
- **Segurança**: garanta que não existam avisos de compilação. Rode `cargo clippy` para verificar código Rust idiomático.

---

## Configuração do ambiente local

1. **Clone o repositório**:
   ```bash
   git clone https://github.com/AkumaHalls/KumaDrive.git
   cd KumaDrive
   ```
2. **Instale as dependências**:
   ```bash
   npm install
   ```
3. **Inicie o servidor de desenvolvimento**:
   ```bash
   npm run tauri dev
   ```

---

## Checklist de Pull Request

Antes de enviar seu PR, verifique o seguinte:

- [ ] O app compila limpo, com zero avisos ou erros de compilação:
  ```bash
  npm run build
  ```
- [ ] Nenhuma declaração temporária de depuração (`console.log`, `println!`) permanece no código de produção.
- [ ] O código funciona corretamente nos temas **claro** e **escuro**.
- [ ] Controles clicáveis incluem o cursor adequado (`cursor-pointer`).
- [ ] Você atualizou o `README.md` ou outra documentação se seu pull request introduzir mudanças de configuração ou novas dependências.
- [ ] (Se for visual) Anexe capturas de tela de antes e depois na descrição do pull request.
