"use strict";

// Track completed work for each provider's session rotation without sharing
// execution permits between the providers' independent queues.
function trackCompletedSessions(queue, driver, sessionStats) {
  const runJob = queue.runJob.bind(queue);
  queue.runJob = async (job, options = {}) => {
    if (queue.shuttingDown || job.status !== "queued") return;
    await runJob(job, options);
    if (job.status !== "done") return;
    const key = `${driver.getBrowserEngine()}:${options.slotId || 0}`;
    const state = sessionStats.get(queue.workerSlots.get(key));
    if (state) state.completed += 1;
  };
}

module.exports = { trackCompletedSessions };
