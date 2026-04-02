# claude-peers クロスネットワーク構築マニュアル

> **対象読者:** Claude Codeを複数PC間で連携させたい全スタッフ
> **所要時間:** 約30分（2台構成の場合）
> **最終検証日:** 2026-04-02

---

## 目次

1. [概要](#1-概要)
2. [アーキテクチャ](#2-アーキテクチャ)
3. [前提条件](#3-前提条件)
4. [事前準備](#4-事前準備)
5. [ブローカーPC のセットアップ（LAN内構成）](#5-ブローカーpc-のセットアップ)
6. [クライアントPC のセットアップ](#6-クライアントpc-のセットアップ)
7. [動作確認](#7-動作確認)
8. [トラブルシューティング](#8-トラブルシューティング)
9. [運用Tips](#9-運用tips)
10. [VPS構成（拠点間・リモート接続）](#10-vps構成拠点間リモート接続)
11. [用語集](#11-用語集)

---

## 1. 概要

**claude-peers** は、複数のClaude Codeセッション同士がリアルタイムでメッセージをやりとりできるMCPサーバーです。

**できること:**
- 同じPC内の複数Claude Codeセッション間の通信
- 異なるPC間（LAN内）のClaude Code同士の通信
- メッセージの**リアルタイム自動検知**（1秒以内に相手の会話に表示される）
- ピアの一覧確認（誰が何をやっているか把握）

**ユースケース:**
- 複数人でのYouTube動画制作ワークフロー（レビュー役・制作役の分担）
- リーダーClaude → ワーカーClaudeへのタスク指示
- 異なるPCにいるスタッフ同士のClaude協調作業

---

## 2. アーキテクチャ

```
  ブローカーPC（1台だけ）                 クライアントPC（複数台OK）
  ┌─────────────────────────┐           ┌──────────────────────────┐
  │  broker.ts              │           │                          │
  │  ポート 7899            │           │  Claude Code セッション  │
  │  SQLiteでピア管理       │◄──HTTP──►│  └─ server.ts (MCP)      │
  │                         │           │     └─ 1秒ごとにポーリング│
  │  Claude Code セッション │           │     └─ channel通知で自動表示│
  │  └─ server.ts (MCP)     │           │                          │
  └─────────────────────────┘           └──────────────────────────┘
         ▲                                        ▲
         │            同じLAN内                     │
         └──────────────────────────────────────────┘
```

**役割:**
- **broker.ts:** 中央のメッセージ仲介サーバー。LAN内に1台だけ起動する
- **server.ts:** 各Claude Codeセッションに1つずつ起動するMCPサーバー。brokerとの通信を担当

---

## 3. 前提条件

| 項目 | 要件 |
|------|------|
| OS | Windows 10/11（Mac/Linuxも可。本マニュアルはWindows前提） |
| Claude Code | v2.1.80 以上 |
| Bun | v1.0 以上 |
| Node.js | npm が使える状態（Bunインストールに使う場合） |
| ネットワーク | 全PCが同じLAN内にあること |
| ファイアウォール | ブローカーPCのポート 7899 が開放されていること |
| 認証 | Claude Code にログイン済みであること（APIキー認証は不可） |

---

## 4. 事前準備

### 4.1 PCに名前をつける

構築作業中、「どのPCの話をしているか」が混乱の最大原因になります。
**作業開始前に、各PCにわかりやすい名前を決めてください。**

例:
- ブローカーPC → 「じろうPC」
- クライアントPC → 「たろうPC」「さぶろうPC」

### 4.2 コミュニケーション手段の確保

構築中はclaude-peersがまだ動いていないため、**別の連絡手段**が必要です。

> **推奨:** Discord / Slack / Teams などのチャットツールで専用チャンネルを作成し、
> 各PCのClaude同士がエラーログを貼り合える状態にしておく。
> これがないと、人間がエラーメッセージを口頭で伝達する非効率な作業になります。

### 4.3 IPアドレスの確認

ブローカーPCのローカルIPアドレスを確認します。

```powershell
# PowerShell で実行
ipconfig | Select-String "IPv4"
```

出力例: `IPv4 Address. . . . . . . . . . . : 192.168.0.142`

→ この値を控えておく（以降 `<ブローカーIP>` と表記）

### 4.4 文字コードの設定（Windows必須）

Windowsのデフォルト文字コード（CP932/Shift_JIS）は日本語メッセージの文字化けを引き起こします。
**Claude Codeを起動する前に、毎回以下を実行してください。**

```powershell
# PowerShell で実行
chcp 65001
```

> **恒久対策:** PowerShellプロファイルに自動設定を追加する
> ```powershell
> # 以下を $PROFILE に追記（notepad $PROFILE で編集）
> [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
> chcp 65001 > $null
> ```

### 4.5 Bunのインストール

```powershell
# PowerShell で実行（管理者権限不要）
irm bun.sh/install.ps1 | iex
```

インストール後、ターミナルを再起動して確認:
```powershell
bun --version
```

> **注意:** Bunのインストール先はユーザーごとに異なります。
> 一般的には `C:\Users\<ユーザー名>\.bun\bin\bun.exe` です。
> 以降 `<bunパス>` と表記します。

### 4.6 認証トークンの決定

クロスネットワーク通信では、不正なアクセスを防ぐために共通の認証トークンを使います。
**全員が同じトークンを使う必要があります。**

例: `peers2025`（任意の文字列でOK。チーム内で共有してください）

→ 以降 `<トークン>` と表記

### 4.7 再起動対策の準備（推奨）

構築中はClaude Codeの再起動が頻繁に発生します（MCP登録後、設定変更後など）。
再起動のたびにセッションのコンテキストが失われ、0から状況説明をやり直すことになります。

**対策:** 再起動前に「引き継ぎプロンプト」を生成するスキルまたは習慣を用意してください。

> **例:** 再起動前にClaudeに以下を依頼する:
> 「今のセッションの状況を要約して、再起動後にそのまま貼れるリジュームプロンプトを生成して」
>
> Claudeが出力した要約文をメモ帳にコピーしておき、再起動後のセッションにそのまま貼り付ければ
> スムーズに作業を再開できます。

---

## 5. ブローカーPC のセットアップ

> **ブローカーPCは1台だけです。** 常時起動しているPC、または最も安定したPCを選んでください。

### 5.1 リポジトリのクローン

```powershell
cd ~
git clone https://github.com/mokumeshi/claude-peers-mcp.git
cd claude-peers-mcp
bun install
```

### 5.2 ブローカーの起動

```powershell
# PowerShell で実行
chcp 65001

$env:CLAUDE_PEERS_HOST = "0.0.0.0"
$env:CLAUDE_PEERS_TOKEN = "<トークン>"
& "<bunパス>" "$HOME\claude-peers-mcp\broker.ts"
```

**パラメータ説明:**
| 環境変数 | 値 | 説明 |
|----------|-----|------|
| `CLAUDE_PEERS_HOST` | `0.0.0.0` | 全ネットワークインターフェースでリッスン（必須） |
| `CLAUDE_PEERS_TOKEN` | 任意の文字列 | Bearer認証トークン。全PCで統一する |

**起動成功時の出力:**
```
[broker] listening on 0.0.0.0:7899
```

> **重要:** このPowerShellウィンドウは閉じないでください。ブローカーが停止します。
> バックグラウンド実行したい場合は、別途サービス化するか、タスクスケジューラに登録してください。

### 5.3 ファイアウォールの確認

別のPCからブローカーに到達できることを確認します。

**クライアントPC側から実行:**
```powershell
curl http://<ブローカーIP>:7899/health
```

**期待される応答:**
```json
{"status":"ok"}
```

応答がない場合 → [8.1 ブローカーに接続できない](#81-ブローカーに接続できない) を参照

### 5.4 ブローカーPCでのMCPサーバー登録

ブローカーPC自身もClaude Codeを使う場合は、MCPサーバーも登録します。

```powershell
claude mcp add --scope user --transport stdio claude-peers -- "<bunパス>" "$HOME\claude-peers-mcp\server.ts"
```

> **注意:** ブローカーPCのserver.tsはlocalhostでbrokerに接続するため、
> `CLAUDE_PEERS_BROKER` 環境変数の設定は不要です（デフォルトで `http://127.0.0.1:7899`）。
> ただし、トークンは必要です:
> ```powershell
> claude mcp add --scope user --transport stdio --env CLAUDE_PEERS_TOKEN=<トークン> claude-peers -- "<bunパス>" "$HOME\claude-peers-mcp\server.ts"
> ```

---

## 6. クライアントPC のセットアップ

> **クライアントPC = ブローカー以外の全PC。** 台数に制限はありません。

### 6.1 リポジトリのクローン

```powershell
cd ~
git clone https://github.com/mokumeshi/claude-peers-mcp.git
cd claude-peers-mcp
bun install
```

### 6.2 MCP サーバーの登録

```powershell
claude mcp add --scope user --transport stdio --env CLAUDE_PEERS_TOKEN=<トークン> --env CLAUDE_PEERS_BROKER=http://<ブローカーIP>:7899 claude-peers -- "<bunパス>" "$HOME\claude-peers-mcp\server.ts"
```

**パラメータ説明:**
| パラメータ | 説明 |
|-----------|------|
| `--scope user` | ユーザー全体で有効（どのディレクトリからでも使える） |
| `--transport stdio` | 標準入出力でClaude Codeと通信 |
| `--env CLAUDE_PEERS_TOKEN=...` | 認証トークン（ブローカーと同じ値） |
| `--env CLAUDE_PEERS_BROKER=...` | ブローカーのURL |
| `claude-peers` | MCPサーバー名 |
| `-- "<bunパス>" "server.tsパス"` | 実行コマンド |

### 6.3 登録の確認

```powershell
# PowerShell で実行（.claude.jsonの場所はアカウントにより異なる）
cat ~/.claude.json | Select-String "claude-peers"
```

`mcpServers` セクションに `claude-peers` が含まれていればOKです。

### 6.4 Claude Code の再起動

**MCP登録後は必ずClaude Codeを完全に終了→再起動してください。**
再起動しないとMCPサーバーがロードされません。

```powershell
chcp 65001
claude
```

---

## 7. 動作確認

### 7.1 ツールの可視性確認

Claude Codeセッション内で以下を試してください:

> 「list_peersツールを使って、networkスコープでピア一覧を表示して」

**成功時:** 他のPCのClaude Codeセッションが表示される
```
Found 1 peer(s) (scope: network):

ID: abc12345
  PID: 12345
  Machine: DESKTOP-XXXXX
  CWD: C:/Users/taro/Desktop/project
  Summary: 作業内容の説明
  Last seen: 2026-04-02T12:00:00.000Z
```

**失敗時:** [8. トラブルシューティング](#8-トラブルシューティング) を参照

### 7.2 メッセージ送信テスト

PC-A から PC-B にメッセージを送信:

> 「ピア abc12345 に "テストメッセージです" と送信して」

### 7.3 リアルタイム受信テスト

PC-B 側で **何も操作しなくても** 以下のようなメッセージが会話に自動表示されれば成功:

```
<channel source="claude-peers" from_id="xyz67890" ...>
テストメッセージです
</channel>
```

> **ポイント:** リアルタイム受信はserver.tsのポーリング機構で実現されています。
> `check_messages` ツールを手動実行する必要はありません。

### 7.4 双方向テスト

PC-B → PC-A の方向でもメッセージを送り、双方向で受信できることを確認してください。

---

## 8. トラブルシューティング

### 8.1 ブローカーに接続できない

**症状:** `curl http://<ブローカーIP>:7899/health` が応答しない

**原因と対策:**

| 原因 | 対策 |
|------|------|
| ブローカーが起動していない | [5.2](#52-ブローカーの起動) を再実行 |
| ファイアウォールがブロック | Windowsファイアウォールでポート7899のインバウンドルールを追加 |
| `CLAUDE_PEERS_HOST` が `0.0.0.0` でない | 環境変数を確認。`127.0.0.1` だとローカルのみ |
| IPアドレスが間違っている | `ipconfig` で再確認 |

**ファイアウォール設定（PowerShell 管理者権限）:**
```powershell
New-NetFirewallRule -DisplayName "claude-peers broker" -Direction Inbound -Protocol TCP -LocalPort 7899 -Action Allow
```

### 8.2 MCP ツールが表示されない

**症状:** Claude CodeでToolSearchしても `list_peers` 等が見つからない

**原因と対策:**

| 原因 | 対策 |
|------|------|
| MCP未登録 | `claude mcp add` を再実行 |
| Claude Code未再起動 | 完全に終了→再起動 |
| Bunのパスが間違っている | `where bun` でパスを確認し、絶対パスで指定 |
| server.tsのパスが間違っている | クローン先のフルパスを確認 |
| 日本語ユーザー名のパス問題 | パスにスペースがある場合は `"` で囲む |

**確認コマンド:**
```powershell
# Bunの場所
where.exe bun

# server.tsの場所
dir "$HOME\claude-peers-mcp\server.ts"

# MCP登録状況
cat ~/.claude.json
```

### 8.3 ピアが一覧に表示されない

**症状:** `list_peers` で相手が見えない

**原因と対策:**

| 原因 | 対策 |
|------|------|
| 相手のClaude Codeが未起動 | 相手に起動を依頼 |
| スコープが `machine` になっている | `network` スコープで検索 |
| トークンが不一致 | 全PCで同じ `CLAUDE_PEERS_TOKEN` を使っているか確認 |
| ブローカーに到達できない | 相手PCから `curl http://<ブローカーIP>:7899/health` を確認 |
| ピアがstale判定で削除された | server.tsのheartbeatは自動送信（15秒間隔）。ブローカーのstale閾値: ローカル90秒 / リモート300秒 |

### 8.4 メッセージが文字化けする

**症状:** 受信メッセージが `���낤PC...` のような文字列

**原因:** WindowsのデフォルトコードページがCP932（Shift_JIS）

**対策:**
```powershell
chcp 65001
```
実行後にClaude Codeを再起動。[4.4](#44-文字コードの設定windows必須) の恒久対策も参照。

### 8.5 認証エラー（401）

**症状:** `Broker authentication failed. Check CLAUDE_PEERS_TOKEN.`

**原因:** クライアントとブローカーのトークンが不一致

**対策:**
1. ブローカー起動時の `$env:CLAUDE_PEERS_TOKEN` を確認
2. クライアント側の `claude mcp add` で指定した `--env CLAUDE_PEERS_TOKEN=...` を確認
3. 不一致なら、クライアント側で再登録:
   ```powershell
   claude mcp remove claude-peers
   claude mcp add --scope user --transport stdio --env CLAUDE_PEERS_TOKEN=<正しいトークン> --env CLAUDE_PEERS_BROKER=http://<ブローカーIP>:7899 claude-peers -- "<bunパス>" "server.tsパス"
   ```
4. Claude Codeを再起動

### 8.6 メッセージがリアルタイムで検知されない

**症状:** `send_message` は成功するが、相手側で自動表示されない。`check_messages` を手動実行しないと見えない

**原因:** server.tsがMCPサーバーとして登録されていない。CLIやフック経由では自動検知不可

**仕組みの解説:**
```
リアルタイム検知の流れ:
  server.ts (MCP) → 1秒ごとにbrokerをポーリング
                   → 新メッセージ発見
                   → MCP notification (notifications/claude/channel) 送信
                   → Claude Codeが <channel> タグとして会話に自動注入
```

**対策:** `claude mcp add` でserver.tsを登録し、Claude Codeを再起動する（[6.2](#62-mcp-サーバーの登録) を参照）

### 8.7 Windows固有の注意点

| 問題 | 対策 |
|------|------|
| PowerShellで `&&` が使えない | `;` で区切る（例: `chcp 65001; claude`） |
| `claude` コマンドが見つからない | `claude.cmd` を使う。またはフルパスで指定 |
| パスの区切り文字 | PowerShellでは `\` と `/` どちらでもOK。環境変数内では `\\` でエスケープ不要 |
| 日本語ユーザー名 | 一部ツールでURL-encode問題あり。修正版server.tsで対処済み |

---

## 9. 運用Tips

### 9.1 ブローカーの常時起動

タスクスケジューラに登録すると、PC起動時に自動でブローカーが立ち上がります。

1. 以下の内容で `start_broker.bat` を作成:
   ```bat
   @echo off
   chcp 65001 > nul
   set CLAUDE_PEERS_HOST=0.0.0.0
   set CLAUDE_PEERS_TOKEN=<トークン>
   "<bunパス>" "%USERPROFILE%\claude-peers-mcp\broker.ts"
   ```
2. タスクスケジューラで「ログオン時に実行」として登録

### 9.2 summaryの活用

Claude Codeが起動したら、最初に `set_summary` で自分の作業内容を宣言すると、
他のピアが `list_peers` したときに誰が何をしているかすぐわかります。

> 「set_summaryで "サムネイルレビュー担当" と設定して」

### 9.3 アップデート方法

新しいバージョンがリリースされた場合:

```powershell
cd ~/claude-peers-mcp
git pull origin main
bun install
```

その後、Claude Codeを再起動すれば反映されます。
ブローカーPCの場合は、ブローカーも再起動してください。

### 9.4 複数アカウントでの利用

1台のPCで複数のClaude Codeアカウントを使う場合、各アカウントの `.claude.json` にMCP設定が必要です。

```
アカウント1: ~/.claude.json
アカウント2: ~/.claude-account2/.claude.json
アカウント3: ~/.claude-account3/.claude.json
```

`claude mcp add` は **現在ログイン中のアカウント** の設定ファイルに書き込みます。
各アカウントでログインした状態で個別に `claude mcp add` を実行してください。

---

## 10. VPS構成（拠点間・リモート接続）

家と会社など**拠点をまたぐ構成**では、LAN内ブローカーでは以下の問題が発生します:

| 問題 | 説明 |
|------|------|
| NAT越え | 家のローカルIPに会社からアクセスできない |
| セキュリティポリシー | 会社のFWが外部ポートへの接続をブロック |
| 単一障害点 | ブローカーPCがスリープ/シャットダウンすると全体停止 |

**解決策: VPS（Virtual Private Server）にブローカーを設置する**

### 10.1 構成図

```
  家 (2台)                   VPS (クラウド)              会社 (8台)
  ┌──────────┐              ┌─────────────────┐        ┌──────────┐
  │ PC-A     │──HTTPS/HTTP─►│  broker.ts      │◄─HTTP──│ PC-C     │
  │ PC-B     │──────────────►│  ポート 7899    │◄───────│ PC-D     │
  └──────────┘              │  常時稼働       │        │ ...      │
                            │  固定グローバルIP│        │ PC-J     │
                            └─────────────────┘        └──────────┘
```

### 10.2 VPSの選定

| サービス | プラン | 月額 | スペック | 備考 |
|----------|--------|------|----------|------|
| ConoHa VPS | 512MB | 約500円 | 1vCPU / 512MB RAM | コスパ最良。broker.tsには十分 |
| さくらVPS | 512MB | 約590円 | 1vCPU / 512MB RAM | 安定性重視 |
| AWS Lightsail | nano | $3.50 | 1vCPU / 512MB RAM | AWS慣れしている場合 |

> **broker.tsの消費リソース:** SQLite + HTTPサーバーのみ。10台程度なら512MB RAMで余裕です。

### 10.3 VPSの初期設定

```bash
# VPSにSSHでログイン
ssh root@<VPSのIP>

# Bunのインストール
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# リポジトリのクローン
cd ~
git clone https://github.com/mokumeshi/claude-peers-mcp.git
cd claude-peers-mcp
bun install
```

### 10.4 ブローカーの起動（systemd でデーモン化）

**サービスファイルの作成:**
```bash
cat > /etc/systemd/system/claude-peers-broker.service << 'EOF'
[Unit]
Description=claude-peers broker daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/claude-peers-mcp
Environment=CLAUDE_PEERS_HOST=0.0.0.0
Environment=CLAUDE_PEERS_TOKEN=<トークン>
ExecStart=/root/.bun/bin/bun /root/claude-peers-mcp/broker.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

**起動と自動起動の有効化:**
```bash
systemctl daemon-reload
systemctl enable claude-peers-broker
systemctl start claude-peers-broker

# 状態確認
systemctl status claude-peers-broker

# ログ確認
journalctl -u claude-peers-broker -f
```

### 10.5 セキュリティ設定

VPSのブローカーはインターネットに公開されるため、以下のセキュリティ対策を**必ず**実施してください。

**1. 強力なトークンを使う:**
```bash
# ランダムな32文字トークンを生成
openssl rand -base64 32
# 出力例: a3Kx9mPqR7vB2nL5wJ8dF4hG6tY0sE1c
```

短いトークン（`peers2025` 等）はLAN内限定にしてください。VPSでは推測されやすく危険です。

**2. ファイアウォール（ufw）:**
```bash
ufw allow 22/tcp      # SSH
ufw allow 7899/tcp    # claude-peers broker
ufw enable
```

**3. fail2ban（推奨）:**
大量の不正アクセスを自動ブロック。
```bash
apt install fail2ban
```

**4. HTTPS化（任意・推奨）:**
トークンが平文で流れるのを防ぐため、リバースプロキシ（nginx + Let's Encrypt）でHTTPS化を推奨。

```bash
apt install nginx certbot python3-certbot-nginx

# nginx設定例
cat > /etc/nginx/sites-available/claude-peers << 'EOF'
server {
    listen 443 ssl;
    server_name peers.example.com;

    ssl_certificate /etc/letsencrypt/live/peers.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/peers.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7899;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

ln -s /etc/nginx/sites-available/claude-peers /etc/nginx/sites-enabled/
certbot --nginx -d peers.example.com
systemctl restart nginx
```

HTTPS化した場合、クライアントの接続先は:
```
CLAUDE_PEERS_BROKER=https://peers.example.com
```

### 10.6 クライアントPCの設定（VPS向け）

各PCでのMCP登録コマンドが変わります:

```powershell
# HTTP接続の場合
claude mcp add --scope user --transport stdio --env CLAUDE_PEERS_TOKEN=<強力なトークン> --env CLAUDE_PEERS_BROKER=http://<VPSのIP>:7899 claude-peers -- "<bunパス>" "~/claude-peers-mcp/server.ts"

# HTTPS接続の場合
claude mcp add --scope user --transport stdio --env CLAUDE_PEERS_TOKEN=<強力なトークン> --env CLAUDE_PEERS_BROKER=https://peers.example.com claude-peers -- "<bunパス>" "~/claude-peers-mcp/server.ts"
```

### 10.7 LAN構成からVPS構成への移行

既にLAN内ブローカーで運用中の場合の移行手順:

1. VPSにbrokerをセットアップ（10.3〜10.5）
2. 全クライアントPCでMCP再登録:
   ```powershell
   claude mcp remove claude-peers
   claude mcp add --scope user --transport stdio --env CLAUDE_PEERS_TOKEN=<新トークン> --env CLAUDE_PEERS_BROKER=http://<VPSのIP>:7899 claude-peers -- "<bunパス>" "server.tsパス"
   ```
3. 全Claude Codeセッションを再起動
4. LAN内ブローカーを停止

### 10.8 VPS構成の注意点

| 項目 | 説明 |
|------|------|
| レイテンシ | LAN（<1ms）→ VPS（10-50ms）に増加。体感にはほぼ影響なし |
| staleタイムアウト | リモートピアは300秒（5分）。VPS構成では全員がリモート扱い |
| 通信量 | ポーリング1秒間隔 × ピア数。10台なら月数GB程度。VPSの帯域制限に注意 |
| 障害時 | VPSが落ちると全員が通信不能。VPSの稼働率SLAを確認 |
| 会社FW | HTTPSなら通常許可される。HTTP:7899はブロックされる可能性あり |

---

## 11. 用語集

| 用語 | 説明 |
|------|------|
| **ブローカー (broker)** | メッセージの仲介を行う中央サーバー。`broker.ts` で起動する |
| **ピア (peer)** | ブローカーに接続しているClaude Codeセッション1つ1つ |
| **MCPサーバー** | Claude Codeに機能（ツール）を追加する仕組み。`server.ts` がこれにあたる |
| **channel notification** | MCPサーバーからClaude Codeにリアルタイムで情報をプッシュする仕組み |
| **スコープ (scope)** | ピア検索の範囲。`machine`=同じPC、`directory`=同じフォルダ、`repo`=同じGitリポ、`network`=LAN全体 |
| **heartbeat** | ピアが「まだ生きている」ことをブローカーに通知する定期信号（15秒間隔、自動） |
| **stale** | heartbeatが途絶えたピア。ローカル90秒 / リモート300秒で自動削除される |
| **トークン** | ブローカーへのアクセスを制限するパスワード的な文字列 |

---

## クイックリファレンスカード

```
■ ブローカー起動（ブローカーPCのみ）
  chcp 65001
  $env:CLAUDE_PEERS_HOST="0.0.0.0"
  $env:CLAUDE_PEERS_TOKEN="<トークン>"
  & "<bunパス>" "~/claude-peers-mcp/broker.ts"

■ MCP登録（全PC共通）
  claude mcp add --scope user --transport stdio \
    --env CLAUDE_PEERS_TOKEN=<トークン> \
    --env CLAUDE_PEERS_BROKER=http://<ブローカーIP>:7899 \
    claude-peers -- "<bunパス>" "~/claude-peers-mcp/server.ts"

■ ヘルスチェック
  curl http://<ブローカーIP>:7899/health

■ MCP削除（再登録時）
  claude mcp remove claude-peers

■ 環境変数一覧
  CLAUDE_PEERS_HOST   : ブローカーのリッスンアドレス（0.0.0.0推奨）
  CLAUDE_PEERS_TOKEN  : 認証トークン（全PC統一）
  CLAUDE_PEERS_PORT   : ブローカーポート（デフォルト: 7899）
  CLAUDE_PEERS_BROKER : ブローカーURL（クライアント側で指定）
```

---

*このマニュアルは claude-peers v11（cross-network対応版）に基づいています。*
*問題が解決しない場合は、ブローカーPC担当者に連絡してください。*
