/* Cloudflare Worker sans dépendance. Collez ce fichier dans l'éditeur du Worker.
   Secrets : PLANTNET_API_KEY, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY.
   Variable : ALLOWED_ORIGINS (origines exactes séparées par des virgules).
   Aucun secret ne doit être copié dans le site statique. */

const json = (body, status = 200, cors = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors }
});

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

async function authenticatedUser(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error('SUPABASE_NOT_CONFIGURED');
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const response = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization }
  });
  return response.ok ? response.json() : null;
}

async function identify(request, env, cors) {
  if (!env.PLANTNET_API_KEY) return json({ error: 'API de reconnaissance non configurée' }, 503, cors);
  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File) || !['image/jpeg', 'image/png'].includes(image.type) || image.size > 10_000_000) {
    return json({ error: 'Envoyez une photo JPEG ou PNG de moins de 10 Mo.' }, 400, cors);
  }
  const outgoing = new FormData();
  outgoing.append('images', image, image.name || 'plante.jpg');
  outgoing.append('organs', 'auto');
  const url = new URL('https://my-api.plantnet.org/v2/identify/all');
  url.searchParams.set('api-key', env.PLANTNET_API_KEY);
  url.searchParams.set('lang', 'fr');
  url.searchParams.set('nb-results', '1');
  const upstream = await fetch(url, { method: 'POST', body: outgoing });
  if (!upstream.ok) return json({ error: upstream.status === 429 ? 'Quota Pl@ntNet atteint. Réessayez plus tard.' : 'Identification Pl@ntNet indisponible.' }, upstream.status === 429 ? 429 : 502, cors);
  const data = await upstream.json();
  const first = data.results && data.results[0];
  if (!first || !first.species) return json({ error: 'Aucune plante reconnue. Prenez une autre photo.' }, 422, cors);
  const scientificName = String(first.species.scientificNameWithoutAuthor || first.species.scientificName || '').trim();
  if (!scientificName) return json({ error: 'Nom scientifique indisponible.' }, 502, cors);
  return json({ scientificName, commonName: first.species.commonNames && first.species.commonNames[0] || scientificName, score: Number(first.score) }, 200, cors);
}

async function transcribe(request, env, cors) {
  if (!env.OPENAI_API_KEY) return json({ error: 'Services vocaux non configurés' }, 503, cors);
  const incoming = await request.formData();
  const audio = incoming.get('audio');
  if (!(audio instanceof File) || !audio.type.startsWith('audio/') || audio.size > 20_000_000) return json({ error: 'Enregistrement audio invalide ou trop volumineux.' }, 400, cors);
  const form = new FormData();
  form.append('file', audio, audio.name || 'question.webm');
  form.append('model', 'gpt-transcribe');
  form.append('language', 'fr');
  const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: form
  });
  if (!upstream.ok) return json({ error: 'Transcription momentanément indisponible.' }, 502, cors);
  const data = await upstream.json();
  return json({ text: String(data.text || '').slice(0, 500) }, 200, cors);
}

async function plantFacts(scientificName, token, env) {
  const url = new URL(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/plants');
  url.searchParams.set('scientific_name', 'eq.' + scientificName);
  url.searchParams.set('select', 'common_name,scientific_name,facts');
  const response = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: token } });
  if (!response.ok) throw new Error('CATALOG_UNAVAILABLE');
  const rows = await response.json();
  return rows[0] || null;
}

function keywordTopic(question) {
  const value = question.toLocaleLowerCase('fr');
  if (/toxique|toxicité|danger|manger|consommer|poison/.test(value)) return 'toxicite';
  if (/fleur|floraison|fleurit|saison/.test(value)) return 'floraison';
  if (/où|lieu|pousse|trouve|habitat|région/.test(value)) return 'lieux';
  if (/recette|cuisine|préparer|plat/.test(value)) return 'recette';
  if (/légende|histoire|conte/.test(value)) return 'legende';
  if (/usage|tradition|soigner|médecin/.test(value)) return 'usages';
  if (/feuille|couleur|taille|reconnaître|caractéristique/.test(value)) return 'caracteristiques';
  return 'inconnu';
}

async function aiTopic(question, env) {
  if (!env.OPENAI_API_KEY) return keywordTopic(question);
  // L'IA classe seulement la question. La réponse vient exclusivement des faits approuvés.
  const upstream = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_CHAT_MODEL || 'gpt-4o-mini', store: false,
      instructions: 'Classe la question dans exactement un mot parmi: caracteristiques, floraison, lieux, toxicite, recette, usages, legende, inconnu. Réponds avec ce mot seul. Ne donne aucun fait botanique.',
      input: question, max_output_tokens: 30
    })
  });
  if (!upstream.ok) throw new Error('AI_UNAVAILABLE');
  const data = await upstream.json();
  const output = (data.output || []).flatMap(item => item.content || []).map(item => item.text || '').join('').trim().toLowerCase();
  return ['caracteristiques', 'floraison', 'lieux', 'toxicite', 'recette', 'usages', 'legende'].includes(output) ? output : 'inconnu';
}

async function chat(request, env, cors) {
  const body = await request.json();
  const question = String(body.question || '').trim().slice(0, 500);
  const scientificName = String(body.scientificName || '').trim().slice(0, 150);
  if (!question || !scientificName) return json({ error: 'Question ou plante manquante.' }, 400, cors);
  const plant = await plantFacts(scientificName, request.headers.get('Authorization'), env);
  if (!plant) return json({ error: 'Plante absente du catalogue corse vérifié.' }, 404, cors);
  const topic = await aiTopic(question, env);
  const fact = plant.facts && plant.facts[topic];
  const answer = fact || 'Je n’ai pas d’information vérifiée sur ce sujet pour ' + plant.common_name + '. Je préfère ne rien inventer.';
  return json({ answer, topic, aiAssisted: Boolean(env.OPENAI_API_KEY) }, 200, cors);
}

async function speak(request, env, cors) {
  if (!env.OPENAI_API_KEY) return json({ error: 'Services vocaux non configurés' }, 503, cors);
  const body = await request.json();
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) return json({ error: 'Texte manquant.' }, 400, cors);
  const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: text,
      instructions: 'Parle en français avec chaleur et sobriété, comme un guide corse adulte.', response_format: 'mp3' })
  });
  if (!upstream.ok) return json({ error: 'Synthèse vocale indisponible.' }, 502, cors);
  return new Response(upstream.body, { status: 200, headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (origin && !cors) return json({ error: 'Origine non autorisée.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors || {} });
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ identify: Boolean(env.PLANTNET_API_KEY), voice: Boolean(env.OPENAI_API_KEY) }, 200, cors || {});
    if (request.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405, cors || {});
    try {
      const user = await authenticatedUser(request, env);
      if (!user || !user.id) return json({ error: 'Session non valide.' }, 401, cors || {});
      if (path === '/identify') return await identify(request, env, cors || {});
      if (path === '/transcribe') return await transcribe(request, env, cors || {});
      if (path === '/chat') return await chat(request, env, cors || {});
      if (path === '/speak') return await speak(request, env, cors || {});
      return json({ error: 'Route inconnue.' }, 404, cors || {});
    } catch (error) {
      if (error.message === 'SUPABASE_NOT_CONFIGURED') return json({ error: 'Authentification du Worker non configurée.' }, 503, cors || {});
      return json({ error: 'Service temporairement indisponible.' }, 502, cors || {});
    }
  }
};
