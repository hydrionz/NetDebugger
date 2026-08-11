# NetDebugger 一键构建脚本
# 用法：powershell -ExecutionPolicy Bypass -File .\build.ps1
# 作用：构建 release 版 app.exe 并复制到 dist\NetDebugger.exe

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauriDir = Join-Path $repoRoot "src-tauri"
$distDir = Join-Path $repoRoot "dist"
$builtExe = Join-Path $tauriDir "target\release\app.exe"
$outExe = Join-Path $distDir "NetDebugger.exe"

Write-Host "==> 构建 release（不打包）..." -ForegroundColor Cyan
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
