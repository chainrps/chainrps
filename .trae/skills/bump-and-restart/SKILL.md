---
name: bump-and-restart
description: Bump version across all project files, git commit plus push to GitHub, then restart the backend service and verify health. Use when the user asks to bump version, update version number, release a new build, push changes then restart, or do a full deploy cycle. Do not use for code-only changes without a version bump request.
---

# Bump Version + Push + Restart

Complete the full release cycle in order: bump version → commit → push → restart backend → verify health.

## Step 1: Bump Version (patch +1, e.g. 1.0.25 → 1.0.26)

Locate the current version in all 4 files. Use Grep to find the current version string first.

Files to modify (same version string in all 4):

1. `package.json` — `"version": "X.Y.Z",` (line ~3)
2. `pyproject.toml` — `version = "X.Y.Z"` (line ~7)
3. `rps_backend/main.py` — `version="X.Y.Z",` inside FastAPI() constructor (line ~170)
4. `rps_frontend/static/html/index.html` — `ChainRPS vX.Y.Z · 公平 · 透明 · 可验证` in footer (line ~619)

Rules:
- Always bump the **patch** number (third segment). Never touch major/minor unless user explicitly asks.
- Find the highest matching version number across all 4 files first — if they are out of sync, align them all to the same target.
- `uv.lock` is auto-generated — do NOT edit it manually.

## Step 2: Git Commit + Push

```powershell
$git = "C:\Program Files\Git\cmd\git.exe"
& $git --no-pager add .                  # or stage specific files
& $git commit -m "chore: bump version to X.Y.Z"
& $git push origin master
```

Checklist before commit:
- Review `git --no-pager diff --stat` to confirm only intended files changed.
- Do NOT commit untracked binaries (BtSoft.exe, cloudflared.exe, etc.) or temp scripts (_check*.py, _fix*.py) unless user explicitly asks.

## Step 3: Restart Backend

ChainRPS backend is FastAPI + uvicorn on **port 8000**, bound to `0.0.0.0`.

### 3a. Find and stop old process

```powershell
$port = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($port) { Stop-Process -Id $port.OwningProcess -Force }
Start-Sleep -Seconds 2
# Verify port released
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
```

### 3b. Start new backend

Project venv python: `c:\git\github\chainrps\.venv\Scripts\python.exe`

**⚠️ CRITICAL: TRAE sandbox kills all child processes when session ends.**
`Start-Process`, `python _spawn.py` (DETACHED_PROCESS), and `subprocess.Popen` ALL get cleaned up.
Only **Task Scheduler** (`schtasks`) creates processes that survive — same mechanism as Ganache/Redis.

```powershell
# Kill old backend first
$old = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($old) { Stop-Process -Id $old.OwningProcess -Force; Start-Sleep -Seconds 2 }

# Launch via scheduled task (survives TRAE sandbox)
$py = "c:\git\github\chainrps\.venv\Scripts\python.exe"
$action = New-ScheduledTaskAction -Execute $py `
    -Argument "-m uvicorn rps_backend.main:app --host 0.0.0.0 --port 8000" `
    -WorkingDirectory "c:\git\github\chainrps"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "ChainRPS_Backend_AutoStart" -Action $action `
    -Trigger $trigger -Settings $settings -RunLevel Highest -Force
Start-ScheduledTask -TaskName "ChainRPS_Backend_AutoStart"
```

### 3c. Wait and health check

```powershell
Start-Sleep -Seconds 12
Invoke-WebRequest -Uri "http://127.0.0.1:8000/health" -UseBasicParsing -TimeoutSec 10
# Expect: {"status":"healthy","redis":true,...}
```

Also verify the public/network IPs are reachable:
- `http://10.4.0.16:8000/health` (internal)
- `http://<public-ip>:8000/health` (public, if security group allows)

## Step 4: Report

Summarize:
- Old version → new version
- Commit hash pushed to GitHub
- New backend PID on port 8000
- Health check result

## Known Constraints

| Constraint | Why |
|---|---|
| Python path → `c:\git\github\chainrps\.venv\Scripts\python.exe` | System `python` alias redirects to MS Store stub |
| Git path → `C:\Program Files\Git\cmd\git.exe` | Not on PATH by default in TRAE sandbox |
| uvicorn must bind `0.0.0.0:8000` | Default `127.0.0.1` blocks external access |
| Sandbox may block `Start-Process` | Fallback: `python _spawn.py` with creationflags |
| Redis must be up for healthy status | Backend depends on Redis; check separately if health fails |
| Ganache port 8686 must be running | Bot auto-room creation needs local chain |
