/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const { randomUUID } = require('node:crypto');

// <https://github.com/pladaria/reconnecting-websocket/issues/195>
// const ReconnectingWebSocket = require('reconnecting-websocket');

const ReconnectingWebSocket = require('reconnecting-websocket');
const WebSocketAsPromised = require('websocket-as-promised');
const ms = require('ms');
const pRetry = require('p-retry');
const safeStringify = require('fast-safe-stringify');
const { WebSocket } = require('ws');

const config = require('#config');
const env = require('#config/env');
const logger = require('#helpers/logger');
const parseError = require('#helpers/parse-error');
const { encrypt } = require('#helpers/encrypt-decrypt');

// <https://github.com/partykit/partykit/tree/main/packages/partysocket>
// <https://github.com/partykit/partykit/issues/536>
// const partysocket = require('partysocket');
// partysocket.WebSocket.prototype._debug = (...args) =>
//   logger.debug('partysocket', { args });

ReconnectingWebSocket.prototype._debug = (...args) => {
  if (config.env === 'development')
    logger.debug('reconnectingwebsocket', { args });
};

function createWebSocketAsPromised(options = {}) {
  //
  // <https://github.com/websockets/ws/issues/2050>
  // <https://github.com/vitalets/websocket-as-promised>
  // <https://github.com/pladaria/reconnecting-websocket>
  // <https://github.com/websockets/ws/issues/1818>
  // <https://github.com/pladaria/reconnecting-websocket/issues/135#issuecomment-643144398>
  // <https://github.com/partykit/partykit/issues/536>
  //
  const protocol =
    options.protocol || config.env === 'production' ? 'wss' : 'ws';
  const auth = `${encrypt(env.API_SECRETS[0])}:`;
  const host = options.host || env.SQLITE_WEBSOCKET_HOST;
  const port = options.port || env.SQLITE_WEBSOCKET_PORT;
  const url = `${protocol}://${auth}@${host}:${port}`;

  // TODO: implement round robin URL provider
  // <https://github.com/pladaria/reconnecting-websocket#update-url>
  const wsp = new WebSocketAsPromised(url, {
    createWebSocket(url) {
      // TODO: prevent duplicate RWS instances
      // <https://github.com/vitalets/websocket-as-promised/issues/6#issuecomment-1089790824>
      // return new partysocket.WebSocket(url, [], {
      return new ReconnectingWebSocket(url, [], {
        // <https://github.com/pladaria/reconnecting-websocket#available-options>
        WebSocket,
        debug: config.env === 'development'
      });
    },
    packMessage: (data) => safeStringify(data),
    unpackMessage(data) {
      if (typeof data !== 'string') return data;
      return JSON.parse(data);
    },
    attachRequestId(data, id) {
      return {
        id,
        ...data
      };
    },
    extractRequestId(data) {
      return data && data.id;
    }
    //
    // NOTE: we don't need this because ReconnectingWebSocket returns `event.data`
    //       but if we were to use ws directly then we would need to uncomment this
    //       <https://github.com/vitalets/websocket-as-promised#usage-with-ws>
    //
    // <https://github.com/partykit/partykit/issues/538>
    // extractMessageData: (event) => event
    // extractMessageData: (event) => event.data
  });

  //
  // bind event listeners
  //
  if (config.env === 'development') {
    for (const event of [
      'onOpen',
      'onSend',
      'onMessage',
      'onUnpackedMessage',
      'onResponse',
      'onClose',
      'onError'
    ]) {
      wsp[event].addListener((...args) =>
        logger[event === 'onError' ? 'error' : 'debug'](event, { args })
      );
    }
  }

  // <https://github.com/vitalets/websocket-as-promised/issues/46>
  wsp.request = async function (data) {
    try {
      // will retry by default up to 10x with exponential backoff
      if (!wsp.isOpened)
        await pRetry(() => wsp.open(), {
          onFailedAttempt(err) {
            // <https://github.com/vitalets/websocket-as-promised/issues/47>
            logger.error(err);
          }
        });

      // TODO: turn this off for prod
      // helper for debugging
      data.stack = new Error('stack').stack;

      const response = await wsp.sendRequest(data, {
        timeout: ms('1m'),
        requestId: randomUUID()
      });

      if (
        !response.id ||
        (!response.err && typeof response.data === 'undefined')
      ) {
        const err = new TypeError('Response was invalid');
        err._response = response;
        logger.fatal(err);
        throw err;
      }

      if (response.err) throw parseError(response.err);
      return response.data;
    } catch (err) {
      err.isCodeBug = true;
      throw err;
    }
  };

  // <https://github.com/vitalets/websocket-as-promised/issues/2#issuecomment-618241047>
  wsp._interval = setInterval(() => {
    if (wsp.isOpened) wsp.send('ping');
  }, 5000);

  wsp.onClose.addListener(
    () => {
      if (wsp._interval) clearInterval(wsp._interval);
    },
    { once: true }
  );

  return wsp;
}

module.exports = createWebSocketAsPromised;