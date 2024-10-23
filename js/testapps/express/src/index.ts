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

import { googleAI } from '@genkit-ai/googleai';
import { vertexAI } from '@genkit-ai/vertexai';
import express, { Request, Response } from 'express';
import { genkit, run, z } from 'genkit';
import { ollama } from 'genkitx-ollama';

const ai = genkit({
  plugins: [
    googleAI(),
    vertexAI(),
    ollama({
      models: [
        { name: 'llama2', type: 'generate' },
        { name: 'gemma', type: 'chat' },
      ],
      serverAddress: 'http://127.0.0.1:11434', // default local address
    }),
  ],
});

export const jokeFlow = ai.defineFlow(
  { name: 'jokeFlow', inputSchema: z.string(), outputSchema: z.string() },
  async (subject, streamingCallback) => {
    return await run('call-llm', async () => {
      const llmResponse = await ai.generate({
        prompt: `${subject}`,
        model: 'ollama/gemma',
        config: {
          temperature: 1,
        },
        streamingCallback,
      });

      return llmResponse.text;
    });
  }
);

const app = express();
const port = process.env.PORT || 5000;

app.get('/jokeWithFlow', async (req: Request, res: Response) => {
  const subject = req.query['subject']?.toString();
  if (!subject) {
    res.status(400).send('provide subject query param');
    return;
  }
  res.send(await jokeFlow(subject));
});

app.get('/jokeStream', async (req: Request, res: Response) => {
  const subject = req.query['subject']?.toString();
  if (!subject) {
    res.status(400).send('provide subject query param');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Transfer-Encoding': 'chunked',
  });
  await ai.generate({
    prompt: `Tell me a joke about ${subject}`,
    model: 'ollama/llama2',
    config: {
      temperature: 1,
    },
    streamingCallback: (c) => {
      console.log(c.content[0].text);
      res.write(c.content[0].text);
    },
  });

  res.end();
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
