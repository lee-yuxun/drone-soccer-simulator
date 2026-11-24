import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const models = {
  arena: {
    title: '充氣式球場',
    description: '參考 OURSTEAM TDA193 的紅藍充氣框、白色中央支柱、黑網和懸吊式電子球門。',
    specs: [
      ['場地內徑（長 × 寬 × 高）', '6 × 3 × 3 m'],
      ['充氣柱直徑', '25 cm'],
      ['球門內徑／外徑／厚度', '40 ／ 70 ／ 10 cm'],
      ['球門中心離地／距底線', '2 ／ 1 m'],
    ],
    layer: ['Safety net and zip doors', '顯示安全網'],
    direction: [5, 3.15, 8],
    front: [0, 0, 1],
    overhead: '俯視',
  },
  drone: {
    title: '球形護籠無人機',
    description: '依 IMG_1367–1369 的紅色開孔護籠與白色四旋翼機架建模。',
    specs: [['護籠標稱直徑', '約 20 cm'], ['機身細節', '四旋翼、環形 LED、電池座']],
    layer: ['Red safety cage', '顯示紅色護籠'],
    direction: [2.1, 1.46, 3.6],
    front: [0, 0, 1],
    overhead: '俯視',
  },
  controller: {
    title: 'Mode 2 遙控器',
    description: '依 IMG_1370–1371 的白色殼體、黑色雙搖桿座、銀色搖桿帽和肩部撥桿建模。',
    specs: [['左搖桿', '油門／偏航'], ['右搖桿', '俯仰／滾轉'], ['尺寸', '依照片比例估算']],
    direction: [.67, .85, 3.5],
    front: [0, 0, 1],
    overhead: '頂側',
  },
};

const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const layer = document.querySelector('#toggle-layer');
const checkbox = layer.querySelector('input');
const download = document.querySelector('#download');
let current = 'arena';
let active;
let loadId = 0;

function init() {
  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  stage.append(renderer.domElement);

  const world = new T.Scene();
  world.background = new T.Color(0xdce8e1);
  const environment = new RoomEnvironment();
  const pmrem = new T.PMREMGenerator(renderer);
  world.environment = pmrem.fromScene(environment, .04).texture;
  world.environmentIntensity = .82;
  environment.dispose();
  pmrem.dispose();
  const light = new T.DirectionalLight(0xfff7e9, 2.1);
  light.position.set(-3, 6, 4);
  world.add(light, new T.HemisphereLight(0xffffff, 0x849784, .68));

  const camera = new T.PerspectiveCamera(38, 1, .001, 150);
  const controls = new OrbitControls(camera, renderer.domElement);
  const loader = new GLTFLoader();
  const entries = new Map();
  let view = 'default';
  const center = new T.Vector3();
  const bounds = new T.Box3();

  function render() {
    renderer.render(world, camera);
  }

  function applyView() {
    if (!active) return;
    const settings = models[current];
    const direction = view === 'top' ? [0, 1, .0001] :
      view === 'front' ? settings.front : settings.direction;
    const radius = bounds.getBoundingSphere(new T.Sphere()).radius;
    const fit = Math.tan(T.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect);
    const distance = radius / fit * (current === 'arena' ? 1.13 : .94);
    controls.target.copy(center);
    camera.position.fromArray(direction).normalize().multiplyScalar(distance).add(center);
    camera.near = radius / 100;
    camera.far = radius * 40;
    camera.updateProjectionMatrix();
    controls.minDistance = radius * .4;
    controls.maxDistance = distance * 4;
    controls.update();
    render();
  }

  function resize() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    applyView();
  }

  function selectView(preset) {
    view = preset;
    for (const button of document.querySelectorAll('[data-view]')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === preset));
    }
    applyView();
  }

  async function select(name) {
    const request = ++loadId;
    current = name;
    if (active) world.remove(active);
    active = undefined;
    const settings = models[name];
    for (const button of document.querySelectorAll('[data-model]')) {
      button.setAttribute('aria-pressed', String(button.dataset.model === name));
    }
    document.querySelector('#model-name').textContent = settings.title;
    document.querySelector('#model-description').textContent = settings.description;
    document.querySelector('#top-view').textContent = settings.overhead;
    document.querySelector('#specs').replaceChildren(...settings.specs.flatMap(([term, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      return [dt, dd];
    }));
    layer.hidden = !settings.layer;
    layer.querySelector('span').textContent = settings.layer?.[1] ?? '';
    checkbox.checked = true;
    download.href = './assets/' + name + '.glb';
    status.textContent = '載入中…';
    status.hidden = false;
    render();
    try {
      if (!entries.has(name)) entries.set(name, loader.loadAsync(download.href));
      const result = await entries.get(name);
      if (request !== loadId) return;
      active = result.scene;
      if (settings.layer) active.getObjectByName(settings.layer[0].replaceAll(' ', '_')).visible = true;
      world.add(active);
      bounds.setFromObject(active);
      bounds.getCenter(center);
      selectView('default');
      status.hidden = true;
    } catch (error) {
      entries.delete(name);
      if (request !== loadId) return;
      status.textContent = '模型載入失敗。請重新選擇模型或直接下載 GLB。';
      console.error(error);
    }
  }

  controls.addEventListener('change', render);
  new ResizeObserver(resize).observe(stage);
  for (const button of document.querySelectorAll('[data-model]')) {
    button.addEventListener('click', () => select(button.dataset.model));
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => selectView(button.dataset.view));
  }
  checkbox.addEventListener('change', () => {
    const name = models[current].layer?.[0].replaceAll(' ', '_');
    const part = active?.getObjectByName(name);
    if (part) part.visible = checkbox.checked;
    render();
  });
  resize();
  select('arena');
}

try {
  init();
} catch (error) {
  status.textContent = '無法啟用 WebGL。仍可下載球場 GLB。';
  console.error(error);
}
