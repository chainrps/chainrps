import subprocess, sys, os
env = os.environ.copy()
extra = r"C:\Program Files\nodejs;" + os.environ.get("APPDATA", "") + r"\npm;C:\Program Files\Git\cmd;"
env["PATH"] = extra + env.get("PATH", "")
DETACHED = 0x00000008
NEW_GROUP = 0x00000200
subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "rps_backend.main:app", "--host", "0.0.0.0", "--port", "8000"],
    cwd=r"c:\git\github\chainrps",
    env=env,
    creationflags=DETACHED | NEW_GROUP,
    close_fds=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
print("spawned")
