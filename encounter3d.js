// Rencontre en réalité augmentée : Three.js est chargé par l'import map de index.html.
// Aucun paquet à installer. Le modèle est téléchargé seulement après une identification.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function createEncounter3D({ container, overlay, onStatus }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  renderer.domElement.setAttribute('aria-label', 'Tourner le berger');
  container.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x756b55, 2.1));
  const sun = new THREE.DirectionalLight(0xffe7bf, 2.5);
  sun.position.set(-2, 4, 3);
  scene.add(sun);

  const placement = new THREE.Group();
  const figure = new THREE.Group();
  placement.add(figure);
  scene.add(placement);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.56, 40),
    new THREE.MeshBasicMaterial({ color: 0x151d18, transparent: true, opacity: 0.26, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.y = 0.56;
  shadow.position.y = 0.006;
  placement.add(shadow);

  let active = false;
  let modelReady = false;
  let loadPromise;
  let startedAt = 0;
  let distance = 3;
  let yaw = 0;
  let pointerX = null;
  let xrSession = null;
  let hitSource = null;
  let anchor = null;
  let anchorOffset = new THREE.Vector3();
  let placeNext = false;
  let placed = false;
  let referenceSpace = null;
  let startGeneration = 0;

  function resize() {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // Un glissement fait tourner le personnage ; la caméra vidéo reste fixe.
  renderer.domElement.addEventListener('pointerdown', event => {
    pointerX = event.clientX;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', event => {
    if (pointerX === null) return;
    yaw += (event.clientX - pointerX) * 0.012;
    pointerX = event.clientX;
  });
  renderer.domElement.addEventListener('pointerup', () => { pointerX = null; });
  renderer.domElement.addEventListener('pointercancel', () => { pointerX = null; });

  function loadModel() {
    if (!loadPromise) {
      loadPromise = new GLTFLoader().loadAsync('images/berger.glb').then(gltf => {
        const model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        const center = bounds.getCenter(new THREE.Vector3());
        const height = Math.max(bounds.max.y - bounds.min.y, 0.01);
        const scale = 1.8 / height; // En WebXR, le berger mesure environ 1,80 m.
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
        figure.add(model);
        modelReady = true;
      });
    }
    return loadPromise;
  }
  function setDistance(value) {
    distance = Math.max(2, Math.min(4.5, Number(value) || 3));
  }
  function setClassicPosition() {
    placement.position.set(distance * 0.13, -distance * 0.36, -distance);
    placement.rotation.set(0, 0, 0);
  }
  function animate(time, frame) {
    if (!active || !modelReady) return;
    if (xrSession && frame) updateXR(frame);
    else setClassicPosition();
    const seconds = (time - startedAt) / 1000;
    const t = Math.min(1, Math.max(0, seconds / 0.75));
    const appearance = 1 + 1.7 * Math.pow(t - 1, 3) + 0.7 * Math.pow(t - 1, 2);
    figure.scale.setScalar(Math.max(0.001, appearance));
    figure.position.y = Math.sin(time * 0.0017) * 0.025;
    figure.rotation.y = yaw;
    shadow.material.opacity = 0.26 * Math.min(1, t * 1.6);
    renderer.render(scene, camera);
  }
  async function start() {
    const generation = ++startGeneration;
    active = true;
    resize();
    await loadModel();
    if (!active || generation !== startGeneration) return;
    yaw = 0;
    startedAt = performance.now();
    renderer.setAnimationLoop(animate);
  }
  function stop() {
    startGeneration++;
    active = false;
    renderer.setAnimationLoop(null);
    if (xrSession) xrSession.end().catch(() => {});
    onStatus('Placement visuel');
  }
  async function isARSupported() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
    try { return await navigator.xr.isSessionSupported('immersive-ar'); }
    catch (_) { return false; }
  }
  function placeFromPose(pose, frame) {
    const position = pose.transform.position;
    const viewer = frame.getViewerPose(referenceSpace);
    const right = new THREE.Vector3(1, 0, 0);
    if (viewer) {
      const q = viewer.transform.orientation;
      right.applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    }
    right.y = 0;
    right.normalize();
    anchorOffset.copy(right).multiplyScalar(0.45); // À côté de la plante visée.
    placement.position.set(position.x, position.y, position.z).add(anchorOffset);
    if (viewer) {
      const v = viewer.transform.position;
      placement.lookAt(v.x, placement.position.y, v.z);
    }
    placed = true;
    onStatus('Berger placé dans votre espace');
  }
  function updateXR(frame) {
    if (!referenceSpace) return;
    if (anchor) {
      const pose = frame.getPose(anchor.anchorSpace, referenceSpace);
      if (pose) {
        const p = pose.transform.position;
        placement.position.set(p.x, p.y, p.z).add(anchorOffset);
      }
    }
    if (placeNext && hitSource) {
      const hits = frame.getHitTestResults(hitSource);
      if (hits.length) {
        const hit = hits[0];
        const pose = hit.getPose(referenceSpace);
        if (pose) {
          placeFromPose(pose, frame);
          placeNext = false;
          if (anchor) { anchor.delete(); anchor = null; }
          if (hit.createAnchor) hit.createAnchor().then(value => { if (xrSession) anchor = value; }).catch(() => {});
        }
      }
    }
    // Sans hit-test, une position fixe dans l'espace local reste possible.
    if (!placed) {
      const viewer = frame.getViewerPose(referenceSpace);
      if (viewer) {
        const p = viewer.transform.position;
        const q = viewer.transform.orientation;
        const forward = new THREE.Vector3(0, 0, -2.5).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
        placement.position.set(p.x + forward.x + 0.45, p.y - 1.4, p.z + forward.z);
        placement.lookAt(p.x, placement.position.y, p.z);
        placed = true;
      }
    }
  }
  async function startAR() {
    if (!active || !modelReady || !await isARSupported()) throw new Error('WebXR AR indisponible sur cet appareil.');
    // DOM Overlay garde les boutons et les questions visibles dans la session AR.
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'dom-overlay'],
      optionalFeatures: ['hit-test', 'anchors'],
      domOverlay: { root: overlay }
    });
    xrSession = session;
    hitSource = null;
    anchor = null;
    placed = false;
    placeNext = true;
    try {
      await renderer.xr.setSession(session);
      referenceSpace = renderer.xr.getReferenceSpace();
      if (session.requestHitTestSource) {
        try {
          const viewerSpace = await session.requestReferenceSpace('viewer');
          hitSource = await session.requestHitTestSource({ space: viewerSpace });
        } catch (_) { /* La position fixe dans l'espace local reste utilisable. */ }
      }
      session.addEventListener('select', () => { placeNext = true; });
      session.addEventListener('end', () => {
        if (hitSource) hitSource.cancel();
        if (anchor) anchor.delete();
        hitSource = anchor = referenceSpace = xrSession = null;
        placed = false;
        overlay.classList.remove('is-xr');
        onStatus('Placement visuel');
      }, { once: true });
      overlay.classList.add('is-xr');
      onStatus('AR active · visez le sol puis touchez pour placer');
    } catch (error) {
      await session.end().catch(() => {});
      xrSession = null;
      throw error;
    }
  }
  async function stopAR() {
    if (xrSession) await xrSession.end();
  }
  return { start, stop, setDistance, isARSupported, startAR, stopAR, get isAR() { return Boolean(xrSession); } };
}
