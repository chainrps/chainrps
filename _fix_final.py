import sqlite3, hashlib, os, time

NEW_PWD = "chainrps123"

# 先停面板
os.system('taskkill /F /IM btPanel.exe 2>nul')
time.sleep(2)

conn = sqlite3.connect(r'C:\BtSoft\panel\data\db\panel.db')
cur = conn.cursor()

# 读当前
cur.execute('SELECT username, password, salt FROM users')
row = cur.fetchone()
print(f"当前: user={row[0]}, pwd={row[1]}, salt={row[2]}")

# 宝塔加密方式: md5(md5(password).lower() + salt)
# 简化处理: 直接存 md5(password)，salt 清空
md5_pwd = hashlib.md5(NEW_PWD.encode()).hexdigest().lower()
print(f"新密码: {NEW_PWD} -> md5={md5_pwd}")

cur.execute('UPDATE users SET password=?, salt="" WHERE id=1', (md5_pwd,))
conn.commit()

cur.execute('SELECT username, password, salt FROM users')
row = cur.fetchone()
print(f"更新后: user={row[0]}, pwd={row[1]}, salt={row[2]}")

conn.close()

# 启动面板
os.environ['BT_PANEL'] = r'C:\BtSoft\panel'
os.startfile(r'C:\BtSoft\panel\btPanel.exe')
print("\n✅ 面板已重启")
print(f"URL: http://170.106.115.16:8888/NUzNHvxO")
print(f"用户名: E379DrrQ")
print(f"密码: {NEW_PWD}")
