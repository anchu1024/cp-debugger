# Competitive Debugger

LLMを使わず、ローカルのGCCと決定論的なソース変換・実行時チェックだけで競プロのデバッグを支援するVS Code拡張です。

[最新リリース](https://github.com/anchu1024/cp-debugger/releases/tag/v0.4.0)の使用が推奨されています。

## 0.4.1

ループの安全性と二分探索前のソートが行われてるかを静的にチェックする機能が実験的に追加されました。必ずしもすべてのケースを補完するわけではないのでご了承ください。

## Commands

- `Ctrl+Alt+D`: カーソル位置の変数/式へデバッグ出力を追加
- `Ctrl+Alt+C`: CP Debuggerが生成したデバッグ出力を削除
- `Ctrl+Alt+R`: GCC-firstでコンパイル・実行・診断

Debug Printはスカラー、`string`、`pair`、`tuple`、および反復可能なコンテナを共通formatterで出力します。生成コードは `CPDBG-BEGIN/END` マーカーで管理され、ユーザー自身の `cerr` は削除しません。

## Static diagnostics

診断時はtokenizeとscope/symbol情報を使い、Problemsへrule ID付きの警告を表示します。`CP001` は初期化前に読み取られる可能性のあるローカル整数、`CP002` は負数/既知サイズ超過の添字や、サイズと一致するinclusive loopの境界アクセス、`CP003` は未整列と判断されるコンテナへのbinary searchを対象にします。CP003は `sort` / `ranges::sort` と代表的な変更操作を追跡します。誤警告を抑えるため、確実に判断できないケースは警告しません。

## Compiler

既定では `g++` を使用します。AtCoderと同じコンパイラを指定したい場合は、VS Codeのsettings.jsonでフルパスを設定できます。

```json
{
  "cpDebugger.compiler": "C:\\Program Files (x86)\\mingw64\\bin\\g++.exe",
  "cpDebugger.cxxStandard": "gnu++23",
  "cpDebugger.debugMode": "auto",
  "cpDebugger.enableSanitizers": true
}
```

`debugMode: auto` は次の順です。

1. 設定されたg++だけでASan+UBSanの実コンパイル/リンク/起動プローブ
2. 成功したらSanitizer付きg++で本番デバッグビルド
3. 失敗したら `_GLIBCXX_DEBUG` + `_GLIBCXX_ASSERTIONS` へフォールバック

**別のコンパイラへ自動切替しません。**

## Input

空なら `<source>.in` を使います。

例:

```text
main.cpp
main.in
```

## GitHub marker

`cpDebugger.repositoryUrl` が設定されていればそのURLを使います。空の場合、現在のワークスペースのGit remoteを読み取り、`github.com` のremoteならそのURLを自動使用します。

デバッグ機能を使ったとき、ソース先頭に無ければ次を追加します。

```cpp
// CP Debugger Repository: https://github.com/...
// CP Debugger Version: 0.2.2
```

このリンクは「非AIであることの数学的/法的証明」ではなく、**使用したツールの実装を公開して透明性を高めるためのマーカー**です。

## GitHub管理とVSIX

VSIX本体を毎回Gitで管理する必要はありません。推奨は次です。

```text
Git repository
├─ package.json       # versionの正本
├─ extension/
│  └─ extension.js
├─ .github/workflows/
│  └─ release.yml     # tagからVSIXを生成
└─ tools/
   └─ install-release.ps1
```

バージョンを `package.json` で上げて、例えば `v0.2.3` のGit tagを打つとGitHub ActionsでVSIXを作る構成にしています。

同じ `publisher + name` を維持すれば、VSIXをインストールしても別の拡張として増殖させず、既存拡張の更新として扱えます。VS Code CLIはVSIXの指定を「install or update」として提供しています。

```powershell
code --install-extension .\cp-debugger-0.2.2.vsix --force
```

VSIXから入れた拡張は自動更新が既定で無効なので、GitHub Releaseから更新する場合はこのコマンド、または `tools/install-release.ps1` を使います。

## Development

```bash
npm install
npm test
npm run package
```

VS Codeから `F5` でExtension Development Hostを起動できます。

### GitHub Actions / VSIX

このリポジトリは `package-lock.json` を必須にしません。VSIXの生成だけに `@vscode/vsce` の固定バージョンを `npx` で使用します。GitHub Actionsではnpmキャッシュを無効にしているため、lockfile不足で止まりません。スモークテストは固定バージョンをハードコードせず、GitHub Actionsでは `GITHUB_REF_NAME` と `package.json` を比較します。

リリースは `package.json` の `version` とGit tagを一致させて作ります。例えば `0.2.3` に更新したら:

```bash
git add .
git commit -m "Release 0.2.2"
git tag v0.2.2
git push origin main
git push origin v0.2.2
```

GitHub ActionsがVSIXを作ってGitHub Releaseへ添付します。VSIX自体はGit管理しません。 `.gitignore` の `*.vsix` で除外しています。
