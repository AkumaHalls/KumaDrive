<div align="center">

<img src="../src-tauri/icons/icon.png" alt="KumaDrive logo" width="100" height="100" />

# KumaDrive

**非公開 Telegram チャンネルを活用した、容量無制限のパーソナルクラウドストレージ。**  
サーバー費用ゼロ · 月額サブスクリプション不要 · MTProto による Telegram 直結暗号化。

[**English**](../README.md) • [**Português (Brasil)**](README-pt-BR.md) • [**Español**](README-es.md) • [**简体中文**](README-zh-CN.md) • [**Русский**](README-ru.md) • [**日本語**](README-ja.md) • [**Deutsch**](README-de.md)

[![総ダウンロード数](https://img.shields.io/github/downloads/AkumaHalls/KumaDrive/total?style=flat-square&logo=github&logoColor=white)](https://github.com/AkumaHalls/KumaDrive/releases/)
[![最新リリース](https://img.shields.io/badge/リリース-v0.2.10-2082f7.svg?style=flat-square)](https://github.com/AkumaHalls/KumaDrive/releases/latest/download/)
[![YouTube デモ動画](https://img.shields.io/badge/YouTube-動画デモ-red.svg?style=flat-square&logo=youtube&logoColor=white)](https://youtu.be/4AiMn7HSlFg)
[![ライセンス: GPL v3](https://img.shields.io/badge/ライセンス-GPLv3-gray.svg?style=flat-square)](../LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AkumaHalls/KumaDrive?style=flat-square&logo=github)](https://github.com/AkumaHalls/KumaDrive/stargazers)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131.svg?style=flat-square&logo=tauri&logoColor=black)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg?style=flat-square&logo=react&logoColor=black)](https://react.dev/)

[**公式サイト**](https://github.com/AkumaHalls/KumaDrive) • [**ダウンロード**](#-ダウンロード) • [**デモ動画**](#-デモ動画) • [**バグ報告**](https://github.com/AkumaHalls/KumaDrive/issues/new) • [**機能リクエスト**](https://github.com/AkumaHalls/KumaDrive/issues/new)

</div>

---

## 🎬 デモ動画

<div align="center">

<a href="https://youtu.be/4AiMn7HSlFg" target="_blank">
  <img src="https://img.youtube.com/vi/4AiMn7HSlFg/maxresdefault.jpg" alt="KumaDrive デモ動画" width="800" style="max-width: 100%; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);" />
</a>

<br/>

**[▶️ YouTube で視聴：「I Turned Telegram Into Unlimited Cloud Storage」](https://youtu.be/4AiMn7HSlFg)**  
*MTProto による高速ファイルストリーミング、複数ページ対応 PDF ビューアー、CSV テーブル検査、内蔵 CodeMirror 6 コードエディター、自動ディレクトリバックアップの実演。*

</div>

---

## 💡 なぜ KumaDrive なのか？

Telegram はプライベートチャンネルで実質無制限のクラウドストレージを提供していますが、フォルダ階層やカタログ検索、デスクトップドライブとしての操作性が欠けています。**KumaDrive** はその課題を解決します：

- **中継サーバーなし**：すべてのファイル転送と MTProto 接続は、お使いの端末から Telegram データセンターへ直接行われます。
- **仮想ドライブ構造**：階層フォルダ、高速検索、お気に入り、アーカイブ、ゴミ箱機能がチャンネル内のピン留め暗号化カタログで管理されます。
- **ハードウェア暗号化ボールト**：認証セッションと暗号化キーは、Argon2id 導出キーを使用して Tauri Stronghold に安全に保管されます。
- **複数アカウント対応**：セッションとローカルストレージを完全分離した状態で、複数の電話番号を切り替え可能です。

---

## 📥 ダウンロード

最新リリース: **v0.2.10** · 各 OS 向けビルド済みネイティブインストーラー：

| オペレーティングシステム | パッケージ形式 | 直接ダウンロード | サイズ |
|:---|:---|:---|---:|
| **Windows** | セットアップインストーラー (`.exe`) | [**KumaDrive-setup.exe**](https://github.com/AkumaHalls/KumaDrive/releases) | 5.5 MB |
| **Windows** | MSI パッケージ (`.msi`) | [**KumaDrive.msi**](https://github.com/AkumaHalls/KumaDrive/releases) | 7.2 MB |
| **macOS** | Universal ディスクイメージ (`.dmg`) | [**KumaDrive.dmg**](https://github.com/AkumaHalls/KumaDrive/releases) | 15.8 MB |
| **Linux** | Universal AppImage (`.AppImage`) | [**KumaDrive.AppImage**](https://github.com/AkumaHalls/KumaDrive/releases) | 86.1 MB |
| **Linux** | Debian / Ubuntu (`.deb`) | [**KumaDrive.deb**](https://github.com/AkumaHalls/KumaDrive/releases) | 8.4 MB |
| **Linux** | Fedora / RHEL (`.rpm`) | [**KumaDrive.rpm**](https://github.com/AkumaHalls/KumaDrive/releases) | 8.0 MB |

> 🌐 パッケージ一覧、ミラーリンク、チェックサムは [**GitHub**](https://github.com/AkumaHalls/KumaDrive/releases/) または [**github.com/AkumaHalls/KumaDrive**](https://github.com/AkumaHalls/KumaDrive) で確認できます。

---

## ✨ 主な機能

- **真の無制限クラウド**：非公開 Telegram チャンネルをバックエンドストレージとして活用し、月額費用は永年ゼロ。
- **軽量ネイティブクロスプラットフォーム**：Tauri v2 + Rust を採用し、メモリ消費量は通常 250MB 未満と極めて軽量。
- **MTProto チャンク分割転送**：GramJS エンジンが 512 KB チャンクを最大 4 スレッド並列で高速アップロード。
- **プライバシー最優先**：テレメトリ、行動追跡、サードパーティのプロキシは一切不使用。データはお使いの端末と Telegram 間でのみ送受信されます。
- **充実の内蔵ツール**：PDF 連続スクロールビューアー、CSV テーブルソート、20以上の言語ハイライトに対応した CodeMirror 6 エディター。

---

## ⚙️ 動作アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                      React 19 フロントエンド                    │
│   ┌─────────────────────┐             ┌─────────────────────┐   │
│   │    Zustand 状態管理 │             │    GramJS エンジン   │   │
│   └──────────┬──────────┘             └──────────┬──────────┘   │
└──────────────┼───────────────────────────────────┼──────────────┘
               │                                   │
           Tauri IPC                          直接 MTProto 接続
         (バイナリブリッジ)                     (安全な TLS 443)
               │                                   │
┌──────────────▼──────────┐              ┌─────────▼──────────────┐
│     Tauri Rust コア     │              │ Telegram Cloud API     │
│  ┌───────────────────┐  │              │ (非公開チャンネル)     │
│  │ Stronghold 金庫   │  │              └────────────────────────┘
│  └───────────────────┘  │
└─────────────────────────┘
```

1. **直接接続**：安全な TLS 443 ポート経由で Telegram の公式 MTProto サーバーと直接認証。
2. **並列チャンク転送**：大容量ファイルを 512 KB に分割し、マルチスレッドで並行送信。
3. **ピン留め暗号化カタログ**：チャンネルに暗号化された JSON ディレクトリツリーを保存し、デバイス間でリアルタイムに同期。

---

## 🚀 クイックスタート

### 1. Telegram API 認証情報の取得

1. お使いの電話番号で [my.telegram.org](https://my.telegram.org) にログインします。
2. **API development tools** を開き、アプリを新規作成します（例: `KumaDrive`）。
3. 発行された `api_id` と `api_hash` をコピーし、KumaDrive 初回起動時に入力します。

### 2. ソースコードから起動

**前提条件:**
- [Rust & Cargo](https://rustup.rs/) (1.78+)
- [Node.js](https://nodejs.org/) (20.19+ または 22.12+)

```bash
# リポジトリのクローン
git clone https://github.com/AkumaHalls/KumaDrive.git
cd KumaDrive

# 依存パッケージのインストール
npm install

# 開発モードでデスクトップアプリを起動
npm run tauri dev
```

### 3. リリースビルドの作成

```bash
npm run tauri build
```
各 OS 向けインストーラー (`.dmg`, `.exe` / `.msi`, `.deb` / `.AppImage`) が `src-tauri/target/release/bundle/` に出力されます。

---

## ⌨️ キーボードショートカット

| ショートカット | 動作 |
|:---|:---|
| `/` または `⌘ F` | 検索バーにフォーカス |
| `⌘ A` | フォルダ内の全項目を選択 |
| `⌘ D` | 選択した項目を一括ダウンロード |
| `F2` | 選択項目の名前変更 |
| `Backspace` / `Del` | 選択項目をゴミ箱に移動 |
| `Esc` | 選択解除 / 検索フォーカス解除 |
| `?` | ショートカット一覧を表示 |

---

## 🤝 コントリビューション

バグ報告、改善提案、Pull Request を大歓迎します！

1. リポジトリをフォークしてブランチを作成: `git checkout -b feat/my-feature`
2. リンターの実行: `npm run lint` および `cargo fmt`
3. コミットを作成（例: `feat(ui): ...`）
4. Pull Request を作成

---

## 📜 ライセンス

KumaDrive は [GNU GPL-3.0 License](../LICENSE) のもとで公開されているオープンソースソフトウェアです。

*免責事項：KumaDrive は独立したオープンソースプロジェクトであり、Telegram FZ-LLC との提携、スポンサーシップ、保証関係はありません。大容量ファイルの保存には Telegram の利用規約および API フェアユースポリシーが適用されます。*

---

<div align="center">

Created with ❤️ by **[AkumaHalls](https://github.com/AkumaHalls)**

KumaDrive が役立ちましたら、ぜひ [GitHub](https://github.com/AkumaHalls/KumaDrive) で ⭐ をお願いします！

</div>
