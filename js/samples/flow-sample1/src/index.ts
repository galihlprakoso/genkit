import { initializeGenkit } from '@genkit-ai/common/config';
import { flow, run, runFlow, runMap } from '@genkit-ai/flow';
import {
  durableFlow,
  interrupt,
  scheduleFlow,
  sleep,
  waitFor,
} from '@genkit-ai/flow/experimental';
import * as z from 'zod';
import config from './genkit.conf';

initializeGenkit(config);

/**
 * To run this flow;
 *   genkit flow:run basic "\"hello\""
 */
export const basic = flow(
  { name: 'basic', input: z.string(), output: z.string() },
  async (subject) => {
    const foo = await run('call-llm', async () => {
      return `subject: ${subject}`;
    });
    if (subject) {
      throw new Error('boo');
    }
    return await run('call-llm', async () => {
      return `foo: ${foo}`;
    });
  }
);

export const parent = flow(
  { name: 'parent', input: z.void(), output: z.string() },
  async () => {
    return JSON.stringify(await runFlow(basic, 'foo'));
  }
);

/**
 * To run this flow;
 *   genkit flow:run simpleFanout
 */
export const simpleFanout = flow(
  { name: 'simpleFanout', input: z.void(), output: z.string() },
  async () => {
    const fanValues = await run('fan-generator', async () => {
      return ['a', 'b', 'c', 'd'];
    });
    const remapped = await runMap('remap', fanValues, async (f) => {
      return 'foo-' + f;
    });

    return remapped.join(', ');
  }
);

/**
 * To run this flow;
 *   genkit flow:run kitchensink "\"hello\""
 *   genkit flow:resume kitchensink FLOW_ID "\"foo\""
 *   genkit flow:resume kitchensink FLOW_ID "\"bar\""
 *   genkit flow:resume kitchensink FLOW_ID "\"baz\""
 *   genkit flow:resume kitchensink FLOW_ID "\"aux\""
 *   genkit flow:resume kitchensink FLOW_ID "\"final\""
 */
export const kitchensink = durableFlow(
  {
    name: 'kitchensink',
    input: z.string(),
    output: z.string(),
  },
  async (i) => {
    const hello = await run('say-hello', async () => {
      return 'hello';
    });
    let fan = await run('fan-generator', async () => {
      return ['a', 'b', 'c', 'd'];
    });
    fan = await Promise.all(
      fan.map((f) =>
        run('remap', async () => {
          return 'z-' + f;
        })
      )
    );

    const fanResult: string[] = [];
    for (const foo of fan) {
      fanResult.push(
        await interrupt('fan', z.string(), async (input) => {
          return 'fanned-' + foo + '-' + input;
        })
      );
    }

    const something = await interrupt(
      'wait-for-human-input',
      z.string(),
      async (input) => {
        return (
          i +
          ' was the input, then ' +
          hello +
          ', then ' +
          fanResult.join(', ') +
          ', human said: ' +
          input
        );
      }
    );

    return something;
  }
);

/**
 * To run this flow;
 *   genkit flow:run sleepy
 */
export const sleepy = durableFlow(
  {
    name: 'sleepy',
    input: z.void(),
    output: z.string(),
  },
  async () => {
    const before = await run('before', async () => {
      return 'foo';
    });

    await sleep('take-a-nap', 10);

    const after = await run('after', async () => {
      return 'bar';
    });

    return `${before} ${after}`;
  }
);

/**
 * To run this flow;
 *   genkit flow:run waity
 */
export const waity = durableFlow(
  {
    name: 'waity',
    input: z.void(),
    output: z.string(),
  },
  async () => {
    const flowOp = await run('start-sub-flow', async () => {
      return await scheduleFlow(sleepy, undefined);
    });

    const [op] = await waitFor('wait-for-other-to-complete', sleepy, [
      flowOp.name,
    ]);

    return await run('after', async () => {
      return `unpack sleepy result: ${JSON.stringify(op.result)}`;
    });
  }
);

// genkit flow:run streamy 5 -s
export const streamy = flow(
  {
    name: 'streamy',
    input: z.number(),
    output: z.string(),
    streamType: z.object({ count: z.number() }),
  },
  async (count, streamingCallback) => {
    var i = 0;
    if (streamingCallback) {
      for (; i < count; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        streamingCallback({ count: i });
      }
    }
    return `done: ${count}, streamed: ${i} times`;
  }
);

// genkit flow:run streamy 5 -s
export const streamyThrowy = flow(
  {
    name: 'streamyThrowy',
    input: z.number(),
    output: z.string(),
    streamType: z.object({ count: z.number() }),
  },
  async (count, streamingCallback) => {
    var i = 0;
    if (streamingCallback) {
      for (; i < count; i++) {
        if (i == 3) {
          throw new Error('whoops');
        }
        await new Promise((r) => setTimeout(r, 1000));
        streamingCallback({ count: i });
      }
    }
    return `done: ${count}, streamed: ${i} times`;
  }
);