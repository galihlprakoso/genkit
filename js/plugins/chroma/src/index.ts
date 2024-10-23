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

import {
  ChromaClient,
  Collection,
  CollectionMetadata,
  IEmbeddingFunction,
  IncludeEnum,
  Metadata,
  ChromaClientParams as NativeChromaClientParams,
  Where,
  WhereDocument,
} from 'chromadb';
import {
  Document,
  EmbedderArgument,
  Genkit,
  indexerRef,
  retrieverRef,
  z,
} from 'genkit';
import { GenkitPlugin, genkitPlugin } from 'genkit/plugin';
import { CommonRetrieverOptionsSchema } from 'genkit/retriever';
import { Md5 } from 'ts-md5';

export { IncludeEnum };

const WhereSchema: z.ZodType<Where> = z.any();
const WhereDocumentSchema: z.ZodType<WhereDocument> = z.any();

const ChromaRetrieverOptionsSchema = CommonRetrieverOptionsSchema.extend({
  include: z.array(z.nativeEnum(IncludeEnum)).optional(),
  where: WhereSchema.optional(),
  whereDocument: WhereDocumentSchema.optional(),
});

export const ChromaIndexerOptionsSchema = z.null().optional();

type ChromaClientParams =
  | NativeChromaClientParams
  | (() => Promise<NativeChromaClientParams>);

type ChromaPluginParams<
  EmbedderCustomOptions extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  clientParams?: ChromaClientParams;
  collectionName: string;
  createCollectionIfMissing?: boolean;
  embedder: EmbedderArgument<EmbedderCustomOptions>;
  embedderOptions?: z.infer<EmbedderCustomOptions>;
}[];

/**
 * Chroma plugin that provides the Chroma retriever and indexer
 */
export function chroma<EmbedderCustomOptions extends z.ZodTypeAny>(
  params: ChromaPluginParams<EmbedderCustomOptions>
): GenkitPlugin {
  return genkitPlugin('chroma', async (ai: Genkit) => {
    params.map((i) => chromaRetriever(ai, i));
    params.map((i) => chromaIndexer(ai, i));
  });
}

export const chromaRetrieverRef = (params: {
  collectionName: string;
  displayName?: string;
}) => {
  return retrieverRef({
    name: `chroma/${params.collectionName}`,
    info: {
      label: params.displayName ?? `Chroma DB - ${params.collectionName}`,
    },
    configSchema: ChromaRetrieverOptionsSchema.optional(),
  });
};

export const chromaIndexerRef = (params: {
  collectionName: string;
  displayName?: string;
}) => {
  return indexerRef({
    name: `chroma/${params.collectionName}`,
    info: {
      label: params.displayName ?? `Chroma DB - ${params.collectionName}`,
    },
    configSchema: ChromaIndexerOptionsSchema.optional(),
  });
};

/**
 * Configures a Chroma vector store retriever.
 */
export function chromaRetriever<EmbedderCustomOptions extends z.ZodTypeAny>(
  ai: Genkit,
  params: {
    clientParams?: ChromaClientParams;
    collectionName: string;
    createCollectionIfMissing?: boolean;
    embedder: EmbedderArgument<EmbedderCustomOptions>;
    embedderOptions?: z.infer<EmbedderCustomOptions>;
  }
) {
  const { embedder, collectionName, embedderOptions } = params;
  return ai.defineRetriever(
    {
      name: `chroma/${collectionName}`,
      configSchema: ChromaRetrieverOptionsSchema.optional(),
    },
    async (content, options) => {
      const clientParams = await resolve(params.clientParams);
      const client = new ChromaClient(clientParams);
      let collection: Collection;
      if (params.createCollectionIfMissing) {
        collection = await client.getOrCreateCollection({
          name: collectionName,
        });
      } else {
        collection = await client.getCollection({
          name: collectionName,
        });
      }

      const embedding = await ai.embed({
        embedder,
        content,
        options: embedderOptions,
      });
      const results = await collection.query({
        nResults: options?.k,
        include: options?.include,
        where: options?.where,
        whereDocument: options?.whereDocument,
        queryEmbeddings: embedding,
      });

      const documents = results.documents[0];
      const metadatas = results.metadatas[0];

      const combined = documents
        .map((d, i) => {
          if (d !== null) {
            return {
              document: d,
              metadata: metadatas[i] ?? undefined,
            };
          }
          return undefined;
        })
        .filter(
          (r): r is { document: string; metadata: Record<string, any> } => !!r
        );

      return {
        documents: combined.map((result) =>
          Document.fromText(result.document, result.metadata).toJSON()
        ),
      };
    }
  );
}

