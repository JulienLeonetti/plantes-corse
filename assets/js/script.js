/* Maquis : application sans framework. Les secrets restent uniquement dans le Worker. */
(function () {
  'use strict';
  const cfg = window.MAQUIS_CONFIG || {};
  const demoKey = 'maquis.decouvertes.v1';
  const bucket = 'plant-photos';
  const questions = { caracteristiques: 'Caractéristiques', floraison: 'Floraison', recette: 'Recette', toxicite: 'Toxicité', legende: 'Légende' };
  const el = id => document.getElementById(id);
  const views = { scanner: el('view-scanner'), plantes: el('view-plantes'), carte: el('view-carte') };
  const scanDialog = el('scan-dialog'), resultDialog = el('result-dialog'), authDialog = el('auth-dialog');
  const db = cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  let mode = null, user = null, discoveries = [], photo = null, current = null, activeDialog = null;
  let map = null, markers = null, audioPlayer = null, recorder = null, stream = null, chunks = [];
  let authTab = 'login', scanToken = 0, voiceReady = false, scanInProgress = false, photoPreparationInProgress = false;
  let cameraStream = null, encounter3d = null, encounterSequence = 0, saveInProgress = false;

  // Le flux vidéo reste ouvert pendant l'analyse ET pendant la rencontre.
  async function startCamera() {
    if (cameraStream) return;
    const token = scanToken;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      scanError('Caméra en direct indisponible ici. Utilisez une photo ou ouvrez le site en HTTPS.');
      return;
    }
    el('take-photo').disabled = true;
    try {
      const live = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (token !== scanToken || scanDialog.hidden) { live.getTracks().forEach(track => track.stop()); return; }
      cameraStream = live;
      const video = el('scanner-video');
      video.srcObject = live;
      await video.play();
      el('scanner-live').hidden = false;
      el('take-photo').hidden = true;
      el('scan-error').textContent = ''; el('scan-error-card').hidden = true;
    } catch (_) {
      if (cameraStream) stopCamera();
      if (token === scanToken && !photo && !scanDialog.hidden) scanError('Caméra refusée ou indisponible. Importez une photo, ou utilisez la caméra native.');
      el('take-photo').querySelector('strong').textContent = 'Caméra native';
    } finally { el('take-photo').disabled = false; }
  }
  function stopCamera() {
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    el('scanner-video').srcObject = null;
    el('encounter-video').srcObject = null;
    el('scanner-live').hidden = true;
    el('take-photo').hidden = false;
  }
  function captureLivePhoto() {
    const video = el('encounter-video').srcObject ? el('encounter-video') : el('scanner-video');
    if (!cameraStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !video.videoWidth || !video.videoHeight || Math.min(video.videoWidth, video.videoHeight) < 240) {
      return Promise.reject(new Error('Image vidéo incomplète. Attendez un instant et réessayez.'));
    }
    const ratio = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    const context = canvas.getContext('2d');
    if (!context) return Promise.reject(new Error('Capture impossible.'));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (!hasUsablePixels(context, canvas.width, canvas.height)) return Promise.reject(new Error('Image trop sombre ou vide. Cadrez la plante et réessayez.'));
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve({ blob, dataUrl: canvas.toDataURL('image/jpeg', 0.9) });
      else reject(new Error('Capture impossible.'));
    }, 'image/jpeg', 0.9));
  }
  // Un échantillon presque entièrement noir indique souvent une trame non prête.
  function hasUsablePixels(context, width, height) {
    const sample = document.createElement('canvas'); sample.width = 24; sample.height = 24;
    const sampled = sample.getContext('2d');
    if (!sampled) return false;
    sampled.drawImage(context.canvas, 0, 0, width, height, 0, 0, 24, 24);
    const pixels = sampled.getImageData(0, 0, 24, 24).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 24) dark++;
    return dark < 550;
  }
  function showBergerFallback() {
    el('berger-loading').hidden = true;
    el('berger-fallback').hidden = false;
    el('guide-avatar').classList.add('is-fallback');
  }
  async function startEncounter3D() {
    const sequence = ++encounterSequence;
    el('berger-loading').hidden = false;
    el('berger-fallback').hidden = true;
    el('guide-avatar').classList.remove('is-fallback');
    const timeout = setTimeout(() => { if (sequence === encounterSequence && !resultDialog.hidden) showBergerFallback(); }, 45000);
    try {
      if (!encounter3d) {
        const module = await import('./encounter3d.js');
        encounter3d = module.createEncounter3D({
          container: el('encounter-canvas'), overlay: resultDialog,
          onStatus: message => {
            el('encounter-mode').textContent = message;
            el('encounter-ar').textContent = encounter3d && encounter3d.isAR ? 'Quitter AR' : 'Activer AR';
          }
        });
      }
      if (sequence !== encounterSequence || resultDialog.hidden) return;
      await encounter3d.start();
      if (sequence !== encounterSequence || resultDialog.hidden) return;
      clearTimeout(timeout);
      el('berger-loading').hidden = true;
      el('berger-fallback').hidden = true;
      el('encounter-ar').hidden = !await encounter3d.isARSupported();
    } catch (_) {
      if (sequence === encounterSequence && !resultDialog.hidden) showBergerFallback();
    } finally { clearTimeout(timeout); }
  }

  function showView(name) {
    Object.entries(views).forEach(([key, view]) => { view.hidden = key !== name; });
    document.querySelectorAll('.bottom-nav button').forEach(button => {
      const active = button.dataset.view === name;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if (name === 'plantes') renderInventory();
    if (name === 'carte') { renderMap(); setTimeout(() => { if (map) map.invalidateSize(); }, 80); }
    if (mode === 'account' && (name === 'plantes' || name === 'carte')) refreshPhotos(name);
    window.scrollTo(0, 0);
  }
  function openDialog(dialog) {
    if (activeDialog) activeDialog.hidden = true;
    activeDialog = dialog; dialog.hidden = false; document.body.style.overflow = 'hidden';
    document.body.classList.toggle('is-immersive', dialog === scanDialog || dialog === resultDialog);
    const first = dialog.querySelector('button'); if (first) first.focus();
  }
  function closeDialog(dialog) {
    if (dialog === authDialog && !mode) return;
    if (dialog === resultDialog && saveInProgress) return;
    if (dialog === scanDialog) { scanToken++; stopCamera(); }
    if (dialog === resultDialog) {
      encounterSequence++;
      if (encounter3d) encounter3d.stop();
      stopCamera(); stopSpeech();
      if (recorder && recorder.state === 'recording') recorder.stop();
      current = null;
    }
    dialog.hidden = true; if (activeDialog === dialog) activeDialog = null;
    document.body.style.overflow = '';
    document.body.classList.remove('is-immersive');
  }
  function openScanner() {
    if (!mode) { openDialog(authDialog); return; }
    scanToken++;
    if (activeDialog) closeDialog(activeDialog);
    showView('scanner'); photo = null;
    el('photo-preview').removeAttribute('src'); el('preview-area').hidden = true;
    el('scan-progress').hidden = true; el('retry-button').hidden = true; el('scan-error').textContent = ''; el('scan-error-card').hidden = true;
    el('demo-choice').hidden = mode !== 'demo'; el('demo-plant').value = '';
    el('camera-input').value = ''; el('gallery-input').value = '';
    openDialog(scanDialog);
    startCamera();
  }
  function localPlant(id) {
    const p = window.PLANTES[id];
    return { scientific_name: p.latin, common_name: p.nom, summary: p.resume, corsica_status: 'présente en Corse', questions: p.questions };
  }
  function loadDemo() {
    try {
      const rows = JSON.parse(localStorage.getItem(demoKey) || '[]');
      return Array.isArray(rows) ? rows.filter(row => row && window.PLANTES[row.plantId]).map(row => ({
        id: row.id, plantId: row.plantId, plant: localPlant(row.plantId), photoUrl: row.photo,
        date: row.date, position: row.position, score: null, demo: true
      })) : [];
    } catch (_) { return []; }
  }
  function saveDemo() {
    try {
      localStorage.setItem(demoKey, JSON.stringify(discoveries.map(row => ({
        id: row.id, plantId: row.plantId, photo: row.photoUrl, date: row.date, position: row.position
      })))); return true;
    } catch (_) { return false; }
  }
  function enterDemo() {
    scanToken++; mode = 'demo'; user = null; discoveries = loadDemo();
    el('auth-close').hidden = false;
    el('account-button').textContent = 'Mode démo · Connexion';
    el('mode-description').textContent = 'Mode démo : reconnaissance simulée et photos conservées sur cet appareil.';
    el('inventory-subtitle').textContent = 'Mode démo · découvertes enregistrées sur cet appareil.';
    closeDialog(authDialog); renderInventory();
  }
  async function enterAccount(session) {
    if (!session || !session.user) return;
    const changed = mode !== 'account' || !user || user.id !== session.user.id;
    mode = 'account'; user = session.user;
    el('auth-close').hidden = true;
    el('account-button').textContent = 'Se déconnecter';
    el('mode-description').textContent = 'Votre herbier et vos photos sont privés et liés à votre compte.';
    el('inventory-subtitle').textContent = 'Vos découvertes personnelles, enregistrées dans votre compte.';
    if (activeDialog === authDialog) closeDialog(authDialog);
    if (changed) { discoveries = []; renderInventory(); await checkServices(); await loadAccountDiscoveries(user.id); }
  }
  async function checkServices() {
    voiceReady = false;
    if (!cfg.workerUrl) return;
    try {
      const response = await fetch(cfg.workerUrl.replace(/\/$/, '') + '/health');
      if (response.ok) voiceReady = Boolean((await response.json()).voice);
    } catch (_) { /* Le mode vocal local reste disponible. */ }
  }
  async function loadAccountDiscoveries(uid) {
    const query = await db.from('discoveries').select('id,discovered_at,latitude,longitude,confidence,photo_path,plants(scientific_name,common_name,summary,corsica_status)').eq('user_id', uid).order('discovered_at', { ascending: false });
    if (mode !== 'account' || !user || user.id !== uid) return;
    if (query.error) { el('inventory-subtitle').textContent = 'Chargement impossible : ' + query.error.message; return; }
    const rows = await Promise.all((query.data || []).map(async row => {
      const signed = await db.storage.from(bucket).createSignedUrl(row.photo_path, 3600);
      return { id: row.id, plant: row.plants || { common_name: 'Plante', scientific_name: '', summary: '' }, photoPath: row.photo_path,
        photoUrl: signed.error ? '' : signed.data.signedUrl, photoError: Boolean(signed.error),
        signedAt: signed.error ? 0 : Date.now(),
        date: row.discovered_at, position: row.latitude == null ? null : { lat: row.latitude, lng: row.longitude }, score: row.confidence };
    }));
    if (mode === 'account' && user && user.id === uid) { discoveries = rows; renderInventory(); if (!views.carte.hidden) renderMap(); }
  }
  async function refreshPhotos(viewName) {
    const uid = user && user.id;
    const stale = discoveries.filter(row => row.photoPath && (!row.signedAt || Date.now() - row.signedAt > 50 * 60 * 1000));
    if (!stale.length) return;
    await Promise.all(stale.map(async row => {
      const signed = await db.storage.from(bucket).createSignedUrl(row.photoPath, 3600);
      if (mode !== 'account' || !user || user.id !== uid) return;
      row.photoUrl = signed.error ? '' : signed.data.signedUrl;
      row.photoError = Boolean(signed.error);
      row.signedAt = signed.error ? 0 : Date.now();
    }));
    if (mode === 'account' && user && user.id === uid) {
      if (viewName === 'plantes' && !views.plantes.hidden) renderInventory();
      if (viewName === 'carte' && !views.carte.hidden) renderMap();
    }
  }

  // Montre immédiatement le fichier, puis en conserve une copie JPEG légère du même cliché.
  function preparePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) { reject(new Error('Choisissez une image.')); return; }
      const url = URL.createObjectURL(file);
      el('photo-preview').src = url; el('preview-area').hidden = false;
      const image = new Image();
      image.onload = () => {
        if (Math.min(image.width, image.height) < 240) { URL.revokeObjectURL(url); reject(new Error('Photo trop petite ou incomplète. Choisissez une autre image.')); return; }
        const ratio = Math.min(1, 1200 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * ratio));
        canvas.height = Math.max(1, Math.round(image.height * ratio));
        const context = canvas.getContext('2d');
        if (!context) { URL.revokeObjectURL(url); reject(new Error('Photo illisible.')); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        if (!hasUsablePixels(context, canvas.width, canvas.height)) { URL.revokeObjectURL(url); reject(new Error('Image trop sombre ou vide. Choisissez une autre photo.')); return; }
        canvas.toBlob(blob => {
          URL.revokeObjectURL(url);
          if (!blob) { reject(new Error('Compression de la photo impossible.')); return; }
          const reader = new FileReader();
          reader.onload = () => resolve({ blob, dataUrl: reader.result });
          reader.onerror = () => reject(new Error('Lecture de la photo impossible.'));
          reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.9);
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
      image.src = url;
    });
  }
  async function handlePhoto(event) {
    const file = event.target.files && event.target.files[0]; if (!file) return;
    if (scanInProgress || photoPreparationInProgress) return;
    photoPreparationInProgress = true; photo = null;
    const token = ++scanToken;
    el('scan-error').textContent = ''; el('scan-error-card').hidden = true; el('retry-button').hidden = true;
    try {
      const preparation = preparePhoto(file); // L'aperçu est posé avant le travail asynchrone.
      scanStatus('Préparation de la photo…');
      const ready = await preparation;
      if (token !== scanToken) return;
      photo = ready; el('photo-preview').src = ready.dataUrl;
      photoPreparationInProgress = false;
      await analyzePhoto(token);
    } catch (error) { if (token === scanToken) scanError(error.message); }
    finally { photoPreparationInProgress = false; }
  }
  function scanError(message) {
    el('scan-progress').hidden = true; el('scan-error').textContent = message;
    el('scan-error-card').hidden = false;
    el('retry-button').hidden = !cameraStream && !photo;
  }
  function scanStatus(message) {
    el('scan-status').textContent = message;
    el('scan-progress').hidden = false;
    el('scan-error-card').hidden = true;
  }
  function getPosition() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }
  async function workerRequest(route, body, multipart) {
    if (!cfg.workerUrl) throw new Error('API de reconnaissance non configurée');
    if (!db || !user) throw new Error('Connectez-vous pour utiliser ce service.');
    const session = await db.auth.getSession();
    if (!session.data.session) throw new Error('Session expirée. Reconnectez-vous.');
    const headers = { Authorization: 'Bearer ' + session.data.session.access_token };
    if (!multipart) headers['Content-Type'] = 'application/json';
    const response = await fetch(cfg.workerUrl.replace(/\/$/, '') + route, {
      method: 'POST', headers, body: multipart ? body : JSON.stringify(body)
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || 'Service indisponible.');
    }
    return response;
  }
  // Point de branchement Pl@ntNet. La clé reste dans les variables du Cloudflare Worker.
  async function identifierPlante(blob) {
    if (!blob) throw new Error('Aucune photo à analyser.');
    if (mode === 'demo') {
      const id = el('demo-plant').value;
      if (!id || !window.PLANTES[id]) throw new Error('En mode démo, choisissez une plante pour simuler la reconnaissance.');
      return { demo: true, recognized: true, plantId: id, scientificName: window.PLANTES[id].latin,
        commonName: window.PLANTES[id].nom, score: null, bestMatch: window.PLANTES[id].latin,
        results: [{ species: { scientificNameWithoutAuthor: window.PLANTES[id].latin }, score: null }] };
    }
    const form = new FormData(); form.append('image', blob, 'plante.jpg');
    return (await workerRequest('/identify', form, true)).json();
  }
  window.identifierPlante = identifierPlante;

  async function analyzePhoto(token) {
    if (!photo || scanInProgress) return;
    scanInProgress = true;
    token = token || ++scanToken;
    const originalMode = mode, uid = user && user.id;
    el('retry-button').hidden = true; el('scan-error').textContent = ''; el('scan-error-card').hidden = true;
    try {
      scanStatus('Analyse de la plante…');
      const found = await identifierPlante(photo.blob);
      if (token !== scanToken || mode !== originalMode || (mode === 'account' && (!user || user.id !== uid))) return;
      console.info('[Pl@ntNet] Résultat', { scientificName: found.scientificName || null, score: found.score ?? null,
        recognized: found.recognized, bestMatch: found.bestMatch || null });
      if (found.recognized === false || !found.bestMatch || !Array.isArray(found.results) || !found.results.length) {
        console.info('[Pl@ntNet] Rejet : aucune plante détectée');
        throw new Error('Aucune plante reconnue. Rapprochez-vous et cadrez une feuille ou une fleur.');
      }
      if (mode === 'demo') {
        scanStatus('Recherche de votre position…');
        const position = await getPosition();
        if (token !== scanToken) return;
        const row = { id: crypto.randomUUID(), plantId: found.plantId, plant: localPlant(found.plantId),
          photoUrl: photo.dataUrl, date: new Date().toISOString(), position, score: null, demo: true };
        showResult(row, 'Prenez la photo pour ajouter cette plante à votre herbier.');
        return;
      }
      const best = found.results[0];
      const score = Number(best && best.score);
      const scientificName = String(best && best.species && (best.species.scientificNameWithoutAuthor || best.species.scientificName) || '').trim();
      if (!scientificName || !Number.isFinite(score) || score < 0.30) {
        console.info('[Pl@ntNet] Rejet : nom ou score insuffisant', { scientificName, score });
        throw new Error('Aucune plante reconnue. Rapprochez-vous et cadrez une feuille ou une fleur.');
      }
      const match = await db.from('plants').select('*').eq('scientific_name', scientificName).maybeSingle();
      if (match.error) throw new Error('Catalogue corse indisponible : ' + match.error.message);
      console.info('[Catalogue corse] Correspondance', { scientificName, found: Boolean(match.data), name: match.data && match.data.common_name });
      if (!match.data) throw new Error('Cette plante n’est pas encore répertoriée dans le catalogue corse.');
      scanStatus('Recherche de votre position…');
      const position = await getPosition();
      if (token !== scanToken || mode !== 'account' || !user || user.id !== uid) return;
      const row = { id: crypto.randomUUID(), plant: match.data, photoUrl: photo.dataUrl,
        date: new Date().toISOString(), position, score, pending: true };
      showResult(row, 'Prenez la photo pour enregistrer la découverte.');
    } catch (error) { if (token === scanToken) scanError(error.message || 'Analyse impossible.'); }
    finally { scanInProgress = false; }
  }

  async function saveEncounter() {
    if (!current || saveInProgress) return;
    saveInProgress = true;
    const button = el('save-encounter');
    button.disabled = true;
    el('exit-encounter').disabled = true;
    el('encounter-error').textContent = '';
    button.textContent = 'Enregistrement…';
    try {
      // Le cliché final vient du flux encore ouvert ; l'image analysée sert de secours
      // quand la caméra native ou WebXR ne permet pas de lire une nouvelle trame.
      const finalPhoto = cameraStream && !(encounter3d && encounter3d.isAR)
        ? await captureLivePhoto().catch(() => photo) : photo;
      if (!finalPhoto || !finalPhoto.blob) throw new Error('Photo indisponible.');
      const row = current;
      if (mode === 'demo') {
        row.photoUrl = finalPhoto.dataUrl;
        row.date = new Date().toISOString();
        discoveries.unshift(row);
        if (!saveDemo()) {
          discoveries.shift();
          throw new Error('Mémoire locale pleine. Libérez de la place avant d’enregistrer.');
        }
      } else {
        if (!db || !user) throw new Error('Votre session a expiré.');
        const uid = user.id;
        const path = uid + '/' + crypto.randomUUID() + '.jpg';
        const storage = db.storage.from(bucket);
        const uploaded = await storage.upload(path, finalPhoto.blob, { contentType: 'image/jpeg', upsert: false });
        if (uploaded.error) throw new Error('Envoi de la photo échoué : ' + uploaded.error.message);
        let inserted = false;
        try {
          if (mode !== 'account' || !user || user.id !== uid) throw new Error('Session interrompue.');
          const signed = await storage.createSignedUrl(path, 3600);
          if (signed.error) throw new Error('Photo envoyée, mais URL inaccessible : ' + signed.error.message);
          const saved = await db.from('discoveries').insert({ user_id: uid, plant_id: row.plant.id,
            latitude: row.position && row.position.lat, longitude: row.position && row.position.lng,
            confidence: row.score, photo_path: path }).select('id,discovered_at').single();
          if (saved.error) throw new Error('Enregistrement échoué : ' + saved.error.message);
          inserted = true;
          discoveries.unshift({ ...row, id: saved.data.id, date: saved.data.discovered_at,
            photoUrl: signed.data.signedUrl, photoPath: path, signedAt: Date.now(), pending: false });
        } catch (error) { if (!inserted) await storage.remove([path]); throw error; }
      }
      saveInProgress = false;
      closeDialog(resultDialog);
      showView('plantes');
    } catch (error) {
      el('encounter-error').textContent = error.message || 'Enregistrement impossible.';
    } finally {
      saveInProgress = false;
      button.disabled = false;
      el('exit-encounter').disabled = false;
      button.textContent = '📷 Photographier et enregistrer';
    }
  }

  function formatDate(value) { return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value)); }
  function formatPosition(position) {
    if (!position) return 'Position indisponible';
    return Math.abs(position.lat).toFixed(5) + '° ' + (position.lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(position.lng).toFixed(5) + '° ' + (position.lng >= 0 ? 'E' : 'O');
  }
  function showResult(row, note) {
    current = row;
    el('result-photo').src = row.photoUrl;
    el('result-title').textContent = row.plant.common_name;
    el('result-latin').textContent = row.plant.scientific_name;
    el('result-summary').textContent = row.plant.summary;
    el('result-confidence').textContent = row.score == null ? 'Identification simulée · mode démo' : 'Confiance Pl@ntNet : ' + Math.round(row.score * 100) + ' % · ' + row.plant.corsica_status;
    el('result-date').textContent = formatDate(row.date);
    el('result-location').textContent = formatPosition(row.position) + ' · ' + note;
    el('conversation-error').textContent = ''; el('conversation-question').hidden = true;
    el('voice-status').textContent = row.demo || !voiceReady ? 'Voix de démonstration du navigateur' : 'Conversation vocale avec le berger';
    const box = el('question-buttons'); box.replaceChildren();
    Object.entries(questions).forEach(([key, label]) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => {
        box.querySelectorAll('button').forEach(item => item.classList.remove('is-selected'));
        button.classList.add('is-selected'); askQuestion(label, key);
      }); box.append(button);
    });
    openDialog(resultDialog);
    el('encounter-error').textContent = '';
    el('encounter-mode').textContent = 'Superposition 3D · sans ancrage réel';
    el('encounter-ar').hidden = true;
    el('save-encounter').disabled = false;
    const encounterVideo = el('encounter-video');
    encounterVideo.srcObject = cameraStream;
    encounterVideo.hidden = !cameraStream;
    el('encounter-still').src = row.photoUrl;
    el('encounter-still').hidden = Boolean(cameraStream);
    if (cameraStream) encounterVideo.play().catch(() => {});
    startEncounter3D();
    playAnswer('Bonjour ! Voici ' + row.plant.common_name + '. ' + row.plant.summary);
  }
  function stopSpeech() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (audioPlayer) { audioPlayer.pause(); audioPlayer.src = ''; audioPlayer = null; }
    el('guide-avatar').classList.remove('is-speaking');
  }
  function browserSpeech(text) {
    el('voice-status').textContent = 'Voix de démonstration du navigateur';
    if (!('speechSynthesis' in window)) return;
    const speech = new SpeechSynthesisUtterance(text); speech.lang = 'fr-FR'; speech.rate = 0.95;
    speech.onstart = () => el('guide-avatar').classList.add('is-speaking');
    speech.onend = speech.onerror = () => el('guide-avatar').classList.remove('is-speaking');
    speechSynthesis.speak(speech);
  }
  async function playAnswer(text) {
    stopSpeech(); el('guide-text').textContent = text;
    if (mode !== 'account' || !voiceReady) { browserSpeech(text); return; }
    const resultId = current && current.id;
    try {
      el('voice-status').textContent = 'Préparation de la voix…';
      const response = await workerRequest('/speak', { text });
      const url = URL.createObjectURL(await response.blob());
      if (resultDialog.hidden || !current || current.id !== resultId) { URL.revokeObjectURL(url); return; }
      const audio = new Audio(url); audioPlayer = audio;
      audio.onplay = () => { el('voice-status').textContent = 'Le berger vous répond'; el('guide-avatar').classList.add('is-speaking'); };
      audio.onended = audio.onerror = () => { el('guide-avatar').classList.remove('is-speaking'); URL.revokeObjectURL(url); };
      await audio.play();
    } catch (_) { browserSpeech(text); }
  }
  async function askQuestion(question, key) {
    if (!current) return;
    const resultId = current.id;
    el('conversation-error').textContent = '';
    if (current.demo) { playAnswer(current.plant.questions[key]); return; }
    try {
      el('voice-status').textContent = 'Recherche d’une réponse vérifiée…';
      const response = await workerRequest('/chat', { question, scientificName: current.plant.scientific_name });
      const data = await response.json();
      if (resultDialog.hidden || !current || current.id !== resultId) return;
      await playAnswer(data.answer);
    } catch (error) { el('conversation-error').textContent = error.message; }
  }
  async function toggleMicrophone() {
    const button = el('microphone-button');
    if (!current || current.demo || !voiceReady) { el('conversation-error').textContent = 'Conversation IA non configurée. Les questions écrites et la voix de démonstration restent disponibles.'; return; }
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { el('conversation-error').textContent = 'Le microphone nécessite HTTPS et un navigateur compatible.'; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        button.classList.remove('is-recording'); button.querySelector('span').textContent = 'Poser une question';
        if (resultDialog.hidden) return;
        const sound = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); if (!sound.size) return;
        try {
          el('voice-status').textContent = 'Transcription de votre question…';
          const form = new FormData(); form.append('audio', sound, 'question.' + (sound.type.includes('mp4') ? 'mp4' : 'webm'));
          const data = await (await workerRequest('/transcribe', form, true)).json();
          el('conversation-question').textContent = 'Vous : ' + data.text; el('conversation-question').hidden = false;
          await askQuestion(data.text);
        } catch (error) { el('conversation-error').textContent = error.message; }
      };
      recorder.start(); button.classList.add('is-recording'); button.querySelector('span').textContent = 'Terminer la question';
      el('voice-status').textContent = 'Enregistrement en cours…'; el('conversation-error').textContent = '';
    } catch (_) { el('conversation-error').textContent = 'Accès au microphone refusé ou indisponible.'; }
  }
  function renderInventory() {
    const list = el('inventory-list'); list.replaceChildren();
    el('inventory-empty').hidden = discoveries.length > 0;
    el('inventory-count').textContent = discoveries.length + (discoveries.length > 1 ? ' découvertes' : ' découverte');
    discoveries.forEach(row => {
      const card = document.createElement('article'); card.className = 'plant-card';
      const image = document.createElement('img'); image.className = 'plant-card-photo';
      if (row.photoUrl) image.src = row.photoUrl;
      image.alt = row.photoUrl ? 'Votre photo de ' + row.plant.common_name : 'Photo indisponible';
      const body = document.createElement('div'); body.className = 'plant-card-body';
      const date = document.createElement('span'); date.className = 'plant-card-date'; date.textContent = formatDate(row.date);
      const title = document.createElement('h2'); title.textContent = row.plant.common_name;
      const latin = document.createElement('p'); latin.className = 'latin-name'; latin.textContent = row.plant.scientific_name;
      const summary = document.createElement('p'); summary.className = 'plant-card-description'; summary.textContent = row.plant.summary;
      const location = document.createElement('p'); location.className = 'plant-card-location'; location.textContent = '⌖  ' + formatPosition(row.position);
      body.append(date, title, latin, summary, location);
      if (row.photoError) { const error = document.createElement('p'); error.className = 'form-message'; error.textContent = 'Photo indisponible : reconnectez-vous et réessayez.'; body.append(error); }
      card.append(image, body); list.append(card);
    });
  }
  function renderMap() {
    const points = discoveries.filter(row => row.position && Number.isFinite(Number(row.position.lat)) && Number.isFinite(Number(row.position.lng)));
    el('map-count').textContent = points.length + (points.length > 1 ? ' lieux enregistrés' : ' lieu enregistré');
    if (!window.L) { el('map-message').textContent = 'La carte nécessite Internet pour charger Leaflet et OpenStreetMap.'; return; }
    el('map-message').textContent = points.length ? '' : 'Aucun point GPS. Autorisez la localisation lors d’une découverte.';
    if (!map) {
      map = L.map('map', { scrollWheelZoom: false }).setView([42.08, 9.08], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
      markers = L.featureGroup().addTo(map);
    }
    markers.clearLayers();
    points.forEach(row => {
      const popup = document.createElement('div');
      if (row.photoUrl) { const image = document.createElement('img'); image.className = 'popup-photo'; image.src = row.photoUrl; image.alt = ''; popup.append(image); }
      const name = document.createElement('div'); name.className = 'popup-title'; name.textContent = row.plant.common_name;
      const date = document.createElement('div'); date.className = 'popup-meta'; date.textContent = formatDate(row.date);
      popup.append(name, date);
      L.circleMarker([row.position.lat, row.position.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#334b38', fillOpacity: 1 }).bindPopup(popup).addTo(markers);
    });
    if (points.length === 1) map.setView([points[0].position.lat, points[0].position.lng], 11);
    else if (points.length > 1) map.fitBounds(markers.getBounds().pad(0.25));
  }
  function setAuthTab(tab) {
    authTab = tab;
    el('tab-login').classList.toggle('is-selected', tab === 'login');
    el('tab-signup').classList.toggle('is-selected', tab === 'signup');
    el('auth-title').innerHTML = tab === 'login' ? 'Le maquis, <em>à vous.</em>' : 'Créer votre <em>herbier.</em>';
    el('auth-submit').textContent = tab === 'login' ? 'Se connecter' : 'Créer mon compte';
    el('auth-password').autocomplete = tab === 'login' ? 'current-password' : 'new-password';
    el('auth-message').textContent = '';
  }
  async function submitAuth(event) {
    event.preventDefault();
    if (!db) { el('auth-message').textContent = 'Supabase non configuré. Utilisez le mode démo.'; return; }
    const button = el('auth-submit'); button.disabled = true; button.textContent = 'Un instant…';
    try {
      const credentials = { email: el('auth-email').value.trim(), password: el('auth-password').value };
      const result = authTab === 'login' ? await db.auth.signInWithPassword(credentials) : await db.auth.signUp({
        ...credentials, options: { emailRedirectTo: window.location.origin + window.location.pathname }
      });
      if (result.error) throw result.error;
      if (result.data.session) await enterAccount(result.data.session);
      else el('auth-message').textContent = 'Compte créé. Vérifiez votre e-mail, puis connectez-vous.';
    } catch (error) { el('auth-message').textContent = error.message; }
    finally { button.disabled = false; button.textContent = authTab === 'login' ? 'Se connecter' : 'Créer mon compte'; }
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.view === 'scanner') openScanner();
    else { if (activeDialog && activeDialog !== authDialog) closeDialog(activeDialog); showView(button.dataset.view); }
  }));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); showView('scanner'); });
  el('hero-scan').addEventListener('click', openScanner);
  el('take-photo').addEventListener('click', async () => {
    await startCamera();
    if (!cameraStream) el('camera-input').click();
  });
  el('import-photo').addEventListener('click', () => el('gallery-input').click());
  el('camera-input').addEventListener('change', handlePhoto);
  el('gallery-input').addEventListener('change', handlePhoto);
  async function captureAndAnalyze() {
    if (scanInProgress || photoPreparationInProgress) return;
    photoPreparationInProgress = true;
    const token = ++scanToken;
    const button = el('identify-live');
    button.disabled = true;
    try {
      photo = await captureLivePhoto();
      if (token !== scanToken) return;
      el('photo-preview').src = photo.dataUrl;
      el('preview-area').hidden = false;
      photoPreparationInProgress = false;
      await analyzePhoto(token);
    } catch (error) { if (token === scanToken) scanError(error.message || 'Capture impossible.'); }
    finally { photoPreparationInProgress = false; button.disabled = false; }
  }
  el('identify-live').addEventListener('click', captureAndAnalyze);
  el('retry-button').addEventListener('click', () => {
    if (cameraStream) captureAndAnalyze();
    else if (photo) analyzePhoto();
  });
  el('save-encounter').addEventListener('click', saveEncounter);
  el('exit-encounter').addEventListener('click', () => closeDialog(resultDialog));
  el('encounter-ar').addEventListener('click', async () => {
    try {
      if (encounter3d.isAR) await encounter3d.stopAR();
      else await encounter3d.startAR();
    }
    catch (error) { el('encounter-error').textContent = error.message || 'Ancrage AR indisponible.'; }
  });
  el('replay-speech').addEventListener('click', () => playAnswer(el('guide-text').textContent));
  el('microphone-button').addEventListener('click', toggleMicrophone);
  el('tab-login').addEventListener('click', () => setAuthTab('login'));
  el('tab-signup').addEventListener('click', () => setAuthTab('signup'));
  el('auth-form').addEventListener('submit', submitAuth);
  el('demo-button').addEventListener('click', enterDemo);
  el('account-button').addEventListener('click', async () => {
    if (mode === 'account') { await db.auth.signOut(); scanToken++; mode = null; user = null; discoveries = []; el('auth-close').hidden = true; renderInventory(); openDialog(authDialog); }
    else openDialog(authDialog);
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('.dialog-backdrop'); closeDialog(dialog);
  }));
  document.querySelectorAll('.dialog-backdrop').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog && dialog !== authDialog) closeDialog(dialog); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeDialog && activeDialog !== authDialog) closeDialog(activeDialog); });
  async function init() {
    renderInventory();
    if (!db) {
      el('auth-intro').textContent = 'Supabase et API de reconnaissance non configurés. Vous pouvez essayer le mode démo.';
      el('auth-form').hidden = true; document.querySelector('.auth-tabs').hidden = true;
      openDialog(authDialog); return;
    }
    db.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' && mode === 'account') { scanToken++; mode = null; user = null; discoveries = []; el('auth-close').hidden = true; renderInventory(); openDialog(authDialog); }
      else if (event === 'SIGNED_IN' && session) setTimeout(() => enterAccount(session), 0);
    });
    const result = await db.auth.getSession();
    if (result.data.session) await enterAccount(result.data.session); else openDialog(authDialog);
  }
  init();
})();
