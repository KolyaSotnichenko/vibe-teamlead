/**
 * The Environment tab's state for a project: what main stored and the last results of setup,
 * the database and the push after a merge, kept live through main's events.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  DeployAddDatabaseResult,
  DeployEnvState,
  DeployServiceKind,
  DeploySetupState,
  DeploySetupStep,
} from '../../../shared/types/deploy';

export interface DeployEnv {
  /** null until the first answer from main. */
  state: DeployEnvState | null;
  /** The step setup reports while it runs. */
  progress?: DeploySetupStep;
  /** An IPC call failed outright (not a setup/database result). */
  requestFailed: boolean;
  refresh: () => Promise<void>;
  /** `vercelTeamId`: null = personal account; omitted = keep the stored choice. */
  setUp: (opts?: { vercelTeamId?: string | null }) => Promise<DeploySetupState | undefined>;
  chooseVercelProject: (choice: { useProjectId: string } | { createNew: true }) => Promise<void>;
  addDatabase: (acceptTerms?: boolean) => Promise<void>;
  /** Cancels Add database while it downloads the Vercel CLI. */
  cancelDatabase: () => void;
  /** Adds Redis or Blob; same terms and download flow as the database. */
  addService: (service: DeployServiceKind, acceptTerms?: boolean) => Promise<void>;
  cancelService: (service: DeployServiceKind) => void;
}

const EMPTY: DeployEnvState = { settings: null, setupRunning: false, databaseRunning: false };

export function useDeployEnv(projectId: string, onSetUpDone?: () => void): DeployEnv {
  const [state, setState] = useState<DeployEnvState | null>(null);
  const [progress, setProgress] = useState<DeploySetupStep | undefined>();
  const [requestFailed, setRequestFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.deploy.state(projectId);
      if (result.success && result.data) {
        setState(result.data);
        setRequestFailed(false);
      } else {
        setState((s) => s ?? EMPTY);
        setRequestFailed(true);
      }
    } catch {
      setState((s) => s ?? EMPTY);
      setRequestFailed(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const deploy = window.electronAPI.deploy;
    const offProgress = deploy.onSetupProgress((p) => {
      if (p.projectId === projectId) setProgress(p.step);
    });
    const offPush = deploy.onPushResult((r) => {
      if (r.projectId === projectId) setState((s) => ({ ...(s ?? EMPTY), lastPush: r }));
    });
    const offDatabase = deploy.onDatabaseProgress((p) => {
      if (p.projectId !== projectId) return;
      setState((s) => {
        const next: DeployEnvState = { ...(s ?? EMPTY) };
        const service = p.service;
        if (service) {
          const downloads = { ...next.serviceDownload };
          if (p.download) downloads[service] = p.download;
          else delete downloads[service];
          next.serviceDownload = downloads;
        } else if (p.download) next.databaseDownload = p.download;
        else delete next.databaseDownload;
        return next;
      });
    });
    return () => {
      offProgress();
      offPush();
      offDatabase();
    };
  }, [projectId, refresh]);

  const applySetup = useCallback(
    (result: Awaited<ReturnType<typeof window.electronAPI.deploy.setUp>>) => {
      setProgress(undefined);
      if (result.success && result.data) {
        const data = result.data;
        setState((s) => ({ ...(s ?? EMPTY), settings: data.settings, setupRunning: false, lastSetup: data }));
        setRequestFailed(false);
        if (data.step === 'done') onSetUpDone?.();
        return data;
      }
      // 'busy' and other refusals: main's state says what is going on
      void refresh();
      if (result.error !== 'busy') setRequestFailed(true);
      return undefined;
    },
    [onSetUpDone, refresh]
  );

  const setUp = useCallback(
    async (opts?: { vercelTeamId?: string | null }) => {
      setState((s) => ({ ...(s ?? EMPTY), setupRunning: true }));
      setProgress(undefined);
      try {
        return applySetup(await window.electronAPI.deploy.setUp(projectId, opts));
      } catch {
        setRequestFailed(true);
        void refresh();
        return undefined;
      }
    },
    [projectId, applySetup, refresh]
  );

  const chooseVercelProject = useCallback(
    async (choice: { useProjectId: string } | { createNew: true }) => {
      setState((s) => ({ ...(s ?? EMPTY), setupRunning: true }));
      try {
        applySetup(await window.electronAPI.deploy.chooseVercelProject(projectId, choice));
      } catch {
        setRequestFailed(true);
        void refresh();
      }
    },
    [projectId, applySetup, refresh]
  );

  const addDatabase = useCallback(
    async (acceptTerms?: boolean) => {
      setState((s) => ({ ...(s ?? EMPTY), databaseRunning: true }));
      let last: DeployAddDatabaseResult | undefined;
      try {
        const result = await window.electronAPI.deploy.addDatabase(projectId, acceptTerms ? { acceptTerms: true } : undefined);
        if (result.success && result.data) last = result.data;
        else setRequestFailed(true);
      } catch {
        setRequestFailed(true);
      }
      setState((s) => {
        const next: DeployEnvState = { ...(s ?? EMPTY), databaseRunning: false, ...(last ? { lastDatabase: last } : {}) };
        delete next.databaseDownload;
        return next;
      });
      // A database that was added is recorded in the settings
      await refresh();
    },
    [projectId, refresh]
  );

  const cancelDatabase = useCallback(() => {
    void Promise.resolve(window.electronAPI.deploy.cancelDatabase(projectId)).catch(() => undefined);
  }, [projectId]);

  const addService = useCallback(
    async (service: DeployServiceKind, acceptTerms?: boolean) => {
      setState((s) => ({ ...(s ?? EMPTY), servicesRunning: [...new Set([...(s?.servicesRunning ?? []), service])] }));
      let last: DeployAddDatabaseResult | undefined;
      try {
        const result = await window.electronAPI.deploy.addService(projectId, service, acceptTerms ? { acceptTerms: true } : undefined);
        if (result.success && result.data) last = result.data;
        else setRequestFailed(true);
      } catch {
        setRequestFailed(true);
      }
      setState((s) => {
        const next: DeployEnvState = {
          ...(s ?? EMPTY),
          servicesRunning: (s?.servicesRunning ?? []).filter((k) => k !== service),
          ...(last ? { lastServices: { ...s?.lastServices, [service]: last } } : {}),
        };
        const downloads = { ...next.serviceDownload };
        delete downloads[service];
        next.serviceDownload = downloads;
        return next;
      });
      await refresh();
    },
    [projectId, refresh]
  );

  const cancelService = useCallback(
    (service: DeployServiceKind) => {
      void Promise.resolve(window.electronAPI.deploy.cancelService(projectId, service)).catch(() => undefined);
    },
    [projectId]
  );

  return { state, progress, requestFailed, refresh, setUp, chooseVercelProject, addDatabase, cancelDatabase, addService, cancelService };
}
