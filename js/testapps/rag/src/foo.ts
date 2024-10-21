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
