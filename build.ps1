# NetDebugger 一键构建脚本
# 用法：powershell -ExecutionPolicy Bypass -File .\build.ps1
# 作用：构建 release 版可执行文件，并以 NetDebugger_v{版本号}.exe 命名复制到 dist\

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauriDir = Join-Path $repoRoot "src-tauri"
$distDir = Join-Path $repoRoot "dist"
$builtExe = Join-Path $tauriDir "target\release\app.exe"

# 版本号单点维护于 Cargo.toml，构建时读取
$version = Select-String -Path (Join-Path $tauriDir "Cargo.toml") -Pattern '^version\s*=\s*"([^"]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value }
if (-not $version) {
    throw "无法从 Cargo.toml 读取版本号"
}

$outExe = Join-Path $distDir "NetDebugger_v${version}.exe"

Write-Host "==> 构建 release v${version}（不打包）..." -ForegroundColor Cyan
Push-Location $tauriDir
try {
    cargo tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build 失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $builtExe)) {
    throw "构建产物不存在：$builtExe"
}

if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

Copy-Item -LiteralPath $builtExe -Destination $outExe -Force
$size = [math]::Round((Get-Item $outExe).Length / 1MB, 1)

Write-Host ""
Write-Host "构建完成：$outExe（${size} MB）" -ForegroundColor Green
Write-Host "可直接分发此文件。"
