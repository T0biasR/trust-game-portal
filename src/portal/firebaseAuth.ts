import { getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  getMultiFactorResolver,
  TotpMultiFactorGenerator,
  signInWithEmailAndPassword,
  signOut,
  type MultiFactorError,
  type MultiFactorResolver,
} from "firebase/auth";

let pendingResolver: MultiFactorResolver | null = null;

function authClient() {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !authDomain || !appId || !projectId)
    throw new Error("Die Researcher-Anmeldung ist für diese Bereitstellung nicht konfiguriert.");
  const app = getApps()[0] ?? initializeApp({
    apiKey,
    authDomain,
    appId,
    projectId,
  });
  return getAuth(app);
}

export async function signInResearcher(email: string, password: string, totp: string) {
  const auth = authClient();
  if (pendingResolver) {
    const hint = pendingResolver.hints.find((factor) => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID);
    if (!hint) throw new Error("Für dieses Konto ist kein TOTP-Zweitfaktor eingerichtet.");
    const credential = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, totp);
    const result = await pendingResolver.resolveSignIn(credential);
    pendingResolver = null;
    return result.user.getIdToken(true);
  }
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    // The API also verifies that a second factor was used and rejects accounts
    // that have not completed MFA enrollment.
    return result.user.getIdToken(true);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/multi-factor-auth-required") {
      pendingResolver = getMultiFactorResolver(auth, error as MultiFactorError);
      throw new Error("Geben Sie jetzt den aktuellen 6-stelligen Authenticator-Code ein.");
    }
    throw error;
  }
}

export async function currentResearcherToken() {
  try {
    const user = authClient().currentUser;
    return user ? await user.getIdToken() : null;
  } catch {
    return null;
  }
}

export async function signOutResearcher() {
  pendingResolver = null;
  await signOut(authClient());
}
