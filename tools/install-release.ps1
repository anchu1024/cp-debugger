param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    throw "VS Code CLI 'code' がPATHにありません。"
}

if (-not (Test-Path -LiteralPath $VsixPath)) {
    throw "VSIXが見つかりません: $VsixPath"
}

code --install-extension $VsixPath --force
