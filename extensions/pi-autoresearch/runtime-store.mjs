export function createExperimentState() {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
  };
}

export function createSessionRuntime() {
  return {
    autoresearchMode: false,
    dashboardExpanded: false,
    lastAutoResumeTime: 0,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    runningExperiment: null,
    state: createExperimentState(),
  };
}

export function createRuntimeStore() {
  const runtimes = new Map();

  return {
    ensure(sessionKey) {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey) {
      runtimes.delete(sessionKey);
    },
  };
}
