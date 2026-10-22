export type SwarmActivityState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'syncing'
  | 'complete'
  | 'stopped'
  | 'error';

export type SwarmActivityMeta = {
  state: SwarmActivityState;
  label: string;
  detail: string;
  isLive: boolean;
};

export function deriveSwarmActivity(input: {
  statusLabel: string;
  isLaunching: boolean;
  isSyncing: boolean;
  runningCount: number;
  agentCount: number;
  hasError: boolean;
}): SwarmActivityMeta {
  const { statusLabel, isLaunching, isSyncing, runningCount, agentCount, hasError } = input;

  if (hasError || statusLabel.toLowerCase().includes('error')) {
    return {
      state: 'error',
      label: 'Error',
      detail: statusLabel,
      isLive: false,
    };
  }

  if (statusLabel === 'Stopped') {
    return {
      state: 'stopped',
      label: 'Stopped',
      detail: 'Swarm run was stopped',
      isLive: false,
    };
  }

  if (isSyncing) {
    return {
      state: 'syncing',
      label: 'Coordinator syncing',
      detail: statusLabel,
      isLive: true,
    };
  }

  if (isLaunching) {
    const status = statusLabel.toLowerCase();
    const planning = status.includes('planning') || status.includes('processing images');
    const processingImages = status.includes('processing images');
    return {
      state: planning ? 'planning' : 'running',
      label: processingImages ? 'Processing images' : planning ? 'Planning swarm' : statusLabel || 'Swarm running',
      detail: processingImages
        ? 'Saving references and running vision analysis'
        : planning
          ? 'Coordinator is splitting work into lanes'
          : 'Agents are executing in parallel',
      isLive: true,
    };
  }

  if (runningCount > 0) {
    return {
      state: 'running',
      label: statusLabel || 'Swarm running',
      detail: `${runningCount} agent${runningCount === 1 ? '' : 's'} active`,
      isLive: true,
    };
  }

  if (statusLabel === 'Complete' && agentCount > 0) {
    return {
      state: 'complete',
      label: 'Complete',
      detail: 'All agents finished this run',
      isLive: false,
    };
  }

  return {
    state: 'idle',
    label: 'Idle',
    detail: 'Describe a goal and launch a swarm',
    isLive: false,
  };
}
