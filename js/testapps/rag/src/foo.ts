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

import { streamFlow } from 'genkit/client';

(async () => {
  const response = await streamFlow({
    url: 'http://localhost:3400/throwy',
    input: 'foo',
  });
  for await (const chunk of response.stream()) {
    console.log(chunk);
  }
  console.log(await response.output());
})();
