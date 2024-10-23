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
import { Genkit } from 'genkit';
import { logger } from 'genkit/logging';
import { OllamaPluginParams } from './index.js';

interface OllamaEmbeddingPrediction {
  embedding: number[];
}

interface DefineOllamaEmbeddingParams {
  name: string;
  modelName: string;
  dimensions: number;
  options: OllamaPluginParams;
}

export function defineOllamaEmbedder(
  ai: Genkit,
  { name, modelName, dimensions, options }: DefineOllamaEmbeddingParams
) {
  return ai.defineEmbedder(
    {
      name,
      info: {
        label: 'Ollama Embedding - ' + modelName,
        dimensions,
        supports: {
          //  TODO: do any ollama models support other modalities?
          input: ['text'],
        },
      },
    },
    async (input) => {
      const serverAddress = options.serverAddress;
      const responses = await Promise.all(
        input.map(async (i) => {
          const requestPayload = {
            model: modelName,
            prompt: i.text,
          };
          let res: Response;
          try {
            res = await fetch(`${serverAddress}/api/embeddings`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestPayload),
            });
          } catch (e) {
            logger.error('Failed to fetch Ollama embedding');
            throw new Error(`Error fetching embedding from Ollama: ${e}`);
          }
          if (!res.ok) {
            logger.error('Failed to fetch Ollama embedding');
            throw new Error(
              `Error fetching embedding from Ollama: ${res.statusText}`
            );
          }
          const responseData = (await res.json()) as OllamaEmbeddingPrediction;
          return responseData;
        })
      );
      return {
        embeddings: responses,
      };
    }
  );
}
