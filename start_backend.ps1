$env:PYTHONIOENCODING = "utf-8"
Set-Location "c:\git\github\chainrps"
$logOut = "c:\git\github\chainrps\backend_out.log"
$logErr = "c:\git\github\chainrps\backend_err.log"
& "c:\git\github\chainrps\.venv\Scripts\python.exe" -m uvicorn rps_backend.main:app --host 0.0.0.0 --port 8000 1> $logOut 2> $logErr
