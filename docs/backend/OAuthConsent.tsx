// OAuthConsent.tsx — RÉFÉRENCE à intégrer dans truecalling-app (React).
// (Livré ici dans truecalling-mcp/docs/backend/ ; truecalling-app non touché.)
//
// CONTEXTE : Supabase OAuth 2.1 Server N'HÉBERGE PAS d'écran de consentement.
// L'app DOIT exposer une page (ex. https://app.truecalling.ai/oauth/consent)
// vers laquelle Supabase redirige pendant /oauth/authorize. Sans elle, après
// login l'utilisateur reste sur l'app et ChatGPT ne reçoit jamais le code.
//
// À FAIRE PAR LE CTO :
//   1. Ajouter cette page à la route /oauth/consent (react-router) — route
//      PUBLIQUE (pas derrière le guard d'auth, sinon le guard redirige et on
//      perd authorization_id ; la page gère elle-même le « pas connecté »).
//   2. Adapter l'import du client supabase (chemin réel du projet).
//   3. Configurer le « Authorization path » côté Supabase pour qu'il pointe
//      sur https://app.truecalling.ai/oauth/consent (Dashboard → Auth → OAuth
//      Server settings, ou config.toml [auth.oauth_server]).
//   4. Styler aux couleurs TrueCalling (magenta #E91E8C).
//
// API VÉRIFIÉE contre @supabase/auth-js 2.105.x (méthodes + champ redirect_url
// confirmés dans lib/types.d.ts) :
//   - supabase.auth.oauth.getAuthorizationDetails(id)
//       → { data: OAuthAuthorizationDetails | OAuthRedirect }
//         (peut renvoyer directement un redirect_url si déjà consenti)
//   - supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect })
//   - supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect })
//       → { data: { redirect_url } }  (redirige seul si skipBrowserRedirect=false)
// On force skipBrowserRedirect:true pour garder le contrôle des erreurs.

import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "../services/supabaseClient"; // chemin réel du projet

interface AuthDetails {
  client?: { name?: string; redirect_uri?: string };
  scopes?: string[];
}

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const authorizationId = params.get("authorization_id");

  const [details, setDetails] = useState<AuthDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!authorizationId) {
        setError("Lien d'autorisation invalide ou expiré.");
        return;
      }
      // Doit être connecté. Sinon → login en PRÉSERVANT authorization_id, pour
      // revenir ici après (le flux OAuth ne doit pas être perdu).
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        const back = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
        navigate(`/login?redirect=${encodeURIComponent(back)}`);
        return;
      }
      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (error) {
        setError(error.message);
        return;
      }
      // Consentement déjà donné → Supabase renvoie directement un redirect_url.
      const maybeRedirect = (data as { redirect_url?: string })?.redirect_url;
      if (maybeRedirect) {
        window.location.href = maybeRedirect;
        return;
      }
      setDetails(data as AuthDetails);
    })();
  }, [authorizationId, navigate]);

  const approve = async () => {
    if (!authorizationId) return;
    setBusy(true);
    const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId, {
      skipBrowserRedirect: true,
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    // URL de retour AVEC le code → ChatGPT reçoit le code, la connexion se boucle.
    window.location.href = (data as { redirect_url: string }).redirect_url;
  };

  const deny = async () => {
    if (!authorizationId) return;
    setBusy(true);
    const { data } = await supabase.auth.oauth.denyAuthorization(authorizationId, {
      skipBrowserRedirect: true,
    });
    window.location.href = (data as { redirect_url?: string })?.redirect_url ?? "/";
  };

  if (error) return <div style={{ padding: 24 }}>Erreur&nbsp;: {error}</div>;
  if (!details) return <div style={{ padding: 24 }}>Chargement…</div>;

  const appName = details.client?.name ?? "Cette application";

  return (
    <div style={{ maxWidth: 420, margin: "10vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 20 }}>Autoriser l'accès</h1>
      <p>
        <strong>{appName}</strong> demande l'accès à votre compte TrueCalling
        {details.scopes?.length ? ` (${details.scopes.join(", ")})` : ""}.
      </p>
      <p style={{ color: "#666", fontSize: 14 }}>
        En autorisant, {appName} pourra agir en votre nom via vos outils TrueCalling.
        Vous ne verrez que vos propres données.
      </p>
      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <button onClick={deny} disabled={busy} style={{ flex: 1 }}>
          Refuser
        </button>
        <button
          onClick={approve}
          disabled={busy}
          style={{ flex: 1, background: "#E91E8C", color: "#fff", border: "none", padding: 10 }}
        >
          Autoriser
        </button>
      </div>
    </div>
  );
}
