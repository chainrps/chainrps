"""重置 Go 版宝塔密码为正确加密方式"""
import sqlite3, hashlib, os, time

NEW_PWD = "chainrps123"

os.system('taskkill /F /IM btPanel.exe 2>nul')
time.sleep(2)

conn = sqlite3.connect(r'C:\BtSoft\panel\data\db\panel.db')
cur = conn.cursor()

# 宝塔传统 Python 版加密链:
# step1 = md5(password).upper()  (大写)
# step2 = md5(step1 + salt)       (拼接盐)
# Go版可能沿用这个或者简化

# 方案A: 直接 md5(password), salt=""
a = hashlib.md5(NEW_PWD.encode()).hexdigest().lower()

# 方案B: md5(password).upper(), salt=""
b = hashlib.md5(NEW_PWD.encode()).hexdigest().upper()

# 方案C: md5(md5(password).upper() + ""), salt=""  (传统链但无盐)
c = hashlib.md5((hashlib.md5(NEW_PWD.encode()).hexdigest().upper() + "").encode()).hexdigest()

print(f"方案A (直接md5小写): {a}")
print(f"方案B (直接md5大写): {b}")
print(f"方案C (传统链无盐):   {c}")

# 先试 方案A（简单直接）
print(f"\n写入 password={a}, salt=''")
cur.execute('UPDATE users SET password=?, salt="" WHERE id=1', (a,))
conn.commit()
cur.execute('SELECT username, password, salt FROM users')
print(f"确认: {cur.fetchone()}")
conn.close()

os.environ['BT_PANEL'] = r'C:\BtSoft\panel'
os.startfile(r'C:\BtSoft\panel\btPanel.exe')
print("\n✅ 已重置方案A")
