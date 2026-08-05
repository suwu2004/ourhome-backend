from pathlib import Path

path = Path('readingStore.js')
text = path.read_text(encoding='utf-8')

import_line = "const { registerReadingAnnotationRoutes } = require('./readingAnnotations');\n"
if import_line not in text:
    text = import_line + text

anchor = "function registerReadingRoutes(app, { supabase, upload }) {\n  const store = createReadingStore(supabase);"
replacement = "function registerReadingRoutes(app, { supabase, upload }) {\n  const store = createReadingStore(supabase);\n  registerReadingAnnotationRoutes(app, { supabase });"
if anchor not in text:
    raise SystemExit('reading route registration anchor not found')
text = text.replace(anchor, replacement, 1)

path.write_text(text, encoding='utf-8')
