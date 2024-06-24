# Generating content

Firebase Genkit provides an easy interface for generating content with LLMs.

## Models

Models in Firebase Genkit are libraries and abstractions that provide access to
various Google and non-Google LLMs.

Models are fully instrumented for observability and come with tooling
integrations provided by the Genkit Developer UI -- you can try any model using
the model runner.

When working with models in Genkit, you first need to configure the model you
want to work with. Model configuration is performed by the plugin system. In
this example you are configuring the Vertex AI plugin, which provides Gemini
models.

- {Go}

  ```go
  import "github.com/firebase/genkit/go/plugins/vertexai"
  ```

  ```go
  projectID := os.Getenv("GCLOUD_PROJECT")
  err := vertexai.Init(context.Background(), vertexai.Config{
    ProjectID: projectID,
    Models: []string{
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    },
  })
  ```

Note: Different plugins and models use different methods of
authentication. For example, Vertex API uses the Google Auth Library so it can
pull required credentials using Application Default Credentials.

To use models provided by the plugin, you need a reference to the specific model
and version:

- {Go}

  ```go
  gemini15pro := googleai.Model("gemini-1.5-pro")
  ```

## Supported models

Genkit provides model support through its plugin system. The following plugins
are officially supported:

| Plugin                    | Models                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| [Google Generative AI][1] | Gemini Pro, Gemini Pro Vision                                            |
| [Google Vertex AI][2]     | Gemini Pro, Gemini Pro Vision, Gemini 1.5 Flash, Gemini 1.5 Pro, Imagen2 |
| [Ollama][3]               | Many local models, including Gemma, Llama 2, Mistral, and more           |

[1]: plugins/google-genai.md
[2]: plugins/vertex-ai.md
[3]: plugins/ollama.md

See the docs for each plugin for setup and usage information.

<!-- TODO: There's also a wide variety of community supported models available
you can discover by ... -->

## How to generate content

Genkit provides a simple helper function for generating content with models.

To just call the model:

- {Go}

  ```go
  request := ai.GenerateRequest{Messages: []*ai.Message{
    {Content: []*ai.Part{ai.NewTextPart("Tell me a joke.")}},
  }}
  response, err := ai.Generate(context.Background(), gemini15pro, &request, nil)

  responseText, err := response.Text()
  fmt.Println(responseText)
  ```

You can pass options along with the model call. The options that are supported
depend on the model and its API.

- {Go}

  ```go
  request := ai.GenerateRequest{
    Messages: []*ai.Message{
      {Content: []*ai.Part{ai.NewTextPart("Tell me a joke about dogs.")}},
    },
    Config: ai.GenerationCommonConfig{
      Temperature:     1.67,
      StopSequences:   []string{"abc"},
      MaxOutputTokens: 3,
    },
  }
  ```

### Streaming responses

Genkit supports chunked streaming of model responses:

- {Go}

  To use chunked streaming, pass a callback function to `Generate()`:

  ```go
  request := ai.GenerateRequest{Messages: []*ai.Message{
    {Content: []*ai.Part{ai.NewTextPart("Tell a long story about robots and ninjas.")}},
  }}
  response, err := ai.Generate(
    context.Background(),
    gemini15pro,
    &request,
    func(ctx context.Context, grc *ai.GenerateResponseChunk) error {
      text, err := grc.Text()
      if err == nil {
        fmt.Printf("Chunk: %s\n", text)
      }
      return err
    })

  // You can also still get the full response.
  responseText, err := response.Text()
  fmt.Println(responseText)
  ```

## Multimodal input

If the model supports multimodal input, you can pass image prompts:

- {Go}

  ```go
  imageBytes, err := os.ReadFile("img.jpg")
  encodedImage := base64.StdEncoding.EncodeToString(imageBytes)

  request := ai.GenerateRequest{Messages: []*ai.Message{
    {Content: []*ai.Part{
      ai.NewTextPart("Describe the following image."),
      ai.NewMediaPart("", "data:image/jpeg;base64,"+encodedImage),
    }},
  }}
  response, err := ai.Generate(context.Background(), gemini15pro, &request, nil)
  ```

  <!-- TODO: gs:// wasn't working for me. HTTP? -->

The exact format of the image prompt (`https` URL, `gs` URL, `data` URI) is
model-dependent.

## Function calling (tools)

Genkit models provide an interface for function calling, for models that support
it.

- {Go}

  ```go
  myJoke := &ai.ToolDefinition{
    Name:        "myJoke",
    Description: "useful when you need a joke to tell",
    InputSchema: make(map[string]any),
    OutputSchema: map[string]any{
      "joke": "string",
    },
  }
  ai.DefineTool(
    myJoke,
    nil,
    func(ctx context.Context, input map[string]any) (map[string]any, error) {
      return map[string]any{"joke": "haha Just kidding no joke! got you"}, nil
    },
  )

  request := ai.GenerateRequest{
    Messages: []*ai.Message{
      {Content: []*ai.Part{ai.NewTextPart("Tell me a joke.")},
        Role: ai.RoleUser},
    },
    Tools: []*ai.ToolDefinition{myJoke},
  }
  response, err := ai.Generate(context.Background(), gemini15pro, &request, nil)
  ```

This will automatically call the tools in order to fulfill the user prompt.

<!-- TODO: returnToolRequests: true` -->

<!--

### Adding retriever context

Documents from a retriever can be passed directly to `generate` to provide
grounding context:

```javascript
const docs = await companyPolicyRetriever({ query: question });

await generate({
  model: geminiPro,
  prompt: `Answer using the available context from company policy: ${question}`,
  context: docs,
});
```

The document context is automatically appended to the content of the prompt
sent to the model.

-->

### Recording message history

Genkit models support maintaining a history of the messages sent to the model
and its responses, which you can use to build interactive experiences, such as
chatbots.

- {Go}

  In the first prompt of a session, the "history" is simply the user prompt:

  ```go
  history := []*ai.Message{
    Content: []*ai.Part{ai.NewTextPart(prompt)},
    Role:    ai.RoleUser,
  }

  request := ai.GenerateRequest{Messages: history}
  response, err := ai.Generate(context.Background(), gemini15pro, &request, nil)
  ```

  When you get a response, add it to the history:

  ```go
  history = append(history, response.Candidates[0].Message)
  ```

  You can serialize this history and persist it in a database or session storage.
  For subsequent user prompts, add them to the history before calling
  `Generate()`:

  ```go
  history = append(history, &ai.Message{
    Content: []*ai.Part{ai.NewTextPart(prompt)},
    Role:    ai.RoleUser,
  })

  request := ai.GenerateRequest{Messages: history}
  response, err := ai.Generate(context.Background(), gemini15pro, &request, nil)
  ```

If the model you're using supports the system role, you can use the initial
history to set the system message:

- {Go}

  ```go
  history := []&ai.Message{
    Content: []*ai.Part{ai.NewTextPart("Talk like a pirate.")},
    Role:    ai.RoleSystem,
  }
  ```