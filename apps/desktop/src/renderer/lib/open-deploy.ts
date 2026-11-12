import type { DeployTarget } from '../../shared/types/deploy';

/** Listens for the `open-deploy` window event (from task cards and the task window); returns the unsubscribe. */
export function listenOpenDeploy(handler: (target: DeployTarget) => void): () => void {
  const onEvent = (event: Event) => handler((event as CustomEvent<DeployTarget | undefined>).detail ?? {});
  window.addEventListener('open-deploy', onEvent);
  return () => window.removeEventListener('open-deploy', onEvent);
}
