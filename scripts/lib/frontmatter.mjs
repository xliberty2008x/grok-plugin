export function normalizeNewlines(value) {
  return String(value).replace(/\r\n?/g, "\n");
}

export function hasYamlFrontmatter(value) {
  const text = normalizeNewlines(value);
  return text.startsWith("---\n") && text.indexOf("\n---\n", 4) >= 0;
}
