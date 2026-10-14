import sqlite3, hashlib, os, time

NEW_PWD = "chainrps123"

# 宝塔 Go 版前端加密链:
# step1 = MD5(password).toString()
# step2 = step1 + "_bt.cn"
# step3 = MD5(step2).toString()  → 存入数据库

os.system('taskkill /F /IM btPanel.exe 2>nul')
time.sleep(2)

step1 = hashlib.md5(NEW_PWD.encode()).hexdigest().lower()
step2 = step1 + "_bt.cn"
step3 = hashlib.md5(step2.encode()).hexdigest().lower()

print(f"明文:    {NEW_PWD}")
print(f"step1:   MD5({NEW_PWD}) = {step1}")
print(f"step2:   step1 + '_bt.cn' = {step2}")
print(f"step3:   MD5({step2}) = {step3}  ← 存数据库")

conn = sqlite3.connect(r'C:\BtSoft\panel\data\db\panel.db')
cur = conn.cursor()
cur.execute('UPDATE users SET password=?, salt="" WHERE id=1', (step3,))
conn.commit()
cur.execute('SELECT username, password, salt FROM users')
print(f"\nDB已更新: {cur.fetchone()}")
conn.close()

# 同步改 default.pl（repair_panel 会读这个）
with open(r'C:\BtSoft\panel\data\default.pl', 'w') as f:
    f.write(NEW_PWD)

os.environ['BT_PANEL'] = r'C:\BtSoft\panel'
os.startfile(r'C:\BtSoft\panel\btPanel.exe')

print("\n✅ 面板已重启，等 5 秒再登录...")
print(f"URL:      http://170.106.115.16:8888/NUzNHvxO")
print(f"用户名:   E379DrrQ")
print(f"密码:     {NEW_PWD}")
