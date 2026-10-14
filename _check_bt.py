import sqlite3, os
os.environ['BT_PANEL'] = r'C:\BtSoft\panel'
conn = sqlite3.connect(r'C:\BtSoft\panel\data\system.db')
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cur.fetchall()
print('Tables:', tables)
for t in tables:
    tname = t[0]
    try:
        cur.execute(f'PRAGMA table_info({tname})')
        cols = cur.fetchall()
        colnames = [c[1] for c in cols]
        if any(k in str(colnames).lower() for k in ['user','pass','pwd','admin','account','name']):
            print(f'\n=== {tname} ===')
            print('cols:', colnames)
            cur.execute(f'SELECT * FROM {tname} LIMIT 5')
            for r in cur.fetchall():
                print(r)
    except Exception as e:
        print(f'err {tname}: {e}')
conn.close()

# 也查 default.db
print('\n\n=== default.db ===')
conn2 = sqlite3.connect(r'C:\BtSoft\panel\data\default.db')
cur2 = conn2.cursor()
cur2.execute("SELECT name FROM sqlite_master WHERE type='table'")
for t in cur2.fetchall():
    tname = t[0]
    try:
        cur2.execute(f'PRAGMA table_info({tname})')
        cols = cur2.fetchall()
        colnames = [c[1] for c in cols]
        print(f'{tname}: {colnames}')
        cur2.execute(f'SELECT * FROM {tname} LIMIT 5')
        for r in cur2.fetchall():
            print('  ', r)
    except Exception as e:
        print(f'err {tname}: {e}')
conn2.close()
