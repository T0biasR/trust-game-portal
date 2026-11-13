/// <reference types="vite/client" />

declare const jatos:
  | undefined
  | {
      workerId?: string;
      studySessionData?: unknown;
      componentJsonInput?: unknown;
      onLoad: (callback: () => void) => void;
      submitResultData: (data: string, onSuccess?: () => void, onError?: () => void) => void;
      startNextComponent: (data?: string) => void;
      endStudy: (data?: string) => void;
    };
