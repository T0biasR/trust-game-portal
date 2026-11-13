import { configureHostedApi, type HostMode } from "../api";

export type HostConfig = {
  host: Exclude<HostMode, "portal">;
  apiOrigin: string;
  deploymentId: string;
  clientVersion: string;
  completionUrl?: string;
};

export type HostAdapter = {
  initialize: () => Promise<{
    hostSessionId: string;
    participantId?: string;
  }>;
  complete: (payload: Record<string, unknown>) => Promise<void>;
  abort: (reason: string) => Promise<void>;
};

function randomSessionId() {
  return crypto.randomUUID();
}

function makeJatosAdapter(config: HostConfig): HostAdapter {
  return {
    async initialize() {
      if (typeof jatos === "undefined" || !jatos) {
        return { hostSessionId: randomSessionId() };
      }
      await new Promise<void>((resolve) => jatos.onLoad(resolve));
      return {
        hostSessionId: randomSessionId(),
        participantId: jatos.workerId,
      };
    },
    async complete(payload) {
      if (typeof jatos === "undefined" || !jatos) return;
      const encoded = JSON.stringify(payload);
      await new Promise<void>((resolve) => {
        jatos.submitResultData(encoded, resolve, resolve);
      });
      try {
        jatos.endStudy(encoded);
      } catch {
        // Preview mode can reject duplicate completion calls.
      }
    },
    async abort(reason) {
      if (typeof jatos === "undefined" || !jatos) return;
      await new Promise<void>((resolve) => {
        jatos.submitResultData(JSON.stringify({ aborted: true, reason }), resolve, resolve);
      });
    },
  };
}

function makePavloviaAdapter(config: HostConfig): HostAdapter {
  return {
    async initialize() {
      const params = new URLSearchParams(window.location.search);
      return {
        hostSessionId: params.get("session") || randomSessionId(),
        participantId: params.get("participant") || undefined,
      };
    },
    async complete() {
      if (config.completionUrl) window.location.assign(config.completionUrl);
    },
    async abort() {
      // Pavlovia does not require a second result channel; the API is authoritative.
    },
  };
}

let activeAdapter: HostAdapter | null = null;

export async function initializeHostedRuntime(config: HostConfig) {
  activeAdapter = config.host === "jatos"
    ? makeJatosAdapter(config)
    : makePavloviaAdapter(config);
  const context = await activeAdapter.initialize();
  configureHostedApi({
    host: config.host,
    apiOrigin: config.apiOrigin,
    hostSessionId: context.hostSessionId,
    deploymentId: config.deploymentId,
    clientVersion: config.clientVersion,
  });
  return context;
}

export async function completeHostedRuntime(payload: Record<string, unknown>) {
  await activeAdapter?.complete(payload);
}

export async function abortHostedRuntime(reason: string) {
  await activeAdapter?.abort(reason);
}
