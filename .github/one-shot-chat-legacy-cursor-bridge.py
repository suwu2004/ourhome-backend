from pathlib import Path

path = Path('server.js')
text = path.read_text()
old = "  if (paging.before) query = query.lte('created_at', paging.before.createdAt);\n"
new = """  if (paging.before) {
    query = paging.before.legacyExclusive
      ? query.lt('created_at', paging.before.createdAt)
      : query.lte('created_at', paging.before.createdAt);
  }
"""
if old not in text:
    raise SystemExit('legacy cursor bridge anchor missing')
path.write_text(text.replace(old, new, 1))
