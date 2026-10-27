import sys

path = r'D:\Git\github\chainrps\chainrps\rps_backend\service\room_service.py'
with open(path, encoding='utf-8') as f:
    lines = f.readlines()

start_idx = None
for i, l in enumerate(lines):
    if l.startswith('    def leave_room(self'):
        start_idx = i
        break

if start_idx is None:
    print('not found')
    sys.exit(1)

end_idx = None
for i in range(start_idx + 1, len(lines)):
    if (lines[i].startswith('    def ') or lines[i].startswith('    async def ')) and not lines[i].startswith('    #'):
        end_idx = i - 1
        break

print(f'leave_room body: lines {start_idx+1} to {end_idx+1} (0-indexed: {start_idx} to {end_idx})')

# The original docstring end + first code line
# We need to find the line with 'room = self._rooms.get(room_id)' in leave_room
body_start = None
for i in range(start_idx, end_idx + 1):
    stripped = lines[i].lstrip()
    if stripped.startswith('room = self._rooms.get(room_id)'):
        body_start = i
        break

print(f'First code line at {body_start + 1}: {lines[body_start].rstrip()}')

# Find all return lines in this function
returns = []
for i in range(body_start, end_idx + 1):
    stripped = lines[i].lstrip()
    if stripped.startswith('return '):
        returns.append(i)
print(f'Return lines ({len(returns)}):')
for r in returns:
    print(f'  {r+1}: {lines[r].rstrip()}')

# Strategy: replace body_start line with:
#   check + add + try: + original line
# Then append finally at end
# But we also need to indent ALL existing body lines by 4 spaces

# Actually simpler approach:
# Insert after docstring: check + add + try:
# Then at end of function: finally: + discard
# And indent everything between try: and finally: by 4

# Let's indent body first
indented = []
for i in range(body_start, end_idx + 1):
    indented.append('    ' + lines[i])  # 4 extra spaces

# Build new content
before = lines[:body_start]  # everything before first code line
# Check what's at body_start - should be 'room = self._rooms.get...'

lock_header = (
    '        if room_id in self._leaving_rooms:\n'
    '            return {"success": False, "message": "正在处理中，请稍后"}\n'
    '        self._leaving_rooms.add(room_id)\n'
    '        try:\n'
)

finally_block = (
    '        finally:\n'
    '            self._leaving_rooms.discard(room_id)\n'
)

after = lines[end_idx + 1:]  # next function etc.

new_content = (
    ''.join(before)
    + lock_header
    + ''.join(indented)
    + finally_block
    + ''.join(after)
)

with open(path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print('Done')