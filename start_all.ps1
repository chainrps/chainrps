# ChainRPS 一键启动脚本（Windows PowerShell）
# 启动顺序：Redis → Ganache → 后端
# 首次启动前请确保已安装：Python 3.12 / Git / Memurai / Node.js v24 / Ganache CLI

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$root       = $PSScriptRoot
$pyExe      = "$root\.venv\Scripts\python.exe"
$pywExe     = "$root\.venv\Scripts\pythonw.exe"
$nodeRoot   = "C:\Program Files\nodejs"
$npmRoot    = "$env:APPDATA\npm"
$gitRoot    = "C:\Program Files\Git\cmd"
$memuraiCli = "C:\Program Files\Memurai\memurai-cli.exe"

$env:PATH   = "$nodeRoot;$npmRoot;$gitRoot;" + $env:PATH

Write-Host "=== ChainRPS 一键启动 ===" -ForegroundColor Cyan

# ── 0. 前置检查 ────────────────────────────────────
foreach ($f in $pyExe, $memuraiCli) {
    if (-not (Test-Path $f)) { Write-Host "❌ 前置缺失: $f" -ForegroundColor Red; exit 1 }
}

# ── 1. Redis Memurai（Windows 服务，自动启动）───────
Write-Host "`n[1/3] Redis (Memurai) ..." -ForegroundColor Yellow
try {
    $r = & $memuraiCli ping 2>&1
    if ($r -match "PONG") { Write-Host "   ✅ Redis 已就绪" -ForegroundColor Green }
    else { Write-Host "   ⚠️ 未响应: $r" -ForegroundColor Red }
} catch { Write-Host "   ❌ Memurai 不可达，确认服务已启动" -ForegroundColor Red }

# ── 2. Ganache 本地链 ──────────────────────────────
Write-Host "`n[2/3] Ganache 本地链 ..." -ForegroundColor Yellow
try {
    $body = '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
    $chainId = (Invoke-RestMethod -Uri "http://127.0.0.1:8686" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 2).result
    if ($chainId -eq "0x4f7b38") { Write-Host "   ✅ Ganache 已就绪 chainId=5208888" -ForegroundColor Green }
    else { Write-Host "   ⚠️ chainId 不匹配: $chainId" -ForegroundColor Yellow }
} catch {
    Write-Host "   🔄 启动 Ganache ..." -ForegroundColor Cyan
    $dataDir  = "$root\data"
    $chainDir = "$dataDir\chaindata_ganache"
    $accFile  = "$dataDir\ganache_accounts.json"
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $args = @(
        "--server.host","127.0.0.1",
        "--server.port","8686",
        "--chain.chainId","5208888",
        "--wallet.deterministic",
        "--wallet.accountKeysPath",$accFile,
        "--database.dbPath",$chainDir,
        "--database.inMemory",$false
    )
    Start-Process -FilePath "ganache.cmd" -ArgumentList $args -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 10
    try {
        $chainId = (Invoke-RestMethod -Uri "http://127.0.0.1:8686" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 3).result
        Write-Host "   ✅ Ganache 启动成功 chainId=$chainId" -ForegroundColor Green
    } catch { Write-Host "   ❌ Ganache 启动失败" -ForegroundColor Red }
}

# ── 3. 后端（detached） ────────────────────────────
Write-Host "`n[3/3] 后端服务 ..." -ForegroundColor Yellow
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 2
    if ($h.status -eq "healthy") { Write-Host "   ✅ 后端已就绪" -ForegroundColor Green }
} catch {
    Write-Host "   🔄 启动后端 ..." -ForegroundColor Cyan
    & $pyExe "$root\_spawn.py" 2>&1 | Out-Null
    Start-Sleep -Seconds 12
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 3
        Write-Host "   ✅ 后端启动成功 redis=$($h.redis)" -ForegroundColor Green
    } catch { Write-Host "   ❌ 后端启动失败" -ForegroundColor Red }
}

# ── 总结 ────────────────────────────────────────────
Write-Host "`n=== 启动完成 ===" -ForegroundColor Cyan
Write-Host "  前端: http://127.0.0.1:8000/"
Write-Host "  文档: http://127.0.0.1:8000/docs"
Write-Host "  管理: http://127.0.0.1:8000/admin"
Write-Host "  健康: http://127.0.0.1:8000/health"
