import sqlite3
# Go版可能用 panel.db
for dbfile in ['panel.db', 'data.db', 'default.db', 'system.db']:
    path = rf'C:\BtSoft\panel\data\db\{dbfile}'
    try:
        c = sqlite3.connect(path)
        cur = c.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [t[0] for t in cur.fetchall()]
        has_user = [t for t in tables if 'user' in t.lower() or 'admin' in t.lower() or 'account' in t.lower()]
        print(f'{dbfile}: tables={tables}, user-related={has_user}')
        for t in has_user:
            cur.execute(f'PRAGMA table_info({t})')
            cols = cur.fetchall()
            print(f'  {t} cols: {[(c[1],c[2]) for c in cols]}')
            cur.execute(f'SELECT * FROM {t} LIMIT 3')
            for row in cur.fetchall():
                print(f'  ROW: {row}')
        c.close()
    except Exception as e:
        pass

# 也查根目录
for dbfile in ['panel.db', 'default.db', 'system.db']:
    path = rf'C:\BtSoft\panel\data\{dbfile}'
    try:
        c = sqlite3.connect(path)
        cur = c.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [t[0] for t in cur.fetchall()]
        has_user = [t for t in tables if 'user' in t.lower() or 'admin' in t.lower() or 'account' in t.lower()]
        print(f'\nROOT {dbfile}: tables={tables}, user-related={has_user}')
        for t in has_user:
            cur.execute(f'SELECT * FROM {t} LIMIT 3')
            for row in cur.fetchall():
                print(f'  ROW: {row}')
        c.close()
    except Exception as e:
        pass
