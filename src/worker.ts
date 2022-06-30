import * as assert from "assert";
import { randomBytes } from "crypto";

import { defaults } from "./config";
import deferred from "./deferred";
import { makeJobHelpers } from "./helpers";
import {
  Job,
  TaskList,
  WithPgClient,
  Worker,
  WorkerOptions,
} from "./interfaces";
import { processSharedOptions } from "./lib";
import { completeJob } from "./sql/completeJob";
import { failJob } from "./sql/failJob";
import { getJob } from "./sql/getJob";
import { resetLockedAt } from "./sql/resetLocketAt";

export function makeNewWorker(
  options: WorkerOptions,
  tasks: TaskList,
  withPgClient: WithPgClient,
  continuous = true,
): Worker {
  const {
    workerId = `worker-${randomBytes(9).toString("hex")}`,
    pollInterval = defaults.pollInterval,
    forbiddenFlags,
  } = options;
  const compiledSharedOptions = processSharedOptions(options, {
    scope: {
      label: "worker",
      workerId,
    },
  });
  const {
    logger,
    maxContiguousErrors,
    events,
    useNodeTime,
    minResetLockedInterval,
    maxResetLockedInterval,
  } = compiledSharedOptions;
  const promise = deferred();
  promise.then(
    () => {
      events.emit("worker:stop", { worker });
    },
    (error) => {
      events.emit("worker:stop", { worker, error });
    },
  );
  let activeJob: Job | null = null;

  let doNextTimer: NodeJS.Timer | null = null;
  const cancelDoNext = () => {
    if (doNextTimer !== null) {
      clearTimeout(doNextTimer);
      doNextTimer = null;
      return true;
    }
    return false;
  };
  let active = true;

  const resetLockedDelay = () =>
    Math.ceil(
      minResetLockedInterval +
        Math.random() * (maxResetLockedInterval - minResetLockedInterval),
    );

  let resetLockedAtPromise: Promise<void> | undefined;

  const resetLocked = () => {
    resetLockedAtPromise = resetLockedAt(
      compiledSharedOptions,
      withPgClient,
    ).then(
      () => {
        resetLockedAtPromise = undefined;
        if (active) {
          const delay = resetLockedDelay();
          resetLockedTimeout = setTimeout(resetLocked, delay);
        }
      },
      (e) => {
        resetLockedAtPromise = undefined;
        // TODO: push this error out via an event.
        if (active) {
          const delay = resetLockedDelay();
          resetLockedTimeout = setTimeout(resetLocked, delay);
          logger.error(
            `Failed to reset locked; we'll try again in ${delay}ms`,
            {
              error: e,
            },
          );
        } else {
          logger.error(
            `Failed to reset locked, but we're shutting down so won't try again`,
            {
              error: e,
            },
          );
        }
      },
    );
  };

  // Reset locked in the first 60 seconds, not immediately because we don't
  // want to cause a thundering herd.
  let resetLockedTimeout: NodeJS.Timeout | null = setTimeout(
    resetLocked,
    Math.random() * 60000,
  );

  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    clearTimeout(resetLockedTimeout!);
    resetLockedTimeout = null;
    events.emit("worker:release", { worker });
    if (cancelDoNext()) {
      // Nothing in progress; resolve the promise
      promise.resolve(resetLockedAtPromise);
    }
    return promise;
  };

  const nudge = () => {
    assert(active, "nudge called after worker terminated");
    if (doNextTimer) {
      // Must be idle; call early
      doNext();
      return true;
    } else {
      again = true;
      // Not idle; find someone else!
      return false;
    }
  };

  const worker: Worker = {
    nudge,
    workerId,
    release,
    promise,
    getActiveJob: () => activeJob,
  };

  events.emit("worker:create", { worker, tasks });

  logger.debug(`Spawned`);

  let contiguousErrors = 0;
  let again = false;

  const doNext = async (): Promise<void> => {
    again = false;
    cancelDoNext();
    assert(active, "doNext called when active was false");
    assert(!activeJob, "There should be no active job");

    // Find us a job
    try {
      let flagsToSkip: null | string[] = null;

      if (Array.isArray(forbiddenFlags)) {
        flagsToSkip = forbiddenFlags;
      } else if (typeof forbiddenFlags === "function") {
        const forbiddenFlagsResult = forbiddenFlags();

        if (Array.isArray(forbiddenFlagsResult)) {
          flagsToSkip = forbiddenFlagsResult;
        } else if (forbiddenFlagsResult != null) {
          flagsToSkip = await forbiddenFlagsResult;
        }
      }

      events.emit("worker:getJob:start", { worker });
      const jobRow = await getJob(
        compiledSharedOptions,
        withPgClient,
        tasks,
        workerId,
        useNodeTime,
        flagsToSkip,
      );

      // `doNext` cannot be executed concurrently, so we know this is safe.
      // eslint-disable-next-line require-atomic-updates
      activeJob = jobRow && jobRow.id ? jobRow : null;

      if (activeJob) {
        events.emit("job:start", { worker, job: activeJob });
      } else {
        events.emit("worker:getJob:empty", { worker });
      }
    } catch (err) {
      events.emit("worker:getJob:error", { worker, error: err });
      if (continuous) {
        contiguousErrors++;
        logger.debug(
          `Failed to acquire job: ${err.message} (${contiguousErrors}/${maxContiguousErrors})`,
        );
        if (contiguousErrors >= maxContiguousErrors) {
          promise.reject(
            new Error(
              `Failed ${contiguousErrors} times in a row to acquire job; latest error: ${err.message}`,
            ),
          );
          release();
          return;
        } else {
          if (active) {
            // Error occurred fetching a job; try again...
            doNextTimer = setTimeout(() => doNext(), pollInterval);
          } else {
            promise.reject(err);
          }
          return;
        }
      } else {
        promise.reject(err);
        release();
        return;
      }
    }
    contiguousErrors = 0;

    // If we didn't get a job, try again later (if appropriate)
    if (!activeJob) {
      if (continuous) {
        if (active) {
          if (again) {
            // This could be a synchronisation issue where we were notified of
            // the job but it's not visible yet, lets try again in just a
            // moment.
            doNext();
          } else {
            doNextTimer = setTimeout(() => doNext(), pollInterval);
          }
        } else {
          promise.resolve(resetLockedAtPromise);
        }
      } else {
        promise.resolve(resetLockedAtPromise);
        release();
      }
      return;
    }

    // We did get a job then; store it into the current scope.
    const job = activeJob;

    // We may want to know if an error occurred or not
    let err: Error | null = null;
    try {
      /*
       * Be **VERY** careful about which parts of this code can throw - we
       * **MUST** release the job once we've attempted it (success or error).
       */
      const startTimestamp = process.hrtime();
      try {
        logger.debug(`Found task ${job.id} (${job.task_identifier})`);
        const task = tasks[job.task_identifier];
        assert(task, `Unsupported task '${job.task_identifier}'`);
        const helpers = makeJobHelpers(options, job, { withPgClient, logger });
        await task(job.payload, helpers);
      } catch (error) {
        err = error;
      }
      const durationRaw = process.hrtime(startTimestamp);
      const duration = durationRaw[0] * 1e3 + durationRaw[1] * 1e-6;
      if (err) {
        try {
          events.emit("job:error", { worker, job, error: err });
        } catch (e) {
          logger.error(
            "Error occurred in event emitter for 'job:error'; this is an issue in your application code and you should fix it",
          );
        }
        if (job.attempts >= job.max_attempts) {
          try {
            // Failed forever
            events.emit("job:failed", { worker, job, error: err });
          } catch (e) {
            logger.error(
              "Error occurred in event emitter for 'job:failed'; this is an issue in your application code and you should fix it",
            );
          }
        }

        const { message: rawMessage, stack } = err;

        /**
         * Guaranteed to be a non-empty string
         */
        const message: string =
          rawMessage ||
          String(err) ||
          "Non error or error without message thrown.";

        logger.error(
          `Failed task ${job.id} (${
            job.task_identifier
          }) with error ${message} (${duration.toFixed(2)}ms)${
            stack ? `:\n  ${String(stack).replace(/\n/g, "\n  ").trim()}` : ""
          }`,
          { failure: true, job, error: err, duration },
        );
        await failJob(
          compiledSharedOptions,
          withPgClient,
          workerId,
          job.id,
          message,
        );
      } else {
        try {
          events.emit("job:success", { worker, job });
        } catch (e) {
          logger.error(
            "Error occurred in event emitter for 'job:success'; this is an issue in your application code and you should fix it",
          );
        }
        if (!process.env.NO_LOG_SUCCESS) {
          logger.info(
            `Completed task ${job.id} (${
              job.task_identifier
            }) with success (${duration.toFixed(2)}ms)`,
            { job, duration, success: true },
          );
        }

        await completeJob(
          compiledSharedOptions,
          withPgClient,
          workerId,
          job.id,
        );
      }
      events.emit("job:complete", { worker, job, error: err });
    } catch (fatalError) {
      try {
        events.emit("worker:fatalError", {
          worker,
          error: fatalError,
          jobError: err,
        });
      } catch (e) {
        logger.error(
          "Error occurred in event emitter for 'worker:fatalError'; this is an issue in your application code and you should fix it",
        );
      }

      const when = err ? `after failure '${err.message}'` : "after success";
      logger.error(
        `Failed to release job '${job.id}' ${when}; committing seppuku\n${fatalError.message}`,
        { fatalError, job },
      );
      promise.reject(fatalError);
      release();
      return;
    } finally {
      // `doNext` cannot be executed concurrently, so we know this is safe.
      // eslint-disable-next-line require-atomic-updates
      activeJob = null;
    }
    if (active) {
      doNext();
    } else {
      promise.resolve(resetLockedAtPromise);
    }
  };

  // Start!
  doNext();

  // For tests
  promise["worker"] = worker;

  return worker;
}
