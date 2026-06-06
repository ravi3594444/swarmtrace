import { useApiLiveTraces } from "./use-api-live-traces";

/**
 * Hook for getting live traces - now uses the API-connected version
 */
export function useLiveTraces(enabled: boolean) {
  return useApiLiveTraces(enabled);
}
