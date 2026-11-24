import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const three = join(root, 'node_modules', 'three');
const runtimeFiles = new Map([
  ['LICENSE', 'LICENSE'],
  ['build/three.module.min.js', 'build/three.module.js'],
  ['examples/jsm/controls/OrbitControls.js', 'examples/jsm/controls/OrbitControls.js'],
  ['examples/jsm/environments/RoomEnvironment.js', 'examples/jsm/environments/RoomEnvironment.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/loaders/GLTFLoader.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/BufferGeometryUtils.js'],
]);

await mkdir(output, { recursive: true });
for (const folder of ['src', 'assets']) {
  await cp(join(root, folder), join(output, folder), { recursive: true });
}
for (const [from, to] of runtimeFiles) {
  const destination = join(output, 'vendor', 'three', to);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(three, from), destination);
}
for (const file of ['index.html', 'models.html']) {
  const source = await readFile(join(root, file), 'utf8');
  const page = source.replaceAll('./node_modules/three/', './vendor/three/')
    .replace('data-mode-entry="lan"', 'data-mode-entry="lan" hidden');
  await writeFile(join(output, file), page);
}
await writeFile(join(output, '.nojekyll'), '');
