import { md5Hash, newObjectId } from './cryptoUtils';
import { logger }               from './logger';

const PUSH_STATUS_COLLECTION = '_PushStatus';
const INSTALLATION_COLLECTION = '_Installation';
const JOB_STATUS_COLLECTION = '_JobStatus';

export function flatten(array) {
  return array.reduce((memo, element) => {
    if (Array.isArray(element)) {
      memo = memo.concat(flatten(element));
    } else {
      memo = memo.concat(element);
    }
    return memo;
  }, []);
}

function statusHandler(className, database) {
  let lastPromise = Promise.resolve();

  function create(object) {
    lastPromise = lastPromise.then(() => {
      return database.create(className, object).then(() => {
        return Promise.resolve(object);
      });
    });
    return lastPromise;
  }

  function update(where, object) {
    lastPromise = lastPromise.then(() => {
      return database.update(className, where, object);
    });
    return lastPromise;
  }

  function get(where) {
    lastPromise = lastPromise.then(() => {
      return database.find(className, {objectId: where});
    });
    return lastPromise;
  }

  function deleteEntry(where) {
    lastPromise = lastPromise.then(() => {
      return database.destroy(INSTALLATION_COLLECTION, {deviceToken: where});
    });
    return lastPromise;
  }

  return Object.freeze({
    create,
    get,
    update,
    deleteEntry
  })
}

export function jobStatusHandler(config) {
  let jobStatus;
  let objectId = newObjectId();
  let database = config.database;
  let lastPromise = Promise.resolve();
  let handler = statusHandler(JOB_STATUS_COLLECTION, database);
  let setRunning = function(jobName, params) {
    let now = new Date();
    jobStatus = {
      objectId,
      jobName,
      params,
      status: 'running',
      source: 'api',
      createdAt: now,
      // lockdown!
      ACL: {}
    }

    return handler.create(jobStatus);
  }

  let setMessage = function(message) {
    if (!message || typeof message !== 'string') {
      return Promise.resolve();
    }
    return handler.update({ objectId }, { message });
  }

  let setSucceeded = function(message) {
    return setFinalStatus('succeeded', message);
  }

  let setFailed = function(message) {
    return setFinalStatus('failed', message);
  }

  let setFinalStatus = function(status, message = undefined) {
    let finishedAt = new Date();
    let update = { status, finishedAt };
    if (message && typeof message === 'string') {
      update.message = message;
    }
    return handler.update({ objectId }, update);
  }

  return Object.freeze({
    setRunning,
    setSucceeded,
    setMessage,
    setFailed
  });
}

export function pushStatusHandler(body, config) {

  let pushStatus;
  let objectId = newObjectId();
  let database = config.database;
  let handler = statusHandler(PUSH_STATUS_COLLECTION, database);

  let data =  body.data || {};
  let pushHash;
  if (typeof data.alert === 'string') {
    pushHash = md5Hash(data.alert);
  } else if (typeof data.alert === 'object') {
    pushHash = md5Hash(JSON.stringify(data.alert));
  } else {
    pushHash = 'd41d8cd98f00b204e9800998ecf8427e';
  }

  let setInitial = function(where, options = {source: 'rest'}) {
    let now = new Date();
    let payloadString = JSON.stringify(data);
    let object = {
      objectId,
      createdAt: now,
      pushTime: now.toISOString(),
      query: JSON.stringify(where),
      payload: payloadString,
      source: options.source,
      title: options.title,
      expiry: body.expiration_time,
      failedPerType: {},
      sentPerType: {},
      status: "pending",
      numSent: 0,
      numOpened: 0,
      numFailed: 0,
      pushHash,
      // lockdown!
      ACL: {}
    }

    return handler.create(object).then(() => {
      pushStatus = {
        objectId
      };
      return Promise.resolve(pushStatus);
    });
  }

  let setRunning = function(installations) {
    logger.verbose('sending push to %d installations', installations.length);
     return handler.update({status:"pending", objectId: objectId},
        {status: "running", updatedAt: new Date() });
  }

  let complete = function(results) {
    return handler.get(objectId).then((object) => {
      let update = {
        status: 'succeeded',
        updatedAt: new Date(),
        numSent: object[0].numSent,
        numFailed: object[0].numFailed,
        failedPerType: object[0].failedPerType,
        sentPerType: object[0].sentPerType
      };
      if (Array.isArray(results)) {
        results = flatten(results);
        results.reduce((memo, result) => {
          // Cannot handle that
          if (!result || !result.device || !result.device.deviceType) {
            return memo;
          }

          if(result.response && result.response.registration_id && result.device.deviceToken) {
            handler.deleteEntry(result.device.deviceToken);
          }

          let deviceType = result.device.deviceType;
          if (result.transmitted)
          {
            memo.numSent++;
            memo.sentPerType = memo.sentPerType || {};
            memo.sentPerType[deviceType] = memo.sentPerType[deviceType] || 0;
            memo.sentPerType[deviceType]++;
          } else {
            memo.numFailed++;
            memo.failedPerType = memo.failedPerType || {};
            memo.failedPerType[deviceType] = memo.failedPerType[deviceType] || 0;
            memo.failedPerType[deviceType]++;
          }
          return memo;
        }, update);
      }
      logger.verbose('sent push! %d success, %d failures', update.numSent, update.numFailed);
      return handler.update({ objectId }, update);
    });
  }

  let fail = function(err) {
    let update = {
      errorMessage: JSON.stringify(err),
      status: 'failed',
      updatedAt: new Date()
    }
    logger.info('warning: error while sending push', err);
    return handler.update({ objectId }, update);
  }

  return Object.freeze({
    objectId,
    setInitial,
    pushHash,
    setRunning,
    complete,
    fail
  })
}
