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
  const CLASSIC_DEPTH = 3;
  let yaw = 0;
  let pointerX = null;
  let xrSession = null;
  let hitSource = null;
  let anchor = null;
  let placed = false;
  let referenceSpace = null;
  let startGeneration = 0;
  let stableHits = [];
  let firstStableAt = 0;
  let anchorBound = false;
  let referenceReset = false;
  let xrStatus = '';
  const fixedMatrix = new THREE.Matrix4();
  const relativeToAnchor = new THREE.Matrix4();
  const anchorMatrix = new THREE.Matrix4();
  const nextAnchorMatrix = new THREE.Matrix4();

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
  function setClassicPosition() {
    placement.matrixAutoUpdate = true;
    placement.visible = true;
    placement.position.set(CLASSIC_DEPTH * 0.13, -CLASSIC_DEPTH * 0.36, -CLASSIC_DEPTH);
    placement.rotation.set(0, 0, 0);
  }
  function animate(time, frame) {
    if (!active || !modelReady) return;
    if (xrSession) {
      if (frame) updateXR(frame, time);
      else if (placed) setXRStatus('Suivi interrompu');
    }
    const seconds = (time - startedAt) / 1000;
    const t = Math.min(1, Math.max(0, seconds / 0.75));
    const appearance = 1 + 1.7 * Math.pow(t - 1, 3) + 0.7 * Math.pow(t - 1, 2);
    figure.scale.setScalar(Math.max(0.001, appearance));
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
    setClassicPosition();
    startedAt = performance.now();
    renderer.setAnimationLoop(animate);
  }
  function stop() {
    startGeneration++;
    active = false;
    renderer.setAnimationLoop(null);
    if (xrSession) xrSession.end().catch(() => {});
    onStatus('Superposition 3D · sans ancrage réel');
  }
  async function isARSupported() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
    try { return await navigator.xr.isSessionSupported('immersive-ar'); }
    catch (_) { return false; }
  }
  function setXRStatus(message) {
    if (xrStatus !== message) { xrStatus = message; onStatus(message); }
  }
  function clearStableHits() { stableHits = []; firstStableAt = 0; }
  function placeOnStableSurface(hit, pose, viewer) {
    const point = pose.transform.position;
    const q = viewer.transform.orientation;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    right.y = 0;
    if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
    else right.normalize();
    placement.position.set(point.x, point.y, point.z).addScaledVector(right, 0.45);
    const eye = viewer.transform.position;
    placement.lookAt(eye.x, placement.position.y, eye.z);
    placement.updateMatrix();
    // Pose unique dans le referenceSpace. Aucun nouveau hit-test ne la modifiera.
    fixedMatrix.copy(placement.matrix);
    placement.matrixAutoUpdate = false;
    placement.matrix.copy(fixedMatrix);
    placement.visible = true;
    placed = true;
    setXRStatus('Berger placé');

    // L'ancre affine le suivi. Si elle manque, fixedMatrix reste la pose définitive.
    if (typeof hit.createAnchor === 'function') {
      const session = xrSession;
      try {
        hit.createAnchor().then(value => {
          if (xrSession === session && placed) { anchor = value; anchorBound = false; }
          else value.delete();
        }).catch(error => console.warn('[Maquis] Ancre XR indisponible ; pose fixe conservée.', error));
      } catch (error) { console.warn('[Maquis] Ancre XR indisponible ; pose fixe conservée.', error); }
    }
    if (hitSource) { hitSource.cancel(); hitSource = null; }
    clearStableHits();
  }
  function updateXR(frame, time) {
    if (!referenceSpace) return;
    const viewer = frame.getViewerPose(referenceSpace);
    if (!viewer || viewer.emulatedPosition) {
      if (placed) setXRStatus('Suivi interrompu');
      else { clearStableHits(); setXRStatus('Recherche d’une surface…'); }
      return;
    }
    if (placed) {
      if (anchor) {
        const pose = frame.getPose(anchor.anchorSpace, referenceSpace);
        if (!pose || pose.emulatedPosition) { setXRStatus('Suivi interrompu'); return; }
        anchorMatrix.fromArray(pose.transform.matrix);
        if (!anchorBound) {
          relativeToAnchor.copy(anchorMatrix).invert().multiply(fixedMatrix);
          anchorBound = true;
        }
        // La pose est exprimée dans l'espace de l'ancre ; ignorer le bruit minime.
        nextAnchorMatrix.multiplyMatrices(anchorMatrix, relativeToAnchor);
        if (nextAnchorMatrix.elements.some((value, index) => Math.abs(value - placement.matrix.elements[index]) > 0.004))
          placement.matrix.copy(nextAnchorMatrix);
        referenceReset = false;
      }
      setXRStatus(referenceReset ? 'Suivi interrompu' : 'Berger placé');
      return;
    }
    if (!hitSource) return;
    const hits = frame.getHitTestResults(hitSource);
    if (!hits.length) { clearStableHits(); return; }
    const hit = hits[0];
    const pose = hit.getPose(referenceSpace);
    if (!pose || pose.emulatedPosition) { clearStableHits(); return; }
    const q = pose.transform.orientation;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    if (up.y < 0.8) { clearStableHits(); return; } // Écarter les murs et surfaces inclinées.
    const p = pose.transform.position;
    const point = new THREE.Vector3(p.x, p.y, p.z);
    const first = stableHits[0];
    if (first && (point.distanceTo(first) > 0.08 || Math.abs(point.y - first.y) > 0.04)) clearStableHits();
    if (!stableHits.length) firstStableAt = time;
    stableHits.push(point);
    // Plusieurs résultats proches pendant au moins 300 ms avant de figer la pose.
    if (stableHits.length >= 8 && time - firstStableAt >= 300) placeOnStableSurface(hit, pose, viewer);
  }
  async function startAR() {
    if (!active || !modelReady || !navigator.xr) throw new Error('WebXR AR indisponible sur cet appareil.');
    // DOM Overlay garde les boutons et les questions visibles dans la session AR.
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'dom-overlay', 'hit-test'],
      optionalFeatures: ['anchors'],
      domOverlay: { root: overlay }
    });
    xrSession = session;
    hitSource = null;
    anchor = null;
    placed = false;
    anchorBound = false;
    referenceReset = false;
    clearStableHits();
    placement.visible = false; // Pas de personnage flottant en attendant le sol.
    const onReferenceReset = () => {
      if (placed && !anchor) { referenceReset = true; setXRStatus('Suivi interrompu'); }
    };
    session.addEventListener('end', () => {
      if (referenceSpace) referenceSpace.removeEventListener('reset', onReferenceReset);
      if (hitSource) hitSource.cancel();
      if (anchor) anchor.delete();
      hitSource = anchor = referenceSpace = xrSession = null;
      placed = false;
      clearStableHits();
      placement.matrixAutoUpdate = true;
      setClassicPosition();
      overlay.classList.remove('is-xr');
      xrStatus = '';
      onStatus('Superposition 3D · sans ancrage réel');
    }, { once: true });
    try {
      await renderer.xr.setSession(session);
      referenceSpace = renderer.xr.getReferenceSpace();
      if (!referenceSpace || !session.requestHitTestSource)
        throw new Error('Recherche de surface WebXR indisponible.');
      referenceSpace.addEventListener('reset', onReferenceReset);
      const viewerSpace = await session.requestReferenceSpace('viewer');
      hitSource = await session.requestHitTestSource({ space: viewerSpace });
      overlay.classList.add('is-xr');
      setXRStatus('Recherche d’une surface…');
    } catch (error) {
      await session.end().catch(() => {});
      throw error;
    }
  }
  async function stopAR() {
    if (xrSession) await xrSession.end();
  }
  return { start, stop, isARSupported, startAR, stopAR, get isAR() { return Boolean(xrSession); } };
}
