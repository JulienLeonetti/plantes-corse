# Maquis — plantes de Corse

Application statique en HTML, CSS et JavaScript. Ouvrez le dossier dans VS Code, puis faites **Open with Live Server** sur `index.html`. Aucune installation npm n'est nécessaire pour le site.

## Organisation des fichiers

```text
index.html                 Page d'entrée pour Live Server et GitHub Pages
config.js                  Configuration locale du site
config.example.js          Exemple des paramètres à renseigner
assets/css/style.css       Styles de l'interface
assets/js/script.js        Caméra, reconnaissance, compte, herbier et carte
assets/js/encounter3d.js  Rencontre avec le berger 3D et WebXR
data/plantes.js           Catalogue du mode démo
images/                   Illustrations et modèle berger.glb
database/supabase-setup.sql  Schéma et données Supabase
worker/index.js           API Cloudflare protégeant les clés privées
```

Les chemins restent relatifs à `index.html` pour fonctionner aussi dans un sous-dossier GitHub Pages. Conservez `images/berger.glb` à cet emplacement : la rencontre 3D le charge depuis la racine du site.

## Essai immédiat

Si Supabase n'est pas configuré, choisissez **Essayer le mode démo**, puis **Scanner**. Sélectionnez explicitement une plante de démonstration, autorisez la caméra, cadrez la plante et utilisez le bouton circulaire. La reconnaissance simulée ouvre une rencontre : la vidéo continue derrière le berger 3D. Faites glisser le berger pour le tourner, posez une question ou utilisez la voix. **Photographier et enregistrer** prend alors le cliché final et ajoute la découverte à l'herbier et à la carte si un point GPS est disponible. **Quitter** ferme la rencontre sans enregistrer. Si la caméra en direct est indisponible, importez une image ou utilisez la caméra native ; la rencontre affiche alors la photo fixe. Le mode démo utilise `localStorage` et ne communique pas avec Supabase.

Le personnage est rendu par Three.js depuis `images/berger.glb`, avec un canvas transparent sur la vidéo. Three.js est chargé par CDN et import map, sans npm. Le modèle pèse environ 39 Mo et se charge après l'identification ; `berger.svg` apparaît si le chargement échoue. Sur les appareils compatibles, **Activer AR** ouvre WebXR : l'application cherche automatiquement une surface horizontale stable, puis place le berger sans toucher l'écran. Elle utilise une ancre XR si disponible, sinon une pose fixe dans l'espace WebXR. Sans WebXR, le berger reste une superposition 3D stable, sans ancrage dans le monde réel.

## Activer Supabase

1. Créez un projet sur [Supabase](https://supabase.com/dashboard).
2. Dans **SQL Editor**, collez et exécutez le contenu entier de `database/supabase-setup.sql`. Il crée `profiles`, `plants`, `discoveries`, les politiques RLS et le bucket privé `plant-photos`.
3. Dans **Project Settings → API Keys**, relevez l'URL du projet et sa clé **publishable** ou `anon`. N'utilisez jamais `service_role` dans le navigateur ou dans ce dépôt.
4. Dans **Authentication → URL Configuration**, ajoutez l'URL exacte de Live Server à **Redirect URLs** (par exemple `http://127.0.0.1:5500/index.html`). Ajoutez plus tard l'URL GitHub Pages. Vérifiez aussi le **Site URL**. Par défaut, Supabase peut demander de confirmer l'adresse e-mail.
5. Renseignez `supabaseUrl` et `supabaseAnonKey` dans `config.js`. Ce fichier est actuellement versionné : n'y mettez que la clé publique publishable/anon et l'URL du Worker. `config.example.js` montre seulement les noms des paramètres.

Le compte et la session sont gérés par Supabase Auth. Les données des comptes sont isolées par les politiques RLS. Les photos sont dans un bucket privé ; l'application récupère une URL signée temporaire pour les afficher.

## Déployer le Cloudflare Worker sans npm

1. Créez un Worker JavaScript dans **Cloudflare → Workers & Pages** et ouvrez son éditeur de code.
2. Remplacez le code initial par `worker/index.js`, puis déployez le Worker.
3. Dans **Settings → Variables and Secrets**, ajoutez :

   | Nom | Type | Valeur |
   | --- | --- | --- |
   | `SUPABASE_URL` | Secret ou variable | URL du projet Supabase |
   | `SUPABASE_ANON_KEY` | Secret ou variable | clé publishable/anon du projet |
   | `PLANTNET_API_KEY` | Secret | clé privée Pl@ntNet |
   | `OPENAI_API_KEY` | Secret | clé OpenAI pour transcription, classement des questions et voix |
   | `ALLOWED_ORIGINS` | Variable | origines autorisées, séparées par des virgules, sans `/` final : `http://127.0.0.1:5500,http://localhost:5500,https://utilisateur.github.io` |
   | `OPENAI_CHAT_MODEL` | Variable facultative | modèle de classement ; défaut : `gpt-4o-mini` |

4. Déployez de nouveau si le tableau de bord le demande. Dans `config.js`, renseignez `workerUrl` avec l'URL `https://…workers.dev` sans `/` final.
5. Ouvrez `https://…workers.dev/health` pour voir quelles capacités ont une clé configurée. Cette route n'affiche jamais les clés.

L'origine autorisée doit correspondre exactement à l'adresse affichée dans le navigateur, port compris.

Le Worker vérifie le jeton Supabase de chaque requête, protège la clé Pl@ntNet, et expose `/identify`, `/transcribe`, `/chat` et `/speak`. Pour éviter d'inventer un usage, une recette ou une légende, `/chat` utilise l'IA uniquement pour classer la question ; la réponse est reprise des faits renseignés dans `plants.facts`. Si le champ manque, le berger dit que l'information n'est pas vérifiée. Sans `OPENAI_API_KEY`, les boutons de questions utilisent un classement simple et la lecture revient à `speechSynthesis` ; le microphone reste indisponible.

## Vérifier le parcours complet

1. Ouvrez le site avec Live Server et créez un compte A. Confirmez l'e-mail si Supabase le demande.
2. Identifiez une des **quatre espèces du catalogue** sans quitter la caméra. Autorisez la localisation si vous voulez un marqueur. Vérifiez la rencontre, puis touchez **Photographier et enregistrer** et contrôlez l'herbier et la carte.
3. Déconnectez-vous, créez un compte B et vérifiez que la découverte A n'apparaît pas. Créez une découverte B, puis reconnectez A et vérifiez que seul son herbier revient.
4. Pour vérifier la RLS côté base, lancez dans **SQL Editor** une requête avec un jeton utilisateur limité ou utilisez deux sessions navigateur distinctes ; une session B ne doit pas pouvoir lire les lignes ou objets de A.
5. Testez une photo d'une plante hors du catalogue : elle doit afficher « Cette plante n’est pas encore répertoriée dans le catalogue corse. » et ne doit pas créer de carte.

La reconnaissance réelle exige une clé Pl@ntNet. La transcription, le classement IA et la voix générée exigent une clé OpenAI. Le GPS, la caméra en direct, le microphone et WebXR demandent un contexte sécurisé : `localhost` fonctionne en local ; sur un téléphone via l'adresse IP du PC, utilisez HTTPS. GitHub Pages fournit HTTPS. WebXR AR dépend aussi du navigateur et du téléphone ; il ne peut pas être vérifié sur un ordinateur classique. La clé Supabase publishable est publique, mais les clés Pl@ntNet et OpenAI doivent rester uniquement dans le Worker.