/**
 * Configures a Chroma indexer.
 */
export function chromaIndexer<EmbedderCustomOptions extends z.ZodTypeAny>(
  ai: Genkit,
  params: {
    clientParams?: ChromaClientParams;
    collectionName: string;
    createCollectionIfMissing?: boolean;
    embedder: EmbedderArgument<EmbedderCustomOptions>;
    embedderOptions?: z.infer<EmbedderCustomOptions>;
  }
) {
  const { collectionName, embedder, embedderOptions } = {
    ...params,
  };

  return ai.defineIndexer(
    {
      name: `chroma/${params.collectionName}`,
      configSchema: ChromaIndexerOptionsSchema,
    },
    async (docs) => {
      const clientParams = await resolve(params.clientParams);
      const client = new ChromaClient(clientParams);

      let collection: Collection;
      if (params.createCollectionIfMissing) {
        collection = await client.getOrCreateCollection({
          name: collectionName,
        });
      } else {
        collection = await client.getCollection({
          name: collectionName,
        });
      }

      const embeddings = await Promise.all(
        docs.map((doc) =>
          ai.embed({
            embedder,
            content: doc,
            options: embedderOptions,
          })
        )
      );

      const entries = embeddings.map((value, i) => {
        const metadata: Metadata = {
          ...docs[i].metadata,
        };

        const id = Md5.hashStr(JSON.stringify(docs[i]));
        return {
          id,
          value,
          document: docs[i].text,
          metadata,
        };
      });
      await collection.add({
        ids: entries.map((e) => e.id),
        embeddings: entries.map((e) => e.value),
        metadatas: entries.map((e) => e.metadata),
        documents: entries.map((e) => e.document),
      });
    }
  );
}

/**
 * Helper function for creating Chroma collections.
 */
export async function createChromaCollection<
  EmbedderCustomOptions extends z.ZodTypeAny,
>(
  ai: Genkit,
  params: {
    name: string;
    clientParams?: ChromaClientParams;
    metadata?: CollectionMetadata;
    embedder?: EmbedderArgument<EmbedderCustomOptions>;
    embedderOptions?: z.infer<EmbedderCustomOptions>;
  }
) {
  let chromaEmbedder: IEmbeddingFunction | undefined = undefined;
  const embedder = params.embedder;
  if (!!embedder) {
    chromaEmbedder = {
      generate(texts: string[]) {
        return Promise.all(
          texts.map((text) =>
            ai.embed({
              embedder,
              content: text,
              options: params.embedderOptions,
            })
          )
        );
      },
    };
  }
  const clientParams = await resolve(params.clientParams);
  const client = new ChromaClient(clientParams);
  return await client.createCollection({
    ...params,
    embeddingFunction: chromaEmbedder,
  });
}

/**
 * Helper function for deleting Chroma collections.
 */
export async function deleteChromaCollection(params: {
  name: string;
  clientParams?: ChromaClientParams;
}) {
  const clientParams = await resolve(params.clientParams);
  const client = new ChromaClient(clientParams);
  return await client.deleteCollection({
    ...params,
  });
}

async function resolve(
  params?: ChromaClientParams
): Promise<NativeChromaClientParams | undefined> {
  if (!params) {
    return undefined;
  }
  if (typeof params === 'function') {
    return await params();
  }
  return params;
}
