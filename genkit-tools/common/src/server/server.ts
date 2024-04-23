/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as trpcExpress from '@trpc/server/adapters/express';
import * as bodyParser from 'body-parser';
import * as clc from 'colorette';
import express, { ErrorRequestHandler } from 'express';
import open from 'open';
import path from 'path';
import { Runner } from '../runner/runner';
import { logger } from '../utils/logger';
import { TOOLS_SERVER_ROUTER } from './router';

// Static files are copied to the /dist/client directory. This is a litle
// brittle as __dirname refers directly to this particular file.
const UI_STATIC_FILES_DIR = path.resolve(
  __dirname,
  '../../../../ui/dist/ui/browser'
);
const API_BASE_PATH = '/api';

/**
 * Starts up the Genkit Tools server which includes static files for the UI and the Tools API.
 */
export function startServer(
  runner: Runner,
  headless: boolean,
  port: number
): Promise<void> {
  let serverEnder: (() => void) | undefined = undefined;
  const enderPromise = new Promise<void>((resolver) => {
    serverEnder = resolver;
  });

  const app = express();

  if (!headless) {
    app.use(express.static(UI_STATIC_FILES_DIR));
  }

  // tRPC doesn't support simple streaming mutations (https://github.com/trpc/trpc/issues/4477).
  // Don't want a separate WebSocket server for subscriptions - https://trpc.io/docs/subscriptions.
  // TODO: migrate to streamingMutation when it becomes available in tRPC.
  app.options('/api/streamAction', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(200).send('');
  });

  app.post('/api/streamAction', bodyParser.json(), async (req, res) => {
    const { key, input } = req.body;
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });

    const result = await runner.runAction({ key, input }, (chunk) => {
      res.write(JSON.stringify(chunk) + '\n');
    });
    res.write(JSON.stringify(result));
    res.end();
  });

  // Endpoints for CLI control
  app.use(
    API_BASE_PATH,
    (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') res.send('');
      else next();
    },
    trpcExpress.createExpressMiddleware({
      router: TOOLS_SERVER_ROUTER(runner),
    })
  );

  const errorHandler: ErrorRequestHandler = (
    error,
    request,
    response,
    // Poor API doesn't allow leaving off `next` without changing the entire signature...
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next
  ) => {
    if (error instanceof Error) {
      logger.error(error.stack);
    }
    return response.status(500).send(error);
  };
  app.use(errorHandler);

  // serve angular paths
  app.all('*', (req, res) => {
    res.status(200).sendFile('/', { root: UI_STATIC_FILES_DIR });
  });

  app.listen(port, () => {
    logger.info(
      `${clc.green(clc.bold('Genkit Tools API:'))} http://localhost:${port}/api`
    );
    if (!headless) {
      const uiUrl = 'http://localhost:' + port;
      runner
        .waitUntilHealthy()
        .then(() => {
          logger.info(`${clc.green(clc.bold('Genkit Tools UI:'))} ${uiUrl}`);
          open(uiUrl);
        })
        .catch((e) => {
          logger.error(e.message);
          if (serverEnder) serverEnder();
        });
    }
  });

  return enderPromise;
}