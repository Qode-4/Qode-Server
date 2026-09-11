import { z } from "zod";
import { traceable } from "langsmith/traceable";
import type { ProjectAnalysisSummary } from "../modules/project-analysis/project-analysis.types.js";

type OpenAiMessageRole = "system" | "user" | "assistant";

type OpenAiMessage = {
  role: OpenAiMessageRole;
  content: string;
};

const projectAnalysisSummarySchema: z.ZodType<ProjectAnalysisSummary> = z.object({
  project_overview: z.string().min(1),
  architecture: z.array(z.string()),
  core_modules: z.array(
    z.object({
      path: z.string().min(1),
      purpose: z.string().min(1),
    })
  ),
  key_flows: z.array(z.string()),
  risks: z.array(z.string()),
  recommended_next_steps: z.array(z.string()),
});

export class OpenAiClient {
  private readonly endpoint = "https://api.openai.com/v1/chat/completions";

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      timeoutMs?: number;
    }
  ) {}

  async *streamChat(messages: OpenAiMessage[]): AsyncGenerator<string> {
    const endpoint = this.endpoint;
    const { apiKey, model, timeoutMs } = this.options;

    const streamOpenAiChat = traceable(
      async function* (input: { messages: OpenAiMessage[] }): AsyncGenerator<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? 120_000);

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              stream: true,
              messages: input.messages,
            }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            const body = await response.text();
            throw new Error(`OpenAI stream request failed: ${response.status} ${body.slice(0, 500)}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";

            for (const chunk of chunks) {
              const line = chunk
                .split("\n")
                .find((item) => item.startsWith("data: "));
              if (!line) {
                continue;
              }

              const data = line.slice("data: ".length).trim();
              if (data === "[DONE]") {
                return;
              }

              let parsed: {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              try {
                parsed = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
              } catch {
                continue;
              }

              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                yield token;
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      },
      {
        name: "openai_stream_chat",
        run_type: "llm",
        metadata: {
          provider: "openai",
          model,
          streaming: true,
        },
      }
    );

    yield* streamOpenAiChat({ messages });
  }

  async generateProjectAnalysis(input: {
    projectId: string;
    sourceCommit: string | null;
    repositorySnapshot: string;
  }): Promise<ProjectAnalysisSummary> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a senior staff engineer. Analyze repository context and respond in strict JSON only.",
          },
          {
            role: "user",
            content: [
              `project_id: ${input.projectId}`,
              `source_commit: ${input.sourceCommit ?? "unknown"}`,
              "",
              "Output JSON schema:",
              "{",
              '  "project_overview": "string",',
              '  "architecture": ["string"],',
              '  "core_modules": [{"path":"string","purpose":"string"}],',
              '  "key_flows": ["string"],',
              '  "risks": ["string"],',
              '  "recommended_next_steps": ["string"]',
              "}",
              "",
              "Repository context:",
              input.repositorySnapshot,
            ].join("\n"),
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI analysis request failed: ${response.status} ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI analysis response is empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("OpenAI analysis response is not valid JSON");
    }

    return projectAnalysisSummarySchema.parse(parsed);
  }

  async generateChatTitle(input: {
    userContent: string;
    assistantContent: string;
  }): Promise<string> {
    const endpoint = this.endpoint;
    const { apiKey, model } = this.options;

    const run = traceable(
      async (payload: { userContent: string; assistantContent: string }): Promise<string> => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            messages: [
              {
                role: "system",
                content:
                  "너는 한국어 대화를 짧고 명료한 title로 요약한다. 아래 대화를 20자 이내의 명사구 title로 요약해라. 따옴표, 마침표, 이모지, 접두어 없이 결과만 출력.",
              },
              {
                role: "user",
                content: [
                  "유저:",
                  payload.userContent.slice(0, 500),
                  "",
                  "어시스턴트:",
                  payload.assistantContent.slice(0, 500),
                ].join("\n"),
              },
            ],
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `OpenAI title request failed: ${response.status} ${body.slice(0, 500)}`
          );
        }

        const parsed = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = parsed.choices?.[0]?.message?.content?.trim();
        if (!content) {
          throw new Error("OpenAI title response is empty");
        }

        return content.slice(0, 20);
      },
      {
        name: "generate_chat_title",
        run_type: "llm",
        metadata: {
          provider: "openai",
          model,
        },
      }
    );

    return run(input);
  }
}
