import { mkdir, writeFile } from 'node:fs/promises';
import { Scene } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createArena, createDrone, createController } from '../src/models.js';

globalThis.FileReader ??= class {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend();
  }
};

const destination = new URL('../assets/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const [name, create] of Object.entries({
  arena: createArena,
  drone: createDrone,
  controller: createController,
})) {
  const scene = new Scene();
  create(scene);
  const buffer = await new GLTFExporter().parseAsync(scene, { binary: true });
  await writeFile(new URL(name + '.glb', destination), Buffer.from(buffer));
  console.log(name + '.glb — ' + Math.round(buffer.byteLength / 1024) + ' KiB');
}
