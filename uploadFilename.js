function decodeMojibakeFilename(value) {
  const original = String(value || '').trim();
  if (!original) return '';

  try {
    const bytes = Buffer.from(original, 'latin1');
    const recovered = bytes.toString('utf8');
    if (!recovered || recovered === original || recovered.includes('\uFFFD')) return original;
    return Buffer.from(recovered, 'utf8').equals(bytes) ? recovered : original;
  } catch {
    return original;
  }
}

function normalizeMultipartFilename(value, fallback = 'file') {
  const decoded = decodeMojibakeFilename(value) || String(fallback || 'file');
  return decoded
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim() || String(fallback || 'file');
}

module.exports = {
  decodeMojibakeFilename,
  normalizeMultipartFilename,
};
