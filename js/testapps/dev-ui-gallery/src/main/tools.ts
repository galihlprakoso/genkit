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

import { gemini15Flash } from '@genkit-ai/googleai';
import { z } from 'genkit';
import { WeatherSchema } from '../common/types';
import { ai } from '../genkit.js';

ai.defineTool(
  {
    name: 'getWeather',
    description: 'Get the weather for the given location.',
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({
      temperatureF: z.number(),
      conditions: z.string(),
    }),
  },
  async () => {
    const conditions = ['Sunny', 'Cloudy', 'Partially Cloudy', 'Raining'];
    const c = Math.floor(Math.random() * conditions.length);
    const temp = Math.floor(Math.random() * (120 - 32) + 32);

    return {
      temperatureF: temp,
      conditions: conditions[c],
    };
  }
);

ai.defineTool(
  {
    name: 'getTime',
    description: 'Get the current time',
    inputSchema: z.object({ timezone: z.string().optional() }),
    outputSchema: z.object({ time: z.number() }),
  },
  async () => {
    return { time: Date.now() };
  }
);

const template = `
  {{role "system"}}
  Always try to be as efficient as possible, and request tool calls in batches.

  {{role "user"}}
  Help me decide which is a better place to visit today based on the weather.
  I want to be outside as much as possible. Here are the cities I am
  considering:\n\n{{#each cities}}{{this}}\n{{/each}}`;

export const weatherPrompt = ai.definePrompt(
  {
    name: 'weatherPrompt',
    model: gemini15Flash,
    input: {
      schema: WeatherSchema,
      default: {
        persona: 'Space Pirate',
      },
    },
    output: {
      format: 'text',
    },
    config: {
      maxOutputTokens: 2048,
      temperature: 0.6,
      topK: 16,
      topP: 0.95,
    },
    tools: ['getWeather'],
  },
  template
);

ai.defineFlow(
  {
    name: 'flowWeather',
    inputSchema: WeatherSchema,
    outputSchema: z.string(),
  },
  async (input) => {
    const { text } = await weatherPrompt(input);
    return text;
  }
);
