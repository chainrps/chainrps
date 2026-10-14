import sqlite3
for path in [r'C:\BtSoft\panel\data\default.db', r'C:\BtSoft\panel\data\db\default.db']:
    print(f'=== {path} ===')
    try:
        c = sqlite3.connect(path)
        cur = c.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [t[0] for t in cur.fetchall()]
        print(f'Tables: {tables}')
        if 'users' in tables:
            cur.execute('SELECT username,password,salt FROM users')
            for row in cur.fetchall():
                print(f'USER: {row}')
        c.close()
    except Exception as e:
        print(f'ERR: {e}')
