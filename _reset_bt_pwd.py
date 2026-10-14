"""重置宝塔面板密码为已知值"""
import sqlite3, hashlib, os

NEW_PASSWORD = "chainrps123"

# 宝塔 Go 版密码加密：md5(md5(password) + salt)
# 或直接 md5(password) 存明文 md5
# 我们用最简单：重置 salt 为空，存 md5(password)

def md5_hex(s):
    return hashlib.md5(s.encode()).hexdigest()

# 先停面板
os.system('taskkill /F /IM btPanel.exe 2>nul')
import time; time.sleep(1)

conn = sqlite3.connect(r'C:\BtSoft\panel\data\default.db')
cur = conn.cursor()

# 读当前 salt
cur.execute("SELECT id, username, password, salt FROM users")
row = cur.fetchone()
print(f"当前: user={row[1]}, pwd={row[2]}, salt={row[3]}")

# 生成新密码 hash
new_hash = md5_hex(NEW_PASSWORD)  # 直接存 md5
print(f"新密码: {NEW_PASSWORD} -> md5={new_hash}")

# 更新
cur.execute("UPDATE users SET password=?, salt='' WHERE id=1", (new_hash,))
conn.commit()

# 验证
cur.execute("SELECT id, username, password, salt FROM users")
row = cur.fetchone()
print(f"更新后: user={row[1]}, pwd={row[2]}, salt={row[3]}")

# 也更新 default.pl 让下次 repair 不覆盖
with open(r'C:\BtSoft\panel\data\default.pl', 'w') as f:
    f.write(NEW_PASSWORD)

conn.close()
print("\n✅ 密码重置完成！")

# 重启面板
os.environ['BT_PANEL'] = r'C:\BtSoft\panel'
os.startfile(r'C:\BtSoft\panel\btPanel.exe')
print("✅ 面板已重启")
