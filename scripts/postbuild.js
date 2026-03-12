// Stamps #!/usr/bin/env node onto dist/index.js after tsc strips it,
// then makes it executable.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, '..', 'dist', 'index.js');

const src = fs.readFileSync(entry, 'utf8');
if (!src.startsWith('#!')) {
  fs.writeFileSync(entry, `#!/usr/bin/env node\n${src}`);
}
fs.chmodSync(entry, 0o755);
console.log('postbuild: shebang stamped + chmod +x dist/index.js');
