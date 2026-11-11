// Shared by Electron and the UI. This module has no Node-only dependencies.
const TEXT_EXTENSIONS = [
  'md', 'markdown', 'mdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'properties', 'env', 'lock',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'mdx', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'xml', 'xmi', 'reqif', 'svg', 'xsd', 'xsl', 'xslt',
  'py', 'pyi', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'rs', 'go', 'java', 'cs',
  'swift', 'kt', 'kts', 'rb', 'php', 'r', 'lua', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'bat', 'cmd', 'patch', 'diff', 'graphql', 'gql', 'proto', 'sysml', 'kerml', 'adoc', 'rst',
  'tex', 'bib', 'cmake', 'map', 'gitignore', 'gitattributes', 'editorconfig',
];
const extensions = new Set(TEXT_EXTENSIONS);
const labels = {
  ts: 'TypeScript', tsx: 'TSX', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', jsonl: 'JSON Lines', ndjson: 'JSON Lines', yaml: 'YAML', yml: 'YAML',
  py: 'Python', pyi: 'Python', c: 'C', h: 'C header', cpp: 'C++', cc: 'C++', hpp: 'C++ header',
  sql: 'SQL', css: 'CSS', html: 'HTML', htm: 'HTML', xml: 'XML', xmi: 'XML / XMI',
  reqif: 'ReqIF', svg: 'SVG source', csv: 'CSV', tsv: 'TSV', mdx: 'MDX',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', toml: 'TOML',
  patch: 'Patch', diff: 'Diff', sysml: 'SysML', kerml: 'KerML',
};
const basename = value => value.split(/[\\/]/).pop().toLowerCase();
const extension = value => basename(value).match(/\.([^.]+)$/)?.[1] || '';
const isMarkdown = value => ['md', 'markdown', 'mdown'].includes(extension(value));

function isTextFile(value) {
  const name = basename(value);
  if (name === '.ds_store') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (['dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'license', 'notice', 'readme', '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.npmrc', '.nvmrc', '.node-version', '.python-version', '.prettierignore', '.eslintignore'].includes(name)) return true;
  return extensions.has(extension(value)) || !name.includes('.');
}

function fileLabel(value) {
  if (isMarkdown(value)) return 'Markdown';
  return labels[extension(value)] || 'Plain text';
}

const syntaxLanguages = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonl: 'json', ndjson: 'json', yaml: 'yaml', yml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', xmi: 'xml', reqif: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', py: 'python', pyi: 'python',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  rs: 'rust', go: 'go', java: 'java', cs: 'csharp', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', r: 'r', lua: 'lua', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', toml: 'ini', ini: 'ini', properties: 'ini', env: 'ini', editorconfig: 'ini',
  patch: 'diff', diff: 'diff', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mdx: 'markdown',
  tex: 'latex', bib: 'latex', adoc: 'asciidoc',
};

function syntaxLanguage(value) {
  const name = basename(value);
  if (name === 'dockerfile' || name === 'containerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  return syntaxLanguages[extension(value)] || null;
}

module.exports = { TEXT_EXTENSIONS, isMarkdown, isTextFile, fileLabel, syntaxLanguage };
